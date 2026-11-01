'use client';

import { SettingsSection } from '@/components/settings/settings-section';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

/**
 * Placeholder from the enterprise-pack foundation, replaced by package D:
 * How long Trash and Junk keep mail, as set in the mail server.
 */
export function RetentionSection({ draft }: { draft: OrgPolicyDraft }) {
  void draft;
  return <SettingsSection id="retention" title="Trash and Junk" description="Not set up yet.">{null}</SettingsSection>;
}
