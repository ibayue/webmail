'use client';

import { SettingsSection } from '@/components/settings/settings-section';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

/**
 * Placeholder from the enterprise-pack foundation, replaced by package F:
 * Whether users may keep mail on their device (devices.noOffline).
 */
export function OfflineSection({ draft }: { draft: OrgPolicyDraft }) {
  void draft;
  return <SettingsSection id="offline" title="Offline mode" description="Not set up yet.">{null}</SettingsSection>;
}
