'use client';

import { useMemo, useState } from 'react';
import type { ClassificationLabel } from '@/lib/admin/organisation-policy';
import { useAccountSubjects } from '@/lib/org/account-subjects';
import { labelsPolicyFor, resolveLabel, labelMissing } from '@/lib/outgoing/classification';
import type { LabelsPolicy } from '@/lib/classification/labels';
import { usePolicyStore } from '@/stores/policy-store';

export interface ComposerClassification {
  policy: LabelsPolicy;
  /** The label the message goes out with as things stand. */
  label: ClassificationLabel | null;
  /** The user's pick: an id, null for none, undefined for "not picked" (original's or default). */
  choice: string | null | undefined;
  setChoice: (choice: string | null) => void;
  /** Sending needs a label and there is none. */
  missing: boolean;
  /** What a saved draft keeps (X-Bulwark-Label); undefined while labels are off. */
  draftChoice: string | null | undefined;
}

/**
 * The composer's classification label: the labels of the account and
 * identity the message goes out from, the user's pick, else the original's
 * label (replies and forwards), else the default. Follows the policy as it
 * loads and the From as it changes.
 */
export function useComposerClassification(input: {
  accountId: string | null | undefined;
  senderEmail: string | undefined;
  /** The original's headers, for a reply or forward. */
  originalHeaders?: Record<string, string | string[]> | null;
  initialChoice?: string | null;
}): ComposerClassification {
  const policyState = usePolicyStore((s) => s.policy);
  const rawPolicy = usePolicyStore((s) => s.rawPolicy);
  const subjects = useAccountSubjects((s) => s.subjects);
  const [choice, setChoice] = useState<string | null | undefined>(input.initialChoice);
  const policy = useMemo(
    () => labelsPolicyFor({ email: input.senderEmail, accountId: input.accountId }),
    // Re-read from the stores these follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input.senderEmail, input.accountId, policyState, rawPolicy, subjects],
  );
  const label = useMemo(() => resolveLabel(policy, choice, input.originalHeaders), [policy, choice, input.originalHeaders]);
  return {
    policy,
    label,
    choice,
    setChoice,
    missing: labelMissing(policy, label),
    draftChoice: policy.list.length === 0 ? undefined : (label?.id ?? null),
  };
}
