/**
 * Offline mode (#523): "Keep mail on this device".
 *
 * - Opt-in per account and per browser (state.ts), off by default, hidden
 *   and wiped when the organisation forbids it (policy.json
 *   `organisation.devices.noOffline`, per account) and in Lite.
 * - While on, the JMAP client hands every answer of the mail server to the
 *   cache (cache.ts) and asks this device when the network is gone
 *   (responder.ts); a background sync keeps the last 30 days of the Inbox
 *   and of the folders the user opened, with bodies and attachments, under
 *   a cap (sync.ts).
 * - Changes and sends made offline wait in the queue (queue.ts) and go out
 *   in order once the server answers again (flush.ts).
 * - Everything is wiped at a full sign-out and the automatic idle sign-out
 *   (lib/sign-out-cleanup.ts deletes the database), for one account when it
 *   signs out or switches offline mode off, and when the organisation
 *   forbids it (checked on every policy fetch).
 */

import { IS_LITE } from '@/lib/lite';
import { devicesForAccount } from '@/lib/device-policy';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore, whenPolicySettled } from '@/stores/policy-store';
import { onBeforeSignOut, onFullSignOut } from '@/lib/sign-out-cleanup';
import { setOfflineHooks, type OfflineClientRef, type OfflineHooks, type OfflineMethodCall, type OfflineResponse } from '@/lib/jmap/offline-hooks';
import { setOutboxHooks, type OutboxHooks } from './outbox-hooks';
import { answerOffline } from './responder';
import {
  CACHE_WINDOW_MS,
  cacheUsage,
  emailIndex,
  forgetIndexes,
  getBlob,
  getMisc,
  patchEmails,
  putBlob,
  putEmails,
  putMisc,
  removeEmails,
  wipeAccountCache,
  emailKey,
  type CachedEmail,
} from './cache';
import { deleteOfflineDb, hasIndexedDb } from './db';
import { forgetDeviceKey } from './crypto';
import { heldFile, holdFile, isLocalBlobId, queuePatch, queueSend, readQueue, wipeAccountQueue, type OutboxSummary } from './queue';
import { isOfflineNow, useOfflineStore, writeEnabled, type OutboxRow } from './state';
import { flushQueue } from './flush';
import { syncAccount } from './sync';
import { deleteShellCaches, tellServiceWorker } from './shell';

export type OfflineNotice =
  | { kind: 'queued'; subject: string }
  | { kind: 'sent'; subject: string }
  | { kind: 'send-failed'; subject: string; error: string }
  | { kind: 'refused-delete' }
  | { kind: 'refused-other' }
  | { kind: 'forbidden' }
  | { kind: 'back-online-reload' };

let notify: (notice: OfflineNotice) => void = () => {};

/** Where the notices go (the host component turns them into toasts). */
export function setOfflineNotifier(fn: (notice: OfflineNotice) => void): void {
  notify = fn;
}

export function offlineNotify(notice: OfflineNotice): void {
  notify(notice);
}

// ---- Who may use it ----

/** Offline mode is possible here at all: not in Lite, with IndexedDB and WebCrypto. */
export function offlineSupported(): boolean {
  if (IS_LITE || !hasIndexedDb()) return false;
  try {
    return typeof crypto !== 'undefined' && !!crypto.subtle;
  } catch {
    return false;
  }
}

/** The organisation allows this account to keep mail on the device. */
export function offlineAllowed(account: string | null | undefined): boolean {
  return offlineSupported() && !devicesForAccount(account ?? null).noOffline;
}

/** "Keep mail on this device" is on for this account here, and allowed. */
export function offlineActive(account: string | null | undefined): boolean {
  return !!account && useOfflineStore.getState().enabled.includes(account) && offlineAllowed(account);
}

/** The local account a JMAP client belongs to. */
export function accountForClient(client: OfflineClientRef): string | null {
  const auth = useAuthStore.getState();
  if (client === (auth.client as unknown) && auth.activeAccountId) return auth.activeAccountId;
  try {
    for (const [id, c] of auth.getAllConnectedClients()) if ((c as unknown) === client) return id;
  } catch {
    // A stand-in auth store in tests.
  }
  const server = client.getServerUrl().replace(/\/+$/, '');
  const user = client.getUsername();
  const entry = useAccountStore.getState().accounts.find((a) => a.serverUrl.replace(/\/+$/, '') === server && a.username === user);
  return entry?.id ?? null;
}

