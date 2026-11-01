'use client';

import { useCallback, useMemo } from 'react';
import type { Email } from '@/lib/jmap/types';
import { isReportable } from '@/lib/phishing-report';
import { phishingSetupForEmail } from '@/lib/phishing-report-flow';
import { useAccountSubjects } from '@/lib/org/account-subjects';
import { usePolicyStore } from '@/stores/policy-store';
import { usePhishingReportStore } from '@/stores/phishing-report-store';

/** Asks "Report phishing?" for the messages of `emails` that can be reported. */
export function requestPhishingReport(emails: Email[], mailboxRole?: string | null): void {
  const reportable = emails.filter((email) => isReportable(email, mailboxRole) && phishingSetupForEmail(email));
  if (reportable.length === 0) return;
  usePhishingReportStore.getState().ask(reportable, phishingSetupForEmail(reportable[0])!.address);
}

/**
 * "Report phishing" for a set of messages in a folder of `mailboxRole`:
 * available while the admin set an address for at least one of their
 * accounts and one of them can be reported. Follows the policy as it loads.
 */
export function usePhishingReport(emails: ReadonlyArray<Email | null | undefined>, mailboxRole?: string | null) {
  const policy = usePolicyStore((s) => s.policy);
  const rawPolicy = usePolicyStore((s) => s.rawPolicy);
  const subjects = useAccountSubjects((s) => s.subjects);
  const list = useMemo(() => emails.filter((e): e is Email => !!e), [emails]);
  const reportable = useMemo(
    () => list.filter((email) => isReportable(email, mailboxRole) && !!phishingSetupForEmail(email)),
    // The setup is read from the stores these follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [list, mailboxRole, policy, rawPolicy, subjects],
  );
  const report = useCallback(() => requestPhishingReport(reportable, mailboxRole), [reportable, mailboxRole]);
  return { available: reportable.length > 0, count: reportable.length, report };
}
