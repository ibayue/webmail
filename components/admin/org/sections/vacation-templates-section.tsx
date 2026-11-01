'use client';

import { SettingsSection } from '@/components/settings/settings-section';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

/**
 * Placeholder from the enterprise-pack foundation, replaced by package D:
 * Out-of-office reply texts users can pick.
 */
export function VacationTemplatesSection({ draft }: { draft: OrgPolicyDraft }) {
  void draft;
  return <SettingsSection id="vacation-templates" title="Out-of-office replies" description="Not set up yet.">{null}</SettingsSection>;
}
