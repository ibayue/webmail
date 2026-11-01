'use client';

import { useTranslations } from 'next-intl';
import { CloudOff } from '@/components/icons';
import { useRouter } from '@/i18n/navigation';
import { buildSettingsPath } from '@/lib/deep-links';
import { IS_LITE } from '@/lib/lite';
import { useOfflineStore } from '@/lib/offline/state';
import { useAuthStore } from '@/stores/auth-store';

/**
 * A strip across the top of the apps while offline mode (#523) answers from
 * this device: the app is offline, and how many messages wait in the
 * outbox (a link to it). Shown only for an account that keeps mail here.
 */
export function OfflineBanner() {
  const t = useTranslations('offline.banner');
  const router = useRouter();
  const account = useAuthStore((s) => s.activeAccountId);
  const active = useOfflineStore((s) => !!account && s.enabled.includes(account));
  const offline = useOfflineStore((s) => s.browserOffline || s.networkDown || s.startedOffline);
  const waiting = useOfflineStore((s) => s.outbox.length);
  if (IS_LITE || !active || (!offline && waiting === 0)) return null;
  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted px-3 py-2 text-sm text-foreground sm:px-4"
    >
      {offline && (
        <span className="flex min-w-0 items-start gap-2">
          <CloudOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{t('offline')}</span>
        </span>
      )}
      {waiting > 0 && (
        <button
          type="button"
          data-testid="offline-banner-outbox"
          onClick={() => router.push(buildSettingsPath('backup', 'offline'))}
          className="min-h-11 rounded-md px-1 font-medium underline underline-offset-2 hover:bg-foreground/5 sm:min-h-0"
        >
          {t('outbox', { count: waiting })}
        </button>
      )}
    </div>
  );
}