function onlineClientFor(account: string) {
  const client = useAuthStore.getState().getClientForAccount(account);
  if (!client || client.isOfflineOnly()) return null;
  return client;
}

// ---- What the server sends, into the cache ----

interface Scope {
  inbox: Record<string, string>;
  opened: Record<string, string[]>;
}

const MAX_OPENED_FOLDERS = 10;

async function scopeOf(account: string): Promise<Scope> {
  const mailboxes = (await getMisc<Record<string, Array<{ id: string; role?: string | null }>>>(account, 'mailboxes')) ?? {};
  const inbox: Record<string, string> = {};
  for (const [jmap, list] of Object.entries(mailboxes)) {
    const box = list.find((m) => m.role === 'inbox');
    if (box) inbox[jmap] = box.id;
  }
  const opened = (await getMisc<Record<string, string[]>>(account, 'opened')) ?? {};
  return { inbox, opened };
}

export async function scopeMailboxes(account: string): Promise<Array<{ jmap: string; mailboxId: string; isInbox: boolean }>> {
  const scope = await scopeOf(account);
  const out: Array<{ jmap: string; mailboxId: string; isInbox: boolean }> = [];
  for (const [jmap, id] of Object.entries(scope.inbox)) out.push({ jmap, mailboxId: id, isInbox: true });
  for (const [jmap, ids] of Object.entries(scope.opened)) {
    for (const id of ids) if (scope.inbox[jmap] !== id) out.push({ jmap, mailboxId: id, isInbox: false });
  }
  return out;
}

function inScope(scope: Scope, jmap: string, email: CachedEmail, now = Date.now()): boolean {
  const at = Date.parse(String(email.receivedAt ?? ''));
  if (Number.isFinite(at) && at < now - CACHE_WINDOW_MS) return false;
  const boxes = Object.keys(email.mailboxIds ?? {});
  const wanted = new Set([...(scope.opened[jmap] ?? []), ...(scope.inbox[jmap] ? [scope.inbox[jmap]] : [])]);
  return boxes.some((id) => wanted.has(id));
}

/** The folder a list query opened, if it is one. */
function openedFolder(args: Record<string, unknown>): string | null {
  if (typeof args.limit !== 'number') return null;
  const filter = args.filter as Record<string, unknown> | undefined;
  if (!filter) return null;
  if (typeof filter.inMailbox === 'string' && Object.keys(filter).every((k) => k === 'inMailbox' || k === 'hasKeyword')) return filter.inMailbox;
  if (filter.operator === 'AND' && Array.isArray(filter.conditions)) {
    for (const c of filter.conditions as Array<Record<string, unknown>>) if (typeof c.inMailbox === 'string' && Object.keys(c).length === 1) return c.inMailbox;
  }
  return null;
}

async function noteOpenedFolder(account: string, jmap: string, mailboxId: string): Promise<void> {
  const opened = (await getMisc<Record<string, string[]>>(account, 'opened')) ?? {};
  const list = opened[jmap] ?? [];
  if (list[0] === mailboxId) return;
  opened[jmap] = [mailboxId, ...list.filter((id) => id !== mailboxId)].slice(0, MAX_OPENED_FOLDERS);
  await putMisc(account, 'opened', opened);
  scheduleSync(account, 5_000);
}

async function putList(account: string, name: 'mailboxes' | 'identities', jmap: string, list: unknown[]): Promise<void> {
  const all = (await getMisc<Record<string, unknown[]>>(account, name)) ?? {};
  all[jmap] = list;
  await putMisc(account, name, all);
}

