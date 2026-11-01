'use client';

import { SettingsSection } from '@/components/settings/settings-section';
import type { OrgPolicyDraft } from '../use-org-policy-draft';

/**
 * Placeholder from the enterprise-pack foundation, replaced by package D:
 * Device gates: downloads, export, printing, install prompt, push text, watermark.
 */
export function DevicesSection({ draft }: { draft: OrgPolicyDraft }) {
  void draft;
  return <SettingsSection id="devices" title="Downloads, printing and notifications" description="Not set up yet.">{null}</SettingsSection>;
}
