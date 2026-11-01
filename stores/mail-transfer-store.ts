import { create } from "zustand";
import type { ImportProgress } from "@/lib/mail-import/engine";
import type { ExportProgress } from "@/lib/mail-export/engine";

/**
 * The mail import and export dialog: what it was opened for, whether it is
 * on screen, and the job it runs. A job keeps running while the dialog is
 * hidden ("Run in background"); a small chip then shows its progress and
 * brings the dialog back. One job at a time.
 */

export interface ImportRequest {
  kind: "import";
  /** The folder it was opened from (its id in the mail store), if any. */
  mailboxId?: string;
}

export interface ExportRequest {
  kind: "export";
  /** A folder (its id in the mail store), or the whole account when absent. */
  mailboxId?: string;
}

export type TransferRequest = ImportRequest | ExportRequest;

export type TransferJob =
  | { kind: "import"; progress: ImportProgress; controller: AbortController }
  | { kind: "export"; progress: ExportProgress; controller: AbortController };

interface MailTransferState {
  request: TransferRequest | null;
  visible: boolean;
  job: TransferJob | null;
  /** Opens the dialog; false when a job is running already (it is shown instead). */
  open: (request: TransferRequest) => boolean;
  /** Hides the dialog; a running job goes on. */
  hide: () => void;
  show: () => void;
  /** Closes the dialog and forgets a finished job (an export's private file is deleted). */
  close: () => void;
  startJob: (job: TransferJob) => void;
  updateProgress: (progress: ImportProgress | ExportProgress) => void;
  cancelJob: () => void;
}

export function isJobActive(job: TransferJob | null): boolean {
  return !!job && (job.progress.phase === "running" || job.progress.phase === "paused");
}

function discardExport(job: TransferJob | null): void {
  if (job?.kind === "export") void job.progress.file?.discard().catch(() => {});
}

export const useMailTransferStore = create<MailTransferState>()((set, get) => ({
  request: null,
  visible: false,
  job: null,
  open: (request) => {
    if (isJobActive(get().job)) {
      set({ visible: true });
      return false;
    }
    discardExport(get().job);
    set({ request, visible: true, job: null });
    return true;
  },
  hide: () => set({ visible: false }),
  show: () => set({ visible: true }),
  close: () => {
    if (isJobActive(get().job)) {
      set({ visible: false });
      return;
    }
    discardExport(get().job);
    set({ request: null, visible: false, job: null });
  },
  startJob: (job) => set({ job }),
  updateProgress: (progress) => {
    const job = get().job;
    if (job) set({ job: { ...job, progress } as TransferJob });
  },
  cancelJob: () => get().job?.controller.abort(),
}));

/** Opens the import dialog, for a folder or (from Settings) for none. */
export function openMailImport(request: Omit<ImportRequest, "kind"> = {}): void {
  useMailTransferStore.getState().open({ kind: "import", ...request });
}

/** Opens the export dialog for a folder, or for the whole account. */
export function openMailExport(request: Omit<ExportRequest, "kind"> = {}): void {
  useMailTransferStore.getState().open({ kind: "export", ...request });
}