async function recordAnswer(account: string, defaultJmap: string, calls: OfflineMethodCall[], response: OfflineResponse): Promise<void> {
  const scope = await scopeOf(account);
  for (const [name, result, callId] of response.methodResponses) {
    if (!result || typeof result !== 'object') continue;
    const call = calls.find(([n, , id]) => id === callId && n === name);
    const args = call?.[1] ?? {};
    const jmap = (result.accountId as string) || (args.accountId as string) || defaultJmap;
    const properties = args.properties as string[] | undefined;
    switch (name) {
      case 'Mailbox/get':
        if (!args.ids && (!properties || properties.includes('name')) && Array.isArray(result.list)) {
          await putList(account, 'mailboxes', jmap, result.list);
        }
        break;
      case 'Identity/get':
        if (!args.ids && Array.isArray(result.list)) await putList(account, 'identities', jmap, result.list);
        break;
      case 'Email/get': {
        const list = (Array.isArray(result.list) ? result.list : []) as CachedEmail[];
        // Fresh state for every message already kept; new ones only within the scope.
        const index = await emailIndex(account);
        const keep = list.filter((email) => index.has(emailKey(account, jmap, email.id)) || inScope(scope, jmap, email));
        await putEmails(account, jmap, keep);
        break;
      }
      case 'Email/query': {
        const folder = openedFolder(args);
        if (folder) await noteOpenedFolder(account, jmap, folder);
        break;
      }
      case 'Email/set': {
        const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
        const updated = Object.keys((result.updated ?? {}) as object);
        if (updated.length) await patchEmails(account, jmap, Object.fromEntries(updated.filter((id) => update[id]).map((id) => [id, update[id]])));
        const destroyed = (Array.isArray(result.destroyed) ? result.destroyed : []) as string[];
        if (destroyed.length) await removeEmails(account, destroyed.map((id) => emailKey(account, jmap, id)));
        break;
      }
      default:
        break;
    }
  }
}

// One write after the other per account, so a list and its refresh land in order.
const recording = new Map<string, Promise<void>>();

function enqueueRecord(account: string, task: () => Promise<void>): void {
  const previous = recording.get(account) ?? Promise.resolve();
  const next = previous.then(task).catch(() => {});
  recording.set(account, next);
}

// ---- Hooks for the JMAP client ----

let networkWasDown = false;
let probing = false;

/**
 * A request failed on the network. Browsers report a refusal without CORS
 * headers (Stalwart answering "too many requests at once") the same way as
 * no network at all, so the server is asked once more without CORS: only
 * when that fails too is the server counted as gone, and sends go to the
 * outbox.
 */
