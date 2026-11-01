'use client';

import { PluginSlot } from '@/components/plugins/plugin-slot';
import { OrgAnnouncement } from '@/components/org/org-announcement';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';

/**
 * Mounts the `app-top-banner` plugin slot with the current session's
 * username, serverUrl and whether an admin opened it through an
 * impersonation handoff (`impersonated`). Drop this at the top of every
 * authenticated page so plugins like impersonation-notice render
 * everywhere, not just on the mail page. The organisation's announcement
 * (Organisation > Notices) shows here too, above the plugins' banners.
 */
export function AppTopBannerSlot() {
  const username = useAuthStore((s) => s.username);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const impersonated = useAccountStore(
    (s) => s.accounts.find((a) => a.id === s.activeAccountId)?.impersonated === true,
  );
  return (
    <>
      <OrgAnnouncement />
      <PluginSlot name="app-top-banner" extraProps={{ username, serverUrl, impersonated }} />
    </>
  );
}
