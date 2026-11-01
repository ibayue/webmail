import type { IJMAPClient, UploadedEmailImport, UploadedEmailImportResult } from "@/lib/jmap/client-interface";
import type { Mailbox } from "@/lib/jmap/types";
import { checkpointKey, deleteCheckpoint, readCheckpoint, writeCheckpoint } from "./checkpoints";
import { emlSource, mboxSource, zipSource, type ImportFormat, type ImportItem, type ItemSource, type SkipReason, type SourceOptions } from "./sources";

/**
 * One engine for every mail import (EML, ZIP, mbox, PST): it reads messages
 * from the files, uploads them a few at a time, imports them several per
 * Email/import, and creates the file's folders where asked.
 *
 * Paced to the server: at most maxConcurrentUpload uploads (and two request
 * slots left for the rest of the app), through the XHR upload path so a
 * refusal doesn't pause the whole client. Stalwart takes 1000 uploads or
 * 50 MB per user per hour (counted in fixed hour windows, whether the blobs
 * get imported or not) and answers HTTP 429 past that: the import then
 * pauses until the window ends and goes on by itself. A checkpoint per file
 * lets a cancelled or interrupted import continue where it stopped.
 */

export type ImportPhase = "running" | "paused" | "done" | "cancelled" | "failed";

export interface ImportFailure {
  label: string;
  reason: string;
}

export interface ImportProgress {
  phase: ImportPhase;
  imported: number;
  failed: number;
  skipped: Partial<Record<SkipReason, number>>;
  /** The first failures, for the summary. */
  failures: ImportFailure[];
  /** Part of all files read, 0 to 1. */
  fraction: number;
  /** Messages in the files, once known for all of them. */
  total?: number;
  /** The file being read. */
  fileName?: string;
  /** While paused by the upload limit: when the import goes on (ms since epoch). */
  pausedUntil?: number;
  /** The limit the server named, when it did. */
  quota?: { files?: number; bytes?: number };
  foldersCreated: number;
  /** Why the whole import stopped (phase failed). */
  error?: string;
}

export interface ImportFile {
  file: File;
  format: ImportFormat;
}

/** Opens a PST source (loaded only when a PST is imported). */
export type PstOpener = (file: File, options: SourceOptions) => ItemSource;

export interface ImportOptions {
  client: IJMAPClient;
  /** The JMAP account the messages go into (a shared folder's own account). */
  accountId: string;
  /** Folder the messages go into; null is the top level (only with keepFolders). */
  targetMailboxId: string | null;
  /** Recreate the files' folders under the target; otherwise everything goes into it. */
  keepFolders: boolean;
  files: ImportFile[];
  /** The Bulwark account, for the checkpoints. */
  scope: string;
  /** Continue after the items an earlier run of the same import handled. */
  resume: boolean;
  signal: AbortSignal;
  onProgress: (progress: ImportProgress) => void;
  openPst?: PstOpener;
  /** Test seams. */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Least time between two progress reports (ms). */
  reportEveryMs?: number;
}

const MAX_FAILURES_LISTED = 20;
/** Messages per Email/import call. */
const IMPORT_BATCH = 20;
/** How long a few uploaded messages wait for more before they're imported. */
const IMPORT_FLUSH_MS = 400;
/** Retries of an upload that failed for another reason than the limit. */
const UPLOAD_RETRY_DELAYS_MS = [2000, 8000];
/** Stalwart's upload window (uploadTtl, 1 h by default). */
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;
const CHECKPOINT_EVERY_MS = 2000;

export class ImportCancelled extends Error {
  constructor() {
    super("Import cancelled");
    this.name = "AbortError";
  }
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError";
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new ImportCancelled()); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new ImportCancelled()); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** What an upload error says: the client's XHR path reports "Failed to upload file: <status> - <body>". */
export function uploadErrorInfo(error: unknown): { status?: number; body: string } {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const m = /Failed to upload file: (\d{3}) - ([\s\S]*)$/.exec(message);
  return m ? { status: Number(m[1]), body: m[2] } : { body: message };
}

/** "You have exceeded the blob upload quota of 1000 files or 50000000 bytes." */
export function quotaFrom(body: string): { files?: number; bytes?: number } {
  const m = /quota of (\d+) files? or (\d+) bytes/i.exec(body);
  return m ? { files: Number(m[1]), bytes: Number(m[2]) } : {};
}

/**
 * When the upload limit lets uploads through again. The server doesn't send
 * Retry-After in a way the browser may read (no CORS exposure), so this is
 * the end of the current window: Stalwart counts in fixed windows of
 * uploadTtl since the epoch, full hours by default.
 */
export function uploadWindowEnd(now: number, windowMs = UPLOAD_WINDOW_MS): number {
  return (Math.floor(now / windowMs) + 1) * windowMs;
}

