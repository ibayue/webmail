'use client';

import { SettingsSection } from '@/components/settings/settings-section';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

/**
 * Placeholder from the enterprise-pack foundation, replaced by package A:
 * Classification labels, their default, and whether a label is required.
 */
export function LabelsSection({ draft }: { draft: OrgPolicyDraft }) {
  void draft;
  return <SettingsSection id="labels" title="Classification labels" description="Not set up yet.">{null}</SettingsSection>;
}
