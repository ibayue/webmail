'use client';

import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertCircle, AlertTriangle, Info, X } from '@/components/icons';
import { usePolicyRefresh } from '@/hooks/use-policy-refresh';
import {
  announcementActive,
  announcementKey,
  announcementParts,
  announcementText,
  dismissAnnouncement,
  isAnnouncementDismissed,
  nextAnnouncementChange,
} from '@/lib/org-announcement';
import { resolveExternalLink } from '@/lib/plugin-hook-result';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';

/** Timers longer than this are re-armed (setTimeout overflows past ~24.8 days). */
const MAX_TIMER_MS = 6 * 60 * 60 * 1000;

/**
 * Announcements already read out on this page load. Every app mounts the
 * strip anew on navigation; a screen reader hears it once, after that the
 * strip is a plain region.
 */
const announced = new Set<string>();

const STYLES = {
  info: 'bg-muted/60 border-border text-foreground',
  warning: 'bg-amber-500/10 border-amber-500/30 text-amber-800 dark:text-amber-200',
  critical: 'bg-destructive/10 border-destructive/30 text-destructive',
} as const;

const ICONS = { info: Info, warning: AlertTriangle, critical: AlertCircle } as const;

/** Re-renders when the announcement starts or ends. */
function useNow(change: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (change === null) return;
    const wait = Math.min(MAX_TIMER_MS, Math.max(0, change - Date.now()) + 50);
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [change, now]);
  return now;
}

function openLink(event: MouseEvent<HTMLAnchorElement>, href: string) {
  if (event.type === 'auxclick' && event.button !== 1) return;
  event.preventDefault();
  void resolveExternalLink({ href, target: '_blank' }).then((target) => {
    if (target) window.open(target, '_blank', 'noopener,noreferrer');
  });
}

/**
 * The admin's announcement (Organisation > Notices), as a strip across the
 * top of every app: mail, calendar, contacts, files, settings and plugin
 * pages (it renders inside AppTopBannerSlot). Plain text; links open
 * through the same link check as links in mail.
 */
export function OrgAnnouncement() {
  usePolicyRefresh();
  const t = useTranslations('org_notice');
  const locale = useLocale();
  const announcement = usePolicyStore((s) => s.policy.organisation?.announcement);
  const accountId = useAuthStore((s) => s.activeAccountId);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const text = announcement ? announcementText(announcement, locale) : '';
  const now = useNow(text ? nextAnnouncementChange(announcement, Date.now()) : null);
  const key = announcement && text ? announcementKey(announcement) : null;
  const active = !!key && announcementActive(announcement, now);
  const dismissed = !!key && !!announcement?.dismissible
    && (dismissedKey === `${accountId}|${key}` || isAnnouncementDismissed(announcement!, accountId));

  const parts = useMemo(() => announcementParts(text), [text]);
  const firstShow = useMemo(() => !!key && !announced.has(key), [key]);
  const visible = active && !dismissed;
  useEffect(() => {
    if (visible && key) announced.add(key);
  }, [visible, key]);

  if (!visible || !announcement) return null;
  const severity = announcement.severity in STYLES ? announcement.severity : 'info';
  const Icon = ICONS[severity];
  const role = firstShow ? (severity === 'critical' ? 'alert' : 'status') : 'region';

  return (
    <div
      role={role}
      aria-label={role === 'region' ? t('label') : undefined}
      data-testid="org-announcement"
      data-severity={severity}
      className={cn('flex shrink-0 items-start gap-2 border-b px-3 text-sm sm:px-4', STYLES[severity])}
    >
      <Icon className="mt-3 h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 whitespace-pre-line break-words py-2.5 leading-snug [overflow-wrap:anywhere]">
        <span className="sr-only">{t(`severity_${severity}`)}: </span>
        {parts.map((part, index) => part.kind === 'link' ? (
          <a
            key={index}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline underline-offset-2"
            onClick={(e) => openLink(e, part.href)}
            onAuxClick={(e) => openLink(e, part.href)}
          >
            {part.href}
          </a>
        ) : (
          <span key={index}>{part.text}</span>
        ))}
      </p>
      {announcement.dismissible && (
        <button
          type="button"
          onClick={() => {
            dismissAnnouncement(announcement, accountId);
            setDismissedKey(`${accountId}|${key}`);
          }}
          aria-label={t('dismiss')}
          title={t('dismiss')}
          data-testid="org-announcement-dismiss"
          className="-me-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
