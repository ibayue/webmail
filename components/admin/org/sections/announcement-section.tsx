'use client';

import { SettingsSection } from '@/components/settings/settings-section';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

/**
 * Placeholder from the enterprise-pack foundation, replaced by package D:
 * An announcement across the apps.
 */
export function AnnouncementSection({ draft }: { draft: OrgPolicyDraft }) {
  void draft;
  return <SettingsSection id="announcement" title="Announcement" description="Not set up yet.">{null}</SettingsSection>;
}