function maxConcurrentUploads(client: IJMAPClient): number {
  const core = client.getCapabilities()["urn:ietf:params:jmap:core"] as { maxConcurrentUpload?: unknown } | undefined;
  const uploads = typeof core?.maxConcurrentUpload === "number" && core.maxConcurrentUpload > 0 ? core.maxConcurrentUpload : 4;
  // Uploads and imports share the request slots with the rest of the app; leave it two.
  return Math.max(1, Math.min(uploads, (client.getMaxConcurrentRequests?.() ?? 4) - 2));
}

/** Top-level folder names that mean a special folder, as Outlook and others name them. */
const ROLE_NAMES: Record<string, string[]> = {
  inbox: ["inbox", "posteingang"],
  sent: ["sent", "sent items", "sent mail", "sent messages", "gesendet", "gesendete elemente", "gesendete objekte"],
  drafts: ["drafts", "entwürfe"],
  trash: ["trash", "deleted items", "deleted messages", "papierkorb", "gelöschte elemente", "gelöschte objekte"],
  junk: ["junk", "junk e-mail", "junk email", "junk mail", "spam", "junk-e-mail"],
  archive: ["archive", "archiv"],
};

function roleFor(name: string): string | undefined {
  const key = name.trim().toLowerCase();
  return Object.keys(ROLE_NAMES).find((role) => ROLE_NAMES[role].includes(key));
}

/**
 * Maps a file's folder paths to mailboxes in the account, creating what's
 * missing once. A folder with the same name under the same parent is used
 * again, so a resumed import doesn't make a second copy of the tree; at the
 * top level an "Inbox" or "Sent Items" means the account's own.
 */
export class FolderResolver {
  private mailboxes: Mailbox[] | null = null;
  private readonly cache = new Map<string, Promise<string>>();
  created = 0;

  constructor(
    private readonly client: IJMAPClient,
    private readonly accountId: string,
    private readonly root: string | null,
  ) {}

  private async list(): Promise<Mailbox[]> {
    if (!this.mailboxes) this.mailboxes = await this.client.getMailboxes(this.accountId);
    return this.mailboxes;
  }

  private static idOf(m: Mailbox): string {
    return m.originalId || m.id;
  }

  private async inbox(): Promise<string> {
    const box = (await this.list()).find((m) => m.role === "inbox");
    if (!box) throw new Error("No Inbox in this account");
    return FolderResolver.idOf(box);
  }

