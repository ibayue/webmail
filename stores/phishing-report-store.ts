import { create } from 'zustand';
import type { Email } from '@/lib/jmap/types';

/**
 * The "Report phishing?" question waiting for an answer. Any menu or
 * toolbar asks through `requestPhishingReport`; the one host mounted in the
 * app layout (components/email/phishing-report-host.tsx) shows the dialog,
 * sends the reports and shows the outcome.
 */
interface PhishingReportState {
  pending: { emails: Email[]; address: string } | null;
  /** The reports are on their way; the dialog stays open and can't be sent twice. */
  busy: boolean;
  /** Where the focus goes back to when the dialog closes. */
  opener: HTMLElement | null;
  ask: (emails: Email[], address: string) => void;
  close: () => void;
  setBusy: (busy: boolean) => void;
}

export const usePhishingReportStore = create<PhishingReportState>()((set, get) => ({
  pending: null,
  busy: false,
  opener: null,
  ask: (emails, address) => {
    if (get().busy || emails.length === 0) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    set({ pending: { emails, address }, opener: active instanceof HTMLElement ? active : null });
  },
  close: () => {
    const { opener } = get();
    set({ pending: null, busy: false, opener: null });
    if (opener?.isConnected) opener.focus();
  },
  setBusy: (busy) => set({ busy }),
}));
