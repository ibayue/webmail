/**
 * Brings an account's recent mail onto the device (#523): the last 30 days
 * of the Inbox and of the folders the user opened (at most INBOX_LIMIT and
 * FOLDER_LIMIT messages), with bodies, and the attachments and inline
 * images of those messages up to ATTACHMENT_MAX_BYTES each. Messages that
 * left that window or the folders are removed; then the cache is brought
 * under its cap, oldest first.
 *
 * Everything goes through the JMAP client, whose answers the cache records
 * (offline-mode.ts), so the sync only asks.
 */

import type { JMAPClient } from '@/lib/jmap/client';
import { CACHE_WINDOW_MS, emailIndex, emailKey, enforceCap, getBody, hasBlob, hasBody, putBlob, putMisc, removeEmails, type CachedEmail } from './cache';

export const INBOX_LIMIT = 500;
export const FOLDER_LIMIT = 200;
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Attachment bytes one sync run fetches at most. */
const ATTACHMENT_BUDGET_BYTES = 100 * 1024 * 1024;

interface SyncDeps {
  stillActive: () => boolean;
  /** Resolves once the cache has written every answer the client recorded so far. */
  recorded: () => Promise<void>;
  scopeMailboxes: (account: string) => Promise<Array<{ jmap: string; mailboxId: string; isInbox: boolean }>>;
}

interface AttachmentPart {
  blobId?: string;
  name?: string | null;
  type?: string;
  size?: number;
}

/** Once more after a second: Stalwart refuses requests beyond its limit of parallel ones. */
async function twice<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
    return run();
  }
}

export async function syncAccount(account: string, client: JMAPClient, deps: SyncDeps): Promise<void> {
  await putMisc(account, 'session', client.getSessionSnapshot());
  // Folders and identities are recorded from these answers.
  await twice(() => client.getAllMailboxes()).catch(() => client.getMailboxes());
  await twice(() => client.getIdentities()).catch(() => []);
  // The folder list says which folder is the Inbox.
  await deps.recorded();
  if (!deps.stillActive()) return;

  const since = new Date(Date.now() - CACHE_WINDOW_MS).toISOString();
  const wanted = new Map<string, Set<string>>();
  const scopes = await deps.scopeMailboxes(account);
  let complete = scopes.length > 0;
  for (const { jmap, mailboxId, isInbox } of scopes) {
    let ids: string[];
    try {
      ids = await twice(() => client.getRecentEmailIds(mailboxId, jmap, since, isInbox ? INBOX_LIMIT : FOLDER_LIMIT));
    } catch {
      complete = false;
      continue;
    }
    const set = wanted.get(jmap) ?? new Set<string>();
    ids.forEach((id) => set.add(id));
    wanted.set(jmap, set);
  }
  if (!deps.stillActive()) return;

  for (const [jmap, idSet] of wanted) {
    const ids = [...idSet];
    // Fresh keywords and folders for all of them (cheap: list properties).
    if (ids.length) await twice(() => client.getSomeEmails(ids, jmap === client.getAccountId() ? undefined : jmap)).catch(() => []);
    // Bodies for the ones that don't have one yet, a batch at a time.
    const missing: string[] = [];
    for (const id of ids) if (!(await hasBody(account, jmap, id))) missing.push(id);
    for (let i = 0; i < missing.length; i += 20) {
      await twice(() => client.getFullEmails(missing.slice(i, i + 20), jmap)).catch(() => { complete = false; });
      if (!deps.stillActive()) return;
    }
  }
  await deps.recorded();

  // What left the window or the folders goes.
  const index = await emailIndex(account);
  const stale: string[] = [];
  for (const [key, email] of index) {
    const jmap = key.split('\u0001')[1];
    if (!wanted.get(jmap)?.has(email.id)) stale.push(key);
  }
  // Only after a complete pass: a folder that couldn't be asked keeps what it had.
  if (complete) await removeEmails(account, stale);

  // Attachments and inline images, newest messages first, within the budget.
  let budget = ATTACHMENT_BUDGET_BYTES;
  const newestFirst = [...index.entries()].sort(([, a], [, b]) => (Date.parse(String(b.receivedAt)) || 0) - (Date.parse(String(a.receivedAt)) || 0));
  for (const [key, email] of newestFirst) {
    if (budget <= 0 || !deps.stillActive()) break;
    const jmap = key.split('\u0001')[1];
    for (const part of await attachmentsOf(account, email, jmap)) {
      if (!part.blobId || !part.size || part.size > ATTACHMENT_MAX_BYTES || part.size > budget) continue;
      if (await hasBlob(account, jmap, part.blobId)) continue;
      try {
        const blob = await client.fetchBlob(part.blobId, part.name ?? undefined, part.type, jmap);
        await putBlob(account, jmap, part.blobId, blob, Date.parse(String(email.receivedAt)) || Date.now(), emailKey(account, jmap, email.id));
        budget -= blob.size;
      } catch {
        // Fetched again at the next sync.
      }
    }
  }

  await enforceCap();
}

async function attachmentsOf(account: string, email: CachedEmail, jmap: string): Promise<AttachmentPart[]> {
  const body = await getBody(account, jmap, email.id);
  const parts = body?.attachments;
  return Array.isArray(parts) ? (parts as AttachmentPart[]) : [];
}
