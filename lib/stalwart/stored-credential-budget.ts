import { createHash } from 'node:crypto';
import { getStore, isSharedMode } from '@/lib/shared-store';
import { logger } from '@/lib/logger';

/**
 * Failure budget for the credentials the context cookies hold (extends
 * GHSA-g6c7).
 *
 * The cookie-authed routes (JMAP passthrough, WebDAV, calendar agenda, push
 * previews, WOPI, ...) replay the stored credential to the mail server on
 * every call. Once it is stale (password changed, app password revoked) each
 * call is a failed login from this server's address, and enough of them get
 * the webmail banned by Stalwart's fail2ban, locking out every user. So:
 *
 *  - a credential the mail server refused is refused here for an hour,
 *    without asking the server again;
 *  - past GLOBAL_MAX_FAILURES refusals in a window (several stale app
 *    passwords would each get their own hour), only credentials that worked
 *    within the window still go upstream until the window ends.
 *
 * Only Basic credentials count: Stalwart does not count an expired or unknown
 * access token as a failed login, and access tokens expire all the time.
 *
 * With a shared store (#1066) refusals and the failure window are kept there,
 * so a credential one replica saw refused isn't tried again by the others.
 * Successes are remembered in this process and written to the store at most
 * once a minute per credential: this check runs on every server-side JMAP
 * call. If the store can't be reached, this process's own copy decides, as a
 * single instance does; refusing every call would take files, push previews
 * and calendar sync down with the store.
 */

const REFUSE_MS = 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_MAX_FAILURES = 20;
const MAX_TRACKED = 10_000;
/** How often one process writes a credential's success to the shared store. */
const SHARED_SUCCESS_EVERY_MS = 60 * 1000;
/** Shared keys outlive their window a little, so clock skew can't drop them early. */
const SHARED_GRACE_MS = 60 * 1000;
const FAILURES_KEY = 'stored-credential:failures';

interface BudgetState {
  /** Credential key -> time until which it is refused. */
  refused: Map<string, number>;
  /** Credential key -> time it last got a successful answer. */
  succeeded: Map<string, number>;
  failureWindow: { failures: number; resetAt: number };
  /** Credential key -> when this process last wrote its success to the shared store. */
  sharedSuccess: Map<string, number>;
}

// On globalThis: one copy per process, not one per bundle.
const STATE_KEY = Symbol.for('bulwark.storedCredentialBudget');

function state(): BudgetState {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: BudgetState };
  g[STATE_KEY] ??= { refused: new Map(), succeeded: new Map(), failureWindow: { failures: 0, resetAt: 0 }, sharedSuccess: new Map() };
  return g[STATE_KEY];
}

function keyOf(authHeader: string): string | null {
  if (!/^basic /i.test(authHeader)) return null;
  return createHash('sha256').update(authHeader).digest('base64url');
}

const refusedKey = (key: string) => `stored-credential:refused:${key}`;
const succeededKey = (key: string) => `stored-credential:ok:${key}`;

function currentWindow(now: number) {
  const s = state();
  if (s.failureWindow.resetAt <= now) s.failureWindow = { failures: 0, resetAt: now + WINDOW_MS };
  return s.failureWindow;
}