async function probeServer(client: OfflineClientRef): Promise<void> {
  if (probing) return;
  probing = true;
  try {
    await fetch(`${client.getServerUrl().replace(/\/+$/, '')}/.well-known/jmap`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' });
  } catch {
    networkWasDown = true;
    if (!useOfflineStore.getState().networkDown) useOfflineStore.setState({ networkDown: true });
  } finally {
    probing = false;
  }
}

const hooks: OfflineHooks = {
  skipNetwork(client) {
    if (typeof navigator === 'undefined' || navigator.onLine !== false) return false;
    return offlineActive(accountForClient(client));
  },
  async answer(client, methodCalls) {
    const account = accountForClient(client);
    if (!offlineActive(account) || !account) return null;
    return answerOffline({
      account,
      defaultJmap: client.getAccountId(),
      queuePatch: async (jmap, update) => {
        await queuePatch(account, jmap, update);
        void refreshQueueState();
      },
      onRefused: (what) => notify({ kind: what === 'destroy' ? 'refused-delete' : 'refused-other' }),
    }, methodCalls);
  },
  record(client, methodCalls, response) {
    const account = accountForClient(client);
    if (!offlineActive(account) || !account) return;
    // Callers change the answer's objects after this returns.
    const copy = JSON.parse(JSON.stringify(response)) as OfflineResponse;
    const calls = JSON.parse(JSON.stringify(methodCalls)) as OfflineMethodCall[];
    const jmap = client.getAccountId();
    enqueueRecord(account, () => recordAnswer(account, jmap, calls, copy));
  },
  noteNetwork(client, reachable) {
    if (reachable) {
      if (useOfflineStore.getState().networkDown) useOfflineStore.setState({ networkDown: false });
      if (networkWasDown) {
        networkWasDown = false;
        scheduleFlushAll(500);
      }
    } else {
      void probeServer(client);
    }
  },
  async blob(client, blobId, jmap) {
    const account = accountForClient(client);
    if (!account || !offlineActive(account)) return null;
    if (isLocalBlobId(blobId)) return heldFile(account, blobId);
    return getBlob(account, jmap, blobId);
  },
  recordBlob(client, blobId, jmap, blob) {
    const account = accountForClient(client);
    if (!account || !offlineActive(account) || blob.size > MAX_RECORDED_BLOB_BYTES) return;
    enqueueRecord(account, () => putBlob(account, jmap, blobId, blob, Date.now()));
  },
  async holdUpload(client, file) {
    const account = accountForClient(client);
    if (!account || !offlineActive(account)) return null;
    return holdFile(account, file, file.name);
  },
};

/** Attachments and images opened while online are kept up to this size. */
const MAX_RECORDED_BLOB_BYTES = 10 * 1024 * 1024;

// ---- The outbox ----

function summaryOf(args: unknown[]): OutboxSummary {
  const [to, subject, , cc, bcc] = args as [string[] | undefined, string | undefined, unknown, string[] | undefined, string[] | undefined];
  return { subject: subject ?? '', to: [...(to ?? []), ...(cc ?? []), ...(bcc ?? [])] };
}

function queuedResult(): { scheduled: false; queued: true } {
  return { scheduled: false, queued: true };
}

const outbox: OutboxHooks = {
  shouldQueue(client) {
    const account = accountForClient(client);
    return !!account && offlineActive(account) && (isOfflineNow() || (typeof navigator !== 'undefined' && navigator.onLine === false));
  },
  async queueEmail(client, args) {
    const account = accountForClient(client);
    if (!account) throw new Error('No account for this send');
    const options = { ...((args[15] as Record<string, unknown> | undefined) ?? {}) };
    delete options.outbox;
    const stored = [...args.slice(0, 15), options];
    const summary = summaryOf(stored);
    await queueSend(account, summary, { kind: 'email', args: stored });
    await refreshQueueState();
    notify({ kind: 'queued', subject: summary.subject });
    return queuedResult();
  },
  async queueRaw(client, raw, options) {
    const account = accountForClient(client);
    if (!account) throw new Error('No account for this send');
    const held = await holdFile(account, raw, 'message.eml');
    const summary = await rawSummary(raw);
    await queueSend(account, summary, { kind: 'raw', blobId: held.blobId, ...options });
    await refreshQueueState();
    notify({ kind: 'queued', subject: summary.subject });
    return queuedResult();
  },
  async resolveHeldAttachments(client, attachments) {
    const account = accountForClient(client);
    if (!account || !attachments.some((a) => isLocalBlobId(a.blobId))) return attachments;
    const real = onlineClientFor(account);
    if (!real) return attachments;
    const out = [];
    for (const attachment of attachments) {
      if (!isLocalBlobId(attachment.blobId)) { out.push(attachment); continue; }
      const file = await heldFile(account, attachment.blobId);
      if (!file) throw new Error('A file attached offline is no longer on this device. Attach it again.');
      const { blobId } = await real.uploadBlob(file);
      out.push({ ...attachment, blobId });
    }
    return out;
  },
};

/** Subject and recipients of a raw message, for the outbox list. */
async function rawSummary(raw: Blob): Promise<OutboxSummary> {
  const head = await raw.slice(0, 64 * 1024).text();
  const end = head.search(/\r?\n\r?\n/);
  const block = (end >= 0 ? head.slice(0, end) : head).replace(/\r?\n[ \t]+/g, ' ');
  const header = (name: string) => block.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? '';
  const to = ['to', 'cc'].flatMap((name) => header(name).split(',')).map((s) => s.trim()).filter(Boolean);
  return { subject: decodeMimeWords(header('subject')), to };
}

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, encoding: string, text: string) => {
    try {
      const bytes = encoding.toUpperCase() === 'B'
        ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
        : Uint8Array.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), (c) => c.charCodeAt(0));
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return whole;
    }
  });
}

/** Reads the queue into the store, for the outbox view and the banner. */
export async function refreshQueueState(): Promise<void> {
  if (!offlineSupported()) return;
  try {
    const { patches, outbox: entries } = await readQueue();
    const rows: OutboxRow[] = entries.map((entry) => ({
      id: entry.id,
      account: entry.account,
      createdAt: entry.createdAt,
      subject: entry.summary.subject,
      to: entry.summary.to,
      status: entry.status,
      error: entry.error,
    }));
    useOfflineStore.setState({ outbox: rows, pendingChanges: patches.length });
  } catch {
    // The database is being deleted.
  }
}

export async function refreshUsage(): Promise<void> {
  if (!offlineSupported()) return;
  try {
    useOfflineStore.setState({ usageBytes: (await cacheUsage()).total });
  } catch {
    /* deleted meanwhile */
  }
}

