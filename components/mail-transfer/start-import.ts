import { runImport, type ImportFile } from "@/lib/mail-import/engine";
import { useAuthStore } from "@/stores/auth-store";
import { useEmailStore } from "@/stores/email-store";
import { useMailTransferStore } from "@/stores/mail-transfer-store";

export interface StartImportInput {
  files: ImportFile[];
  /** JMAP account of the target. */
  accountId: string;
  /** null = the top level (with keepFolders). */
  targetMailboxId: string | null;
  keepFolders: boolean;
  resume: boolean;
}

/** Runs an import as the dialog's job and refreshes the mail lists when it ends. */
export function startImport(input: StartImportInput): void {
  const auth = useAuthStore.getState();
  const client = auth.client;
  if (!client) return;
  const store = useMailTransferStore.getState();
  const controller = new AbortController();
  store.startJob({
    kind: "import",
    controller,
    progress: { phase: "running", imported: 0, failed: 0, skipped: {}, failures: [], fraction: 0, foldersCreated: 0 },
  });
  void (async () => {
    const result = await runImport({
      client,
      accountId: input.accountId,
      targetMailboxId: input.targetMailboxId,
      keepFolders: input.keepFolders,
      files: input.files,
      scope: auth.activeAccountId ?? "default",
      resume: input.resume,
      signal: controller.signal,
      onProgress: (progress) => useMailTransferStore.getState().updateProgress(progress),
    });
    useMailTransferStore.getState().updateProgress(result);
    // Show what arrived, if the same account is still the one on screen.
    if (useAuthStore.getState().client !== client || result.imported === 0) return;
    const email = useEmailStore.getState();
    try {
      await email.fetchMailboxes(client);
      await email.fetchEmails(client, email.selectedMailbox || undefined, { background: true });
    } catch {
      /* the next refresh shows them */
    }
  })();
}
