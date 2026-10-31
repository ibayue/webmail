import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { RedeemBundle } from '@/lib/auth/pair-bundle';
import { isMobileCodeChallenge } from '@/lib/auth/mobile-handoff';
import { createFailureBudget, type BudgetRefund } from '@/lib/auth/verify-budget';

// One-time codes for the browser sign-in hand-off to the mobile app
// (lib/auth/mobile-handoff.ts, bulwarkmail.org/docs/development/mobile-handoff). The app opens the
// login page with a PKCE `mobile_code_challenge`; once the user has signed in
// and confirmed, the sign-in (an OAuth bundle, or username + password) is
// parked here and the browser opens the app's callback link with nothing but
// a random code. The app redeems that code at /api/auth/handoff/redeem with
// the verifier behind its challenge. A custom-scheme link can be caught by
// another app on the device; the code alone is worthless to it.
//
// A code can be redeemed for 60 seconds from the moment the user confirms,
// and only once. Any redeem attempt spends it, including one with the wrong
// verifier, so a code that leaked cannot be tried twice.
//
// The password flow parks on confirmation (the page holds the password), so
// its code is live at once. The SSO flow parks in /api/auth/sso/complete,
// before the user has seen the confirmation: that code waits, unusable, for
// up to five minutes until the page confirms it (/api/auth/handoff/confirm),
// and its 60 seconds start then.
//
// Spent and expired records stay a while without their sign-in, so a late
// redeem is told "expired" rather than "invalid".
//
// Storage is an in-process Map pinned on globalThis, like the pairing store
// (lib/auth/pairing-store.ts), with the same single-instance assumption.

export const HANDOFF_TTL_MS = 60 * 1000;
/** How long an SSO sign-in waits for the user to confirm the hand-off. */
export const HANDOFF_CONFIRM_TTL_MS = 5 * 60 * 1000;
const TOMBSTONE_MS = 10 * 60 * 1000;
const CODE_BYTES = 32; // 256 bits
/** Records at most; the oldest gives way when a new one comes in. */
const MAX_RECORDS = 2000;

/** RFC 7636 §4.1: 43 to 128 unreserved characters. */
const CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_RE = /^[0-9a-f]{64}$/;

export const isHandoffCodeChallenge = isMobileCodeChallenge;

export function isHandoffCodeVerifier(value: unknown): value is string {
  return typeof value === 'string' && CODE_VERIFIER_RE.test(value);
}

export function isHandoffCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_RE.test(value);
}

interface HandoffRecord {
  /** Null once redeemed (or tried) or expired. */
  bundle: RedeemBundle | null;
  state: string;
  challenge: string;
  /** Whether the user confirmed the hand-off; only confirmed codes redeem. */
  confirmed: boolean;
  issuedAt: number;
  expiresAt: number;
  forgetAt: number;
}

export type HandoffRedeemResult =
  | { ok: true; bundle: RedeemBundle; state: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'verifier_mismatch' };

const STORE_KEY = '__bulwarkMobileHandoffStore';

function store(): Map<string, HandoffRecord> {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: Map<string, HandoffRecord> };
  if (!g[STORE_KEY]) g[STORE_KEY] = new Map();
  return g[STORE_KEY];
}

// Wipe sign-ins past their expiry and forget tombstones past theirs. Called
// on every operation, so memory stays bounded without a timer.
function sweep(now: number): void {
  const codes = store();
  for (const [code, record] of codes) {
    if (record.expiresAt <= now) record.bundle = null;
    if (record.forgetAt <= now) codes.delete(code);
  }
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * Park a sign-in for the app; returns the code the browser hands over. With
 * `awaitConfirm` the code only becomes redeemable through confirmHandoff.
 */
export function stashHandoff(
  bundle: RedeemBundle,
  options: { challenge: string; state: string; awaitConfirm?: boolean },
  now = Date.now(),
): string {
  sweep(now);
  const codes = store();
  // Map keeps insertion order, so the first key is the oldest.
  while (codes.size >= MAX_RECORDS) {
    const oldest = codes.keys().next().value;
    if (oldest === undefined) break;
    codes.delete(oldest);
  }
  const code = randomBytes(CODE_BYTES).toString('hex');
  const expiresAt = now + (options.awaitConfirm ? HANDOFF_CONFIRM_TTL_MS : HANDOFF_TTL_MS);
  codes.set(code, {
    bundle,
    state: options.state,
    challenge: options.challenge,
    confirmed: !options.awaitConfirm,
    issuedAt: now,
    expiresAt,
    forgetAt: expiresAt + TOMBSTONE_MS,
  });
  return code;
}

/**
 * The user confirmed the hand-off of a code parked with `awaitConfirm`: it
 * can be redeemed for the next 60 seconds. False when there is nothing (left)
 * to confirm.
 */
export function confirmHandoff(code: string, now = Date.now()): boolean {
  sweep(now);
  const record = store().get(code);
  if (!record || !record.bundle || record.confirmed) return false;
  record.confirmed = true;
  record.expiresAt = now + HANDOFF_TTL_MS;
  record.forgetAt = record.expiresAt + TOMBSTONE_MS;
  return true;
}

/**
 * Hand out the sign-in behind `code` when `verifier` matches its challenge.
 * The code is spent by the attempt, whatever its outcome. `expires_in` of an
 * OAuth bundle counts down from when it was parked.
 */
export function redeemHandoff(code: string, verifier: string, now = Date.now()): HandoffRedeemResult {
  sweep(now);
  const record = store().get(code);
  if (!record) return { ok: false, reason: 'invalid' };
  const bundle = record.bundle;
  record.bundle = null;
  if (!bundle) return { ok: false, reason: record.expiresAt <= now ? 'expired' : 'invalid' };
  if (!record.confirmed) return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(record.challenge, 'ascii');
  const actual = Buffer.from(s256(verifier), 'ascii');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'verifier_mismatch' };
  }
  if (bundle.flow === 'oauth' && typeof bundle.expires_in === 'number') {
    const elapsed = Math.floor((now - record.issuedAt) / 1000);
    return { ok: true, bundle: { ...bundle, expires_in: Math.max(0, bundle.expires_in - elapsed) }, state: record.state };
  }
  return { ok: true, bundle, state: record.state };
}

/** Test hook: forget everything. */
export function resetHandoffStoreForTests(): void {
  store().clear();
}

// Per-client limits on the routes. Codes carry 256 bits and die on the first
// attempt, so guessing is hopeless either way; these keep one client from
// filling the store or hammering the redeem route.
const createBudget = createFailureBudget({ name: 'handoff-create', clientMax: 10, globalMax: Infinity });
const redeemBudget = createFailureBudget({ name: 'handoff-redeem', clientMax: 10, globalMax: Infinity });

/** Count one parked sign-in for `client`; false when it is over its limit. */
export async function reserveHandoffCreate(client: string, now = Date.now()): Promise<boolean> {
  return (await createBudget.reserve(client, now)) !== null;
}

/**
 * Reserve one redeem attempt for `client`: null when it is over its limit,
 * otherwise a refund to call when the redeem succeeded (only failures count).
 */
export function reserveHandoffRedeem(client: string, now = Date.now()): Promise<BudgetRefund | null> {
  return redeemBudget.reserve(client, now);
}
