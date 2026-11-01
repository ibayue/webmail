/**
 * Sends what waited on this device (#523), once the server answers again:
 * first the changes (read, flagged, tags, moves) in the order they were
 * made, then the outbox, oldest first.
 *
 * - A change the server refuses (the message is gone, moved elsewhere) is
 *   dropped: the server's state wins.
 * - A message is sent as it was finished at Send (queue.ts); files attached
 *   offline are uploaded first. A hold for undo-send that has passed is
 *   dropped, so the message goes at once.
 * - A send that fails on the server stays in the outbox, marked failed,
 *   with the server's reason. A send whose connection broke while it was
 *   on its way is marked uncertain and not tried again on its own: it may
 *   have gone out, and sending it twice is worse than asking.
 * - When the organisation has meanwhile forbidden offline mode, nothing is
 *   sent: the data was wiped with the policy fetch.
 */

import type { JMAPClient } from '@/lib/jmap/client';
import { isNetworkFailure } from '@/lib/jmap/offline-hooks';
import type { SendEmailResult } from '@/lib/jmap/types';
import { heldFile, isLocalBlobId, readQueue, removeOutboxEntry, removeQueued, updateOutboxEntry, type OutboxEntry } from './queue';
import type { OfflineNotice } from './offline-mode';

interface FlushDeps {
  notify: (notice: OfflineNotice) => void;
  allowed: () => boolean;
}

const flushing = new Set<string>();

/** A hold shorter than this is dropped: the undo window passed while the message waited. */
const MIN_HOLD_MS = 10_000;

function stillOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function uploadHeld(account: string, client: JMAPClient, blobId: string): Promise<string> {
  const file = await heldFile(account, blobId);
  if (!file) throw new Error('A file attached offline is no longer on this device.');
  return (await client.uploadBlob(file)).blobId;
}

async function sendEntry(account: string, client: JMAPClient, entry: OutboxEntry): Promise<SendEmailResult> {
  const item = entry.item;
  if (item.kind === 'raw') {
    const file = await heldFile(account, item.blobId);
    if (!file) throw new Error('The message is no longer on this device.');
    const delayed = item.delayedUntil && Date.parse(item.delayedUntil) - Date.now() > MIN_HOLD_MS ? item.delayedUntil : undefined;
    if (item.submitOnly) return client.submitRawEmail(file, item.identityId, delayed, item.envelopeRecipients);
    const mailboxes = await client.getMailboxes();
    const sent = mailboxes.find((m) => m.role === 'sent');
    if (!sent) throw new Error('No sent mailbox found');
    const drafts = mailboxes.find((m) => m.role === 'drafts');
    return client.sendRawEmail(file, item.identityId, sent.id, drafts?.id, delayed, item.envelopeRecipients);
  }
  const args = [...item.args];
  const attachments = args[10];
  if (Array.isArray(attachments)) {
    const resolved = [];
    for (const attachment of attachments as Array<{ blobId: string }>) {
      resolved.push(isLocalBlobId(attachment.blobId) ? { ...attachment, blobId: await uploadHeld(account, client, attachment.blobId) } : attachment);
    }
    args[10] = resolved;
  }
  const delayedUntil = args[13] as string | undefined;
  if (delayedUntil && Date.parse(delayedUntil) - Date.now() <= MIN_HOLD_MS) args[13] = undefined;
  const send = client.sendEmail.bind(client) as (...a: unknown[]) => Promise<SendEmailResult>;
  return send(...args);
}

export async function flushQueue(account: string, client: JMAPClient, deps: FlushDeps): Promise<void> {
  if (flushing.has(account) || !deps.allowed()) return;
  flushing.add(account);
  try {
    const { patches, outbox } = await readQueue(account);

    for (const patch of patches) {
      if (stillOffline()) return;
      try {
        await client.applyEmailPatches(patch.item.jmap, patch.item.update);
      } catch (error) {
        // Still no server: try again later. Anything else: the server's state wins.
        if (isNetworkFailure(error)) return;
      }
      await removeQueued([patch.id]);
    }

    for (const entry of outbox) {
      if (entry.status !== 'waiting') continue;
      if (stillOffline() || !deps.allowed()) return;
      await updateOutboxEntry(entry, { status: 'sending' });
      try {
        await sendEntry(account, client, entry);
        await removeOutboxEntry(entry);
        void client.pruneEmailSubmissions();
        deps.notify({ kind: 'sent', subject: entry.summary.subject });
      } catch (error) {
        if (isNetworkFailure(error)) {
          // Offline again before anything went: it waits. Otherwise it may have gone.
          await updateOutboxEntry(entry, stillOffline() ? { status: 'waiting' } : { status: 'uncertain' });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        await updateOutboxEntry(entry, { status: 'failed', error: message });
        deps.notify({ kind: 'send-failed', subject: entry.summary.subject, error: message });
      }
    }
  } finally {
    flushing.delete(account);
  }
}

/** "Try again" for a failed or uncertain message. */
export async function retryOutboxEntry(id: number): Promise<void> {
  const { outbox } = await readQueue();
  const entry = outbox.find((e) => e.id === id);
  if (entry) await updateOutboxEntry(entry, { status: 'waiting', error: undefined });
}

/** "Delete" in the outbox. */
export async function deleteOutboxEntry(id: number): Promise<void> {
  const { outbox } = await readQueue();
  const entry = outbox.find((e) => e.id === id);
  if (entry) await removeOutboxEntry(entry);
}
