"use client";

import { useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2, Pause } from "@/components/icons";
import { isJobActive, useMailTransferStore } from "@/stores/mail-transfer-store";
import { onBeforeSignOut } from "@/lib/sign-out-cleanup";
import { clearCheckpointsFor } from "@/lib/mail-import/checkpoints";
import { MailImportDialog } from "./mail-import-dialog";
import { formatClock } from "./transfer-progress";

/**
 * Draws the mail import dialog, and while it is hidden with a job running,
 * a chip in the corner that shows the progress and brings it back. Mounted
 * with the app, so a job outlives the menu or settings page that started it.
 */
export function MailTransferHost() {
  const request = useMailTransferStore((s) => s.request);
  const visible = useMailTransferStore((s) => s.visible);
  const job = useMailTransferStore((s) => s.job);

  // An account that signs out takes its running job and its checkpoints with it.
  useEffect(() => onBeforeSignOut(async (accountId) => {
    useMailTransferStore.getState().cancelJob();
    if (accountId !== "all") await clearCheckpointsFor(accountId);
  }), []);

  return (
    <>
      {request?.kind === "import" && <MailImportDialog request={request} />}
      {!visible && isJobActive(job) && <TransferChip />}
    </>
  );
}

function TransferChip() {
  const t = useTranslations("mail_import");
  const locale = useLocale();
  const job = useMailTransferStore((s) => s.job);
  const show = useMailTransferStore((s) => s.show);
  if (!job) return null;
  const p = job.progress;
  const paused = p.phase === "paused" && p.pausedUntil;
  const label = paused
    ? t("chip_paused", { time: formatClock(p.pausedUntil!, locale) })
    : t("chip", { percent: Math.round(p.fraction * 100) });
  return (
    <button
      type="button"
      onClick={show}
      className="fixed bottom-4 end-4 z-50 flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm shadow-lg hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
      data-testid="mail-transfer-chip"
    >
      {paused ? <Pause className="size-4 shrink-0 text-amber-600" aria-hidden="true" /> : <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />}
      <span className="truncate">{label}</span>
    </button>
  );
}