  resolve(path: string[]): Promise<string> {
    const key = path.join("\u0000");
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.resolveUncached(path);
      // A failed creation may be tried again by the next message.
      pending.catch(() => this.cache.delete(key));
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async resolveUncached(path: string[]): Promise<string> {
    if (path.length === 0) return this.root ?? this.inbox();
    const parentId = path.length === 1 ? this.root : await this.resolve(path.slice(0, -1));
    const name = path[path.length - 1].trim().slice(0, 255) || "Imported";
    const mailboxes = await this.list();
    const same = (m: Mailbox) => m.name.trim().toLowerCase() === name.toLowerCase();
    const parentMatches = (m: Mailbox) => (parentId === null ? !m.parentId : m.parentId === parentId || m.parentId === mailboxes.find((p) => FolderResolver.idOf(p) === parentId)?.id);
    const existing = mailboxes.find((m) => parentMatches(m) && same(m));
    if (existing) return FolderResolver.idOf(existing);
    if (parentId === null) {
      const role = roleFor(name);
      const special = role && mailboxes.find((m) => m.role === role);
      if (special) return FolderResolver.idOf(special);
    }
    const created = await this.client.createMailbox(name, parentId ?? undefined, this.accountId);
    this.created++;
    mailboxes.push({ ...created, parentId: parentId ?? undefined });
    return FolderResolver.idOf(created);
  }
}

interface Uploaded {
  index: number;
  fileIndex: number;
  label: string;
  entry: UploadedEmailImport;
}

/** Counts handled items per file, so the checkpoint is the first index not handled yet. */
class Watermark {
  private next = 0;
  private readonly ahead = new Set<number>();
  constructor(start: number) { this.next = start; }
  mark(index: number): void {
    if (index < this.next) return;
    this.ahead.add(index);
    while (this.ahead.has(this.next)) { this.ahead.delete(this.next); this.next++; }
  }
  get value(): number { return this.next; }
}

export async function runImport(options: ImportOptions): Promise<ImportProgress> {
  const { client, accountId, signal } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const progress: ImportProgress = { phase: "running", imported: 0, failed: 0, skipped: {}, failures: [], fraction: 0, foldersCreated: 0 };
  const folders = new FolderResolver(client, accountId, options.targetMailboxId);
  const maxSize = client.getMaxSizeUpload() || Number.POSITIVE_INFINITY;
  const lanes = maxConcurrentUploads(client);

  let lastReport = 0;
  const report = (force = false) => {
    const t = now();
    if (!force && t - lastReport < (options.reportEveryMs ?? 150)) return;
    lastReport = t;
    progress.foldersCreated = folders.created;
    options.onProgress({ ...progress, skipped: { ...progress.skipped }, failures: [...progress.failures] });
  };
  const skip = (reason: SkipReason, n = 1) => { progress.skipped[reason] = (progress.skipped[reason] ?? 0) + n; };
  const fail = (label: string, reason: string) => {
    progress.failed++;
    if (progress.failures.length < MAX_FAILURES_LISTED) progress.failures.push({ label, reason });
  };

  // Shared pause: when the server refuses uploads, every lane waits.
  let pausedUntil = 0;
  const waitWhilePaused = async () => {
    while (pausedUntil > now()) {
      progress.phase = "paused";
      progress.pausedUntil = pausedUntil;
      report(true);
      await sleep(Math.max(1000, pausedUntil - now()), signal);
    }
    if (progress.phase === "paused") {
      progress.phase = "running";
      progress.pausedUntil = undefined;
      report(true);
    }
  };

  const sizes = options.files.map((f) => f.file.size);
  const totalBytes = sizes.reduce((a, b) => a + b, 0) || 1;
  const fileFraction = options.files.map(() => 0);
  const totals: (number | undefined)[] = options.files.map(() => undefined);
  const setFraction = () => {
    progress.fraction = Math.min(1, fileFraction.reduce((n, f, i) => n + f * sizes[i], 0) / totalBytes);
  };

  const keys = options.files.map(({ file }) => checkpointKey({
    scope: options.scope, accountId, target: options.targetMailboxId, keepFolders: options.keepFolders, file,
  }));
  const marks: Watermark[] = [];
  const importedPerFile: number[] = options.files.map(() => 0);
  let lastSaved = 0;
  const saveCheckpoints = async (force = false) => {
    if (!force && now() - lastSaved < CHECKPOINT_EVERY_MS) return;
    lastSaved = now();
    await Promise.all(marks.map((m, i) => m.value > 0 ? writeCheckpoint({
      key: keys[i], scope: options.scope, fileName: options.files[i].file.name, done: m.value, imported: importedPerFile[i], updatedAt: now(),
    }) : Promise.resolve()));
  };

  // ── Email/import in batches ──
  let queue: Uploaded[] = [];
  let importing: Promise<void> = Promise.resolve();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const handled = (u: { fileIndex: number; index: number }) => marks[u.fileIndex].mark(u.index);

  const importBatch = async (batch: Uploaded[]) => {
    let results: UploadedEmailImportResult[] | null = null;
    for (let attempt = 0; results === null; attempt++) {
      try {
        if (client.importUploadedEmails) {
          results = await client.importUploadedEmails(batch.map((b) => b.entry), accountId);
        } else {
          // A client without batch import (the demo) can't take uploaded blobs either.
          results = batch.map(() => ({ error: "Import isn't available here" }));
        }
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        if (name === "RateLimitError" && attempt < 3) {
          await sleep(Math.max(1000, (error as { retryAfterMs?: number }).retryAfterMs ?? 60_000), signal);
          continue;
        }
        if (attempt < 1 && !isAbort(error)) { await sleep(2000, signal); continue; }
        results = batch.map(() => ({ error: error instanceof Error ? error.message : String(error) }));
      }
    }
    results.forEach((result, i) => {
      const item = batch[i];
      if ("id" in result) {
        progress.imported++;
        importedPerFile[item.fileIndex]++;
      } else {
        fail(item.label, result.type === "invalidEmail" ? "invalid" : result.error);
      }
      handled(item);
    });
    report();
    await saveCheckpoints();
  };

  const flush = () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (queue.length === 0) return importing;
    const batch = queue;
    queue = [];
    importing = importing.then(() => importBatch(batch));
    return importing;
  };
  const enqueue = (u: Uploaded) => {
    queue.push(u);
    if (queue.length >= IMPORT_BATCH) void flush();
    else if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, IMPORT_FLUSH_MS);
  };

  // ── Uploads, a few at a time ──
  const running = new Set<Promise<void>>();
  const upload = async (item: Extract<ImportItem, { kind: "message" }>, fileIndex: number) => {
    let mailboxId: string;
    try {
      mailboxId = await folders.resolve(options.keepFolders ? item.folder : []);
    } catch (error) {
      if (isAbort(error)) throw error;
      fail(item.label, error instanceof Error ? error.message : String(error));
      handled({ fileIndex, index: item.index });
      return;
    }
    const file = new File([item.data], "message.eml", { type: "message/rfc822" });
    for (let attempt = 0; ; attempt++) {
      await waitWhilePaused();
      try {
        const { blobId } = await client.uploadBlob(file, { accountId, signal });
        enqueue({
          index: item.index,
          fileIndex,
          label: item.label,
          entry: { blobId, mailboxIds: { [mailboxId]: true }, keywords: item.keywords, receivedAt: item.receivedAt },
        });
        return;
      } catch (error) {
        if (isAbort(error) || signal.aborted) throw new ImportCancelled();
        const { status, body } = uploadErrorInfo(error);
        if (status === 429) {
          pausedUntil = Math.max(pausedUntil, uploadWindowEnd(now()) + 5000);
          progress.quota = quotaFrom(body);
          continue;
        }
        if (status === 413 || (status === 400 && /maxSizeUpload/.test(body))) {
          skip("too_large");
          handled({ fileIndex, index: item.index });
          return;
        }
        if (attempt < UPLOAD_RETRY_DELAYS_MS.length) {
          await sleep(UPLOAD_RETRY_DELAYS_MS[attempt], signal);
          continue;
        }
        fail(item.label, status ? `HTTP ${status}` : body);
        handled({ fileIndex, index: item.index });
        return;
      }
    }
  };

  const startUpload = async (item: Extract<ImportItem, { kind: "message" }>, fileIndex: number) => {
    while (running.size >= lanes) await Promise.race(running);
    if (signal.aborted) throw new ImportCancelled();
    // A lane never rejects: a cancel shows in `signal`, anything else is a failure of this message.
    const task: Promise<void> = upload(item, fileIndex)
      .catch((error) => {
        if (!isAbort(error) && !signal.aborted) {
          fail(item.label, error instanceof Error ? error.message : String(error));
          handled({ fileIndex, index: item.index });
        }
      })
      .finally(() => { running.delete(task); });
    running.add(task);
  };

  try {
    for (let f = 0; f < options.files.length; f++) {
      const { file, format } = options.files[f];
      const checkpoint = options.resume ? await readCheckpoint(keys[f]) : null;
      if (!options.resume) await deleteCheckpoint(keys[f]);
      const skipBefore = checkpoint?.done ?? 0;
      if (checkpoint) { progress.imported += checkpoint.imported; importedPerFile[f] = checkpoint.imported; }
      marks.push(new Watermark(skipBefore));
      progress.fileName = file.name;
      const sourceOptions: SourceOptions = {
        maxMessageBytes: maxSize,
        skipBefore,
        signal,
        onProgress: (fraction) => { fileFraction[f] = fraction; setFraction(); report(); },
        onTotal: (count) => {
          totals[f] = count;
          if (totals.every((t) => t !== undefined)) progress.total = totals.reduce((a: number, b) => a + (b ?? 0), 0);
          report();
        },
      };
      let source: ItemSource;
      if (format === "pst") {
        if (!options.openPst) throw new Error("PST import isn't available");
        source = options.openPst(file, sourceOptions);
      } else if (format === "mbox") source = mboxSource(file, sourceOptions);
      else if (format === "zip") source = zipSource(file, sourceOptions);
      else source = emlSource(file, sourceOptions);

      try {
        for await (const item of source) {
          if (signal.aborted) throw new ImportCancelled();
          if (item.kind === "skipped") {
            // Items an earlier run handled are already counted in its imported total.
            if (item.reason !== "resumed") skip(item.reason);
            handled({ fileIndex: f, index: item.index });
            continue;
          }
          if (item.embeddedSkipped) skip("embedded", item.embeddedSkipped);
          await startUpload(item, f);
          report();
        }
      } finally {
        await source.return?.(undefined);
      }
      fileFraction[f] = 1;
      setFraction();
    }
    while (running.size > 0) await Promise.race(running);
    if (signal.aborted) throw new ImportCancelled();
    await flush();
    await importing;
    progress.phase = "done";
    progress.fraction = 1;
    progress.pausedUntil = undefined;
    await Promise.all(keys.map((k) => deleteCheckpoint(k)));
  } catch (error) {
    // Let the uploads in flight end (they were aborted) and keep what got imported.
    await Promise.allSettled([...running]);
    await flush().catch(() => {});
    await importing.catch(() => {});
    await saveCheckpoints(true).catch(() => {});
    progress.pausedUntil = undefined;
    if (isAbort(error) || signal.aborted) {
      progress.phase = "cancelled";
    } else {
      progress.phase = "failed";
      progress.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (flushTimer) clearTimeout(flushTimer);
  }
  report(true);
  return progress;
}