// ---- Sync and flush timing ----

const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleSync(account: string, delayMs = 2_000): void {
  if (!offlineActive(account)) return;
  const existing = syncTimers.get(account);
  if (existing) clearTimeout(existing);
  syncTimers.set(account, setTimeout(() => {
    syncTimers.delete(account);
    void runSync(account);
  }, delayMs));
}

const syncsRunning = new Set<string>();

export async function runSync(account: string): Promise<void> {
  if (syncsRunning.has(account) || !offlineActive(account)) return;
  const client = onlineClientFor(account);
  if (!client || isOfflineNow()) return;
  syncsRunning.add(account);
  useOfflineStore.setState((s) => ({ syncing: [...new Set([...s.syncing, account])] }));
  try {
    await syncAccount(account, client, { stillActive: () => offlineActive(account), scopeMailboxes });
    useOfflineStore.setState((s) => ({ lastSyncedAt: { ...s.lastSyncedAt, [account]: Date.now() } }));
  } catch {
    // Tried again at the next change or in 15 minutes.
  } finally {
    syncsRunning.delete(account);
    useOfflineStore.setState((s) => ({ syncing: s.syncing.filter((id) => id !== account) }));
    void refreshUsage();
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleFlushAll(delayMs = 1_000): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushAll();
  }, delayMs);
}

export async function flushAll(): Promise<void> {
  if (useOfflineStore.getState().startedOffline) {
    // Started without the server: the clients have no credentials. A reload signs in and sends.
    if (typeof navigator === 'undefined' || navigator.onLine !== false) notify({ kind: 'back-online-reload' });
    return;
  }
  const { outbox: rows, pendingChanges } = useOfflineStore.getState();
  const accounts = new Set(rows.map((r) => r.account));
  if (pendingChanges > 0) for (const id of useOfflineStore.getState().enabled) accounts.add(id);
  for (const account of accounts) {
    const client = onlineClientFor(account);
    if (!client) continue;
    await flushQueue(account, client, {
      notify,
      allowed: () => offlineAllowed(account),
    });
  }
  await refreshQueueState();
  for (const account of useOfflineStore.getState().enabled) scheduleSync(account, 3_000);
}

// ---- Switching it on and off, wiping ----

export async function enableOffline(account: string): Promise<void> {
  if (!offlineAllowed(account)) return;
  const enabled = useOfflineStore.getState().enabled;
  if (!enabled.includes(account)) writeEnabled([...enabled, account]);
  const client = onlineClientFor(account);
  if (client) await putMisc(account, 'session', client.getSessionSnapshot());
  await tellServiceWorker(true);
  scheduleSync(account, 0);
}

/** Switches offline mode off for an account and removes everything it kept here. */
export async function disableOffline(account: string): Promise<void> {
  writeEnabled(useOfflineStore.getState().enabled.filter((id) => id !== account));
  await wipeAccount(account);
}

export async function wipeAccount(account: string): Promise<void> {
  const timer = syncTimers.get(account);
  if (timer) clearTimeout(timer);
  syncTimers.delete(account);
  if (useOfflineStore.getState().enabled.includes(account)) {
    writeEnabled(useOfflineStore.getState().enabled.filter((id) => id !== account));
  }
  try {
    await recording.get(account);
    await wipeAccountCache(account);
    await wipeAccountQueue(account);
  } catch {
    // No database: nothing to remove.
  }
  if (useOfflineStore.getState().enabled.length === 0) {
    await wipeEverything();
    return;
  }
  await refreshQueueState();
  await refreshUsage();
}

/** Nothing of offline mode stays on this device. */
export async function wipeEverything(): Promise<void> {
  for (const timer of syncTimers.values()) clearTimeout(timer);
  syncTimers.clear();
  writeEnabled([]);
  forgetIndexes();
  forgetDeviceKey();
  await deleteOfflineDb();
  await tellServiceWorker(false);
  await deleteShellCaches();
  useOfflineStore.setState({ outbox: [], pendingChanges: 0, usageBytes: 0, syncing: [], lastSyncedAt: {} });
}

/** The organisation forbids it for an account that has it on: wipe that account. */
export function enforcePolicy(): void {
  const { loaded } = usePolicyStore.getState();
  if (!loaded) return;
  for (const account of useOfflineStore.getState().enabled) {
    if (!offlineAllowed(account)) {
      void wipeAccount(account);
      notify({ kind: 'forbidden' });
    }
  }
}

