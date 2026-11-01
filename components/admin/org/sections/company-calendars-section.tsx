'use client';

import { SettingsSection } from '@/components/settings/settings-section';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

/**
 * Placeholder from the enterprise-pack foundation, replaced by package B:
 * ICS feeds every user in scope sees read-only.
 */
export function CompanyCalendarsSection({ draft }: { draft: OrgPolicyDraft }) {
  void draft;
  return <SettingsSection id="company-calendars" title="Company calendars" description="Not set up yet.">{null}</SettingsSection>;
}
