'use client';

import { SettingsSection } from '@/components/settings/settings-section';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

/**
 * Placeholder from the enterprise-pack foundation, replaced by package A:
 * Report phishing: where reports go and in which format.
 */
export function PhishingReportSection({ draft }: { draft: OrgPolicyDraft }) {
  void draft;
  return <SettingsSection id="phishing" title="Phishing reports" description="Not set up yet.">{null}</SettingsSection>;
}
