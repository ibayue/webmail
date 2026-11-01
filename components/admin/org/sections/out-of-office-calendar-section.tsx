'use client';

import { SettingsSection } from '@/components/settings/settings-section';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

/**
 * Placeholder from the enterprise-pack foundation, replaced by package B:
 * Whether an out-of-office reply blocks the calendar (restriction vacationBlockCalendar).
 */
export function OutOfOfficeCalendarSection({ draft }: { draft: OrgPolicyDraft }) {
  void draft;
  return <SettingsSection id="out-of-office" title="Out-of-office" description="Not set up yet.">{null}</SettingsSection>;
}
