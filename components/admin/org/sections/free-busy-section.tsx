'use client';

import { SettingsSection } from '@/components/settings/settings-section';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

/**
 * Placeholder from the enterprise-pack foundation, replaced by package B:
 * A group that gets free/busy access to every user's default calendar.
 */
export function FreeBusySection({ draft }: { draft: OrgPolicyDraft }) {
  void draft;
  return <SettingsSection id="free-busy" title="Free/busy sharing" description="Not set up yet.">{null}</SettingsSection>;
}