function remember(map: Map<string, number>, key: string, value: number): void {
  map.delete(key);
  // Insertion order is age order: drop the oldest when full.
  if (map.size >= MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

// ─── this process ──────────────────────────────────────────────────────────

function isRefusedLocally(key: string, now: number): boolean {
  const { refused, succeeded } = state();
  const until = refused.get(key);
  if (until !== undefined) {
    if (until > now) return true;
    refused.delete(key);
  }
  if (currentWindow(now).failures < GLOBAL_MAX_FAILURES) return false;
  const lastSuccess = succeeded.get(key);
  return lastSuccess === undefined || now - lastSuccess > WINDOW_MS;
}

function recordLocally(key: string, status: number, now: number): void {
  const { refused, succeeded } = state();
  if (status === 401) {
    succeeded.delete(key);
    remember(refused, key, now + REFUSE_MS);
    currentWindow(now).failures++;
  } else if (status >= 200 && status < 400) {
    refused.delete(key);
    remember(succeeded, key, now);
  }
}

// ─── shared store ──────────────────────────────────────────────────────────

function isUnavailable(error: unknown): boolean {
  return error instanceof Error && error.name === 'StoreUnavailableError';
}

async function isRefusedShared(key: string, now: number): Promise<boolean> {
  const store = getStore();
  const [until, window] = await Promise.all([store.kv.get(refusedKey(key)), store.counters.get(FAILURES_KEY, now)]);
  const refusedUntil = Number(until);
  if (until !== null && refusedUntil > now) {
    // Kept here too, for when the store is down.
    remember(state().refused, key, refusedUntil);
    return true;
  }
  if ((window?.count ?? 0) < GLOBAL_MAX_FAILURES) return false;
  const local = state().succeeded.get(key);
  if (local !== undefined && now - local <= WINDOW_MS) return false;
  const shared = Number(await store.kv.get(succeededKey(key)));
  return !(shared > 0 && now - shared <= WINDOW_MS);
}

async function recordShared(key: string, status: number, now: number, wasRefusedHere: boolean): Promise<void> {
  const store = getStore();
  const { sharedSuccess } = state();
  if (status === 401) {
    sharedSuccess.delete(key);
    await Promise.all([
      store.kv.set(refusedKey(key), String(now + REFUSE_MS), { ttlMs: REFUSE_MS + SHARED_GRACE_MS }),
      store.kv.del(succeededKey(key)),
      store.counters.hit(FAILURES_KEY, WINDOW_MS, now),
    ]);
  } else if (status >= 200 && status < 400) {
    const last = sharedSuccess.get(key);
    // A success that lifts a refusal is written at once; otherwise once a minute.
    if (!wasRefusedHere && last !== undefined && now - last >= 0 && now - last < SHARED_SUCCESS_EVERY_MS) return;
    remember(sharedSuccess, key, now);
    await Promise.all([
      store.kv.del(refusedKey(key)),
      store.kv.set(succeededKey(key), String(now), { ttlMs: WINDOW_MS + SHARED_GRACE_MS }),
    ]);
  }
}

// ─── API ───────────────────────────────────────────────────────────────────

/** True when `authHeader` must not be sent to the mail server right now. */
export async function isStoredCredentialRefused(authHeader: string, now: number = Date.now()): Promise<boolean> {
  const key = keyOf(authHeader);
  if (!key) return false;
  if (!isSharedMode()) return isRefusedLocally(key, now);
  try {
    return await isRefusedShared(key, now);
  } catch (error) {
    if (!isUnavailable(error)) throw error;
    return isRefusedLocally(key, now);
  }
}

/** Record the mail server's answer to a request that carried `authHeader`. */
export async function recordStoredCredentialStatus(authHeader: string, status: number, now: number = Date.now()): Promise<void> {
  const key = keyOf(authHeader);
  if (!key) return;
  const wasRefusedHere = state().refused.has(key);
  // Always kept here: it is what decides while the shared store is down.
  recordLocally(key, status, now);
  if (!isSharedMode()) return;
  try {
    await recordShared(key, status, now, wasRefusedHere);
  } catch (error) {
    if (!isUnavailable(error)) throw error;
    logger.debug('Stored credential status kept in this process only: the shared store is unavailable');
  }
}

/** The answer a refused credential gets instead of an upstream request. */
export function refusedCredentialResponse(): Response {
  return Response.json({ error: 'Authentication failed', reason: 'credential_refused' }, { status: 401 });
}

export function resetStoredCredentialBudgetForTests(): void {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: BudgetState };
  delete g[STATE_KEY];
}
