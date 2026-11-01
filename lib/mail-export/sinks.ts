/**
 * Where an export's bytes go, so a large mailbox never has to fit in memory:
 *
 * 1. File System Access (Chrome, Edge): the user picks the file first and the
 *    export writes straight into it.
 * 2. The origin private file system (Firefox, Safari): written to a private
 *    file on disk, then downloaded. The file is deleted when the dialog
 *    closes, on sign-out, and by a sweep when the next export starts.
 * 3. Memory, for small exports only, where neither exists.
 *
 * Writes are gathered into 1 MB pieces: a message arrives in many small parts.
 */

export interface ExportFile {
  name: string;
  size: number;
  /** Saves the file (again) where the browser keeps downloads; absent when the user picked the place. */
  download?: () => void;
  /** Frees what the export kept in this browser. */
  discard: () => Promise<void>;
}

export interface ExportSink {
  kind: "picker" | "private" | "memory";
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<ExportFile>;
  abort(): Promise<void>;
}

export class ExportTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The export is larger than this browser can keep in memory (${limit} bytes)`);
    this.name = "ExportTooLargeError";
  }
}

/** The most a memory-only export may hold. */
export const MEMORY_EXPORT_LIMIT = 200 * 1024 * 1024;
const PRIVATE_DIR = "bulwark-exports";
const FLUSH_BYTES = 1 << 20;

interface WritableLike {
  write(data: BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

/** Gathers small writes and passes them on in pieces of about 1 MB. */
function buffered(write: (chunk: Uint8Array) => Promise<void>) {
  let parts: Uint8Array[] = [];
  let size = 0;
  let total = 0;
  const flush = async () => {
    if (size === 0) return;
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    parts = [];
    size = 0;
    await write(out);
  };
  return {
    async write(chunk: Uint8Array) {
      if (chunk.length === 0) return;
      // The caller may reuse its buffer: keep a copy until it's written.
      parts.push(chunk.slice());
      size += chunk.length;
      total += chunk.length;
      if (size >= FLUSH_BYTES) await flush();
    },
    flush,
    get total() { return total; },
  };
}

function triggerDownload(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

type SavePicker = (options: { suggestedName?: string; types?: { description?: string; accept: Record<string, string[]> }[] }) => Promise<{ createWritable(): Promise<WritableLike> }>;

export function canPickSaveFile(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";
}

/**
 * Asks where to save (call it straight from the click, before any await:
 * the browser only shows the picker for a user action). Rejects with an
 * AbortError when the user closes the picker.
 */
export async function pickSaveFile(name: string, mime: string, extension: string): Promise<ExportSink> {
  const picker = (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker;
  const handle = await picker({ suggestedName: name, types: [{ accept: { [mime]: [extension] } }] });
  const writable = await handle.createWritable();
  const buf = buffered((chunk) => writable.write(chunk as BufferSource));
  return {
    kind: "picker",
    write: (chunk) => buf.write(chunk),
    close: async () => {
      await buf.flush();
      await writable.close();
      return { name, size: buf.total, discard: async () => {} };
    },
    abort: async () => { await writable.abort().catch(() => {}); },
  };
}

async function privateDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    return root ? await root.getDirectoryHandle(PRIVATE_DIR, { create: true }) : null;
  } catch {
    return null;
  }
}

/** A private file on disk, downloaded when done; null where the browser can't write one from the page. */
export async function privateFileSink(name: string, mime: string): Promise<ExportSink | null> {
  const dir = await privateDir();
  if (!dir) return null;
  const entry = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let handle: FileSystemFileHandle;
  let writable: WritableLike;
  try {
    handle = await dir.getFileHandle(entry, { create: true });
    const create = (handle as unknown as { createWritable?: () => Promise<WritableLike> }).createWritable;
    if (typeof create !== "function") {
      await dir.removeEntry(entry).catch(() => {});
      return null;
    }
    writable = await create.call(handle);
  } catch {
    await dir.removeEntry(entry).catch(() => {});
    return null;
  }
  const buf = buffered((chunk) => writable.write(chunk as BufferSource));
  const remove = () => dir.removeEntry(entry).catch(() => {});
  return {
    kind: "private",
    write: (chunk) => buf.write(chunk),
    close: async () => {
      await buf.flush();
      await writable.close();
      const file = await handle.getFile();
      const url = URL.createObjectURL(new Blob([file], { type: mime }));
      triggerDownload(url, name);
      return {
        name,
        size: file.size,
        download: () => triggerDownload(url, name),
        discard: async () => { URL.revokeObjectURL(url); await remove(); },
      };
    },
    abort: async () => { await writable.abort().catch(() => {}); await remove(); },
  };
}

/** Everything in memory, then downloaded: only for small exports. */
export function memorySink(name: string, mime: string, limit = MEMORY_EXPORT_LIMIT): ExportSink {
  let parts: Uint8Array[] = [];
  let size = 0;
  return {
    kind: "memory",
    write: async (chunk) => {
      size += chunk.length;
      if (size > limit) throw new ExportTooLargeError(limit);
      parts.push(chunk.slice());
    },
    close: async () => {
      const blob = new Blob(parts as BlobPart[], { type: mime });
      parts = [];
      const url = URL.createObjectURL(blob);
      triggerDownload(url, name);
      return { name, size: blob.size, download: () => triggerDownload(url, name), discard: async () => URL.revokeObjectURL(url) };
    },
    abort: async () => { parts = []; },
  };
}

/** Deletes private export files left behind (a closed tab, a crash). */
export async function sweepPrivateExports(): Promise<void> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    await root?.removeEntry(PRIVATE_DIR, { recursive: true });
  } catch {
    /* nothing there */
  }
}