// ---- Starting ----

let started = false;
const cleanups: Array<() => void> = [];

/** Runs offline mode in this tab. Safe to call more than once. */
export function startOfflineMode(): () => void {
  if (started || !offlineSupported()) return () => {};
  started = true;
  setOfflineHooks(hooks);
  setOutboxHooks(outbox);

  const onOnline = () => {
    useOfflineStore.setState({ browserOffline: false });
    scheduleFlushAll(500);
  };
  const onOffline = () => useOfflineStore.setState({ browserOffline: true });
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  cleanups.push(() => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  });

  // The organisation's word, on every policy fetch (and the cached copy at an offline start).
  cleanups.push(usePolicyStore.subscribe((state, prev) => {
    if (state.rawPolicy !== prev.rawPolicy || state.loaded !== prev.loaded || state.subject !== prev.subject) enforcePolicy();
  }));
  enforcePolicy();

  // An account that signs out (or is removed) takes its offline data with it.
  let known = new Set(useAccountStore.getState().accounts.map((a) => a.id));
  cleanups.push(useAccountStore.subscribe((state) => {
    const now = new Set(state.accounts.map((a) => a.id));
    for (const id of known) if (!now.has(id)) void wipeAccount(id);
    known = now;
  }));

  // Session, then a sync, for every account signed in with offline mode on.
  const syncSignedIn = () => {
    for (const account of useOfflineStore.getState().enabled) {
      const client = onlineClientFor(account);
      if (!client || !offlineActive(account)) continue;
      void putMisc(account, 'session', client.getSessionSnapshot()).catch(() => {});
      scheduleSync(account, 3_000);
    }
  };
  cleanups.push(useAuthStore.subscribe((state, prev) => {
    if (state.client !== prev.client || state.connectedAccountsRevision !== prev.connectedAccountsRevision) syncSignedIn();
  }));
  syncSignedIn();

  const interval = setInterval(() => {
    for (const account of useOfflineStore.getState().enabled) scheduleSync(account, 0);
  }, SYNC_INTERVAL_MS);
  cleanups.push(() => clearInterval(interval));

  if (useOfflineStore.getState().enabled.length > 0) void tellServiceWorker(true);
  void refreshQueueState().then(() => {
    if (!isOfflineNow()) scheduleFlushAll(2_000);
  });
  void refreshUsage();

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    setOfflineHooks(null);
    setOutboxHooks(null);
    started = false;
  };
}

/** How often the cache catches up while the tab is open. */
export const SYNC_INTERVAL_MS = 15 * 60 * 1000;

// A full sign-out deletes the database (lib/sign-out-cleanup.ts); forget
// what is held in memory as well.
onFullSignOut(() => {
  for (const timer of syncTimers.values()) clearTimeout(timer);
  syncTimers.clear();
  forgetIndexes();
  forgetDeviceKey();
  useOfflineStore.setState({ enabled: [], outbox: [], pendingChanges: 0, usageBytes: 0, syncing: [], lastSyncedAt: {}, startedOffline: false });
});

// Unsent messages of the accounts signing out, named on the login page
// after an automatic sign-out (lib/session-policy/sign-out-reason.ts).
onBeforeSignOut(async (accountId) => {
  const rows = useOfflineStore.getState().outbox.filter((row) => accountId === 'all' || row.account === accountId);
  if (rows.length === 0) return;
  const { noteOutboxLost } = await import('@/lib/session-policy/sign-out-reason');
  noteOutboxLost(rows.map((row) => row.subject));
});

/** The session kept for an account, for starting without the server. */
export async function offlineSessionFor(account: string): Promise<unknown | null> {
  // The organisation's last word: the policy kept from the last fetch (the
  // fetch itself fails without a network), never the defaults.
  const policy = usePolicyStore.getState();
  if (!policy.loaded && !policy.fetching) await policy.fetchPolicy();
  else await whenPolicySettled(3000);
  if (!offlineActive(account)) return null;
  try {
    return await getMisc<unknown>(account, 'session');
  } catch {
    return null;
  }
}

export function markStartedOffline(): void {
  useOfflineStore.setState({ startedOffline: true });
}
