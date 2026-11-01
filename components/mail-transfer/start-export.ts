import { runExport, folderTree, type ExportFolder, type ExportFormat } from "@/lib/mail-export/engine";
import type { ExportSink } from "@/lib/mail-export/sinks";
import { useAuthStore } from "@/stores/auth-store";
import { useMailTransferStore } from "@/stores/mail-transfer-store";

export interface StartExportInput {
  format: ExportFormat;
  /** JMAP account of the folder (or of the whole export). */
  accountId: string;
  /** One folder (its id in its account); the whole account when absent. */
  mailboxId?: string;
  sink: ExportSink;
}

/** Runs an export as the dialog's job. */
export function startExport(input: StartExportInput): void {
  const client = useAuthStore.getState().client;
  if (!client) return;
  const controller = new AbortController();
  useMailTransferStore.getState().startJob({
    kind: "export",
    controller,
    progress: { phase: "running", exported: 0, failed: 0, failures: [], total: 0, fraction: 0 },
  });
  void (async () => {
    let folders: ExportFolder[];
    try {
      folders = input.mailboxId
        ? [{ mailboxId: input.mailboxId, path: [] }]
        : folderTree(await client.getMailboxes(input.accountId));
    } catch (error) {
      await input.sink.abort().catch(() => {});
      useMailTransferStore.getState().updateProgress({
        phase: "failed", exported: 0, failed: 0, failures: [], total: 0, fraction: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const result = await runExport({
      client,
      accountId: input.accountId,
      folders,
      format: input.format,
      sink: input.sink,
      signal: controller.signal,
      onProgress: (progress) => useMailTransferStore.getState().updateProgress(progress),
    });
    useMailTransferStore.getState().updateProgress(result);
  })();
}
