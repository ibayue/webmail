import { itemKind, pstFolders, readPstMessage, type PstFolderRef } from "./extract";
import { buildMime } from "./mime";
import type { SkipReason } from "../sources";

/** One PST item as the worker hands it over: a message's MIME, or why it was skipped. */
export type PstItem =
  | {
      kind: "message";
      index: number;
      folder: string[];
      mime: Uint8Array;
      keywords: Record<string, true>;
      receivedAt?: string;
      label: string;
      embeddedSkipped: number;
    }
  | { kind: "skipped"; index: number; reason: SkipReason; label?: string };

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PstWalk {
  /** Items in the folders that are read (an estimate: Outlook keeps the count). */
  total: number;
  items: Generator<PstItem>;
}

function utcDate(date: Date | undefined): string | undefined {
  if (!date || Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function walkPst(pst: any, options: { skipBefore: number; maxMessageBytes: number; boundarySeed?: string }): PstWalk {
  const folders: PstFolderRef[] = [...pstFolders(pst)];
  const total = folders.reduce((n, f) => n + (Number(f.folder.contentCount) || 0), 0);

  function* items(): Generator<PstItem> {
    let index = 0;
    for (const ref of folders) {
      if (!(Number(ref.folder.contentCount) > 0)) continue;
      for (;;) {
        let child: any;
        try {
          child = ref.folder.getNextChild();
        } catch {
          // A broken item ends this folder's list in pst-extractor; go on with the next folder.
          break;
        }
        if (!child) break;
        const i = index++;
        if (i < options.skipBefore) {
          yield { kind: "skipped", index: i, reason: "resumed" };
          continue;
        }
        const kind = itemKind(String(child.messageClass || ""));
        const label = String(child.subject || "");
        if (kind !== "mail") {
          yield { kind: "skipped", index: i, reason: kind, label };
          continue;
        }
        let mime: Uint8Array;
        let read;
        try {
          read = readPstMessage(child);
          mime = buildMime(read.mail, { boundarySeed: options.boundarySeed });
        } catch {
          yield { kind: "skipped", index: i, reason: "other", label };
          continue;
        }
        if (mime.length > options.maxMessageBytes) {
          yield { kind: "skipped", index: i, reason: "too_large", label };
          continue;
        }
        yield {
          kind: "message",
          index: i,
          folder: ref.path,
          mime,
          keywords: read.keywords,
          receivedAt: utcDate(read.receivedAt),
          label,
          embeddedSkipped: read.embedded,
        };
      }
    }
  }
  return { total, items: items() };
}
