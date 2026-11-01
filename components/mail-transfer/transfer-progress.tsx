"use client";

import { cn } from "@/lib/utils";

/** The bar of an import or export, 0 to 1; indeterminate while nothing is known. */
export function TransferBar({ fraction, label, paused }: { fraction: number | null; label: string; paused?: boolean }) {
  const percent = fraction === null ? null : Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="h-2 w-full rounded-full bg-primary/15 overflow-hidden"
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-300",
          paused ? "bg-amber-500" : "bg-primary",
          percent === null && "w-1/3 animate-pulse",
        )}
        style={percent === null ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

/** "14:00", or a date and time when the moment isn't today. */
export function formatClock(ms: number, locale: string, now = Date.now()): string {
  const date = new Date(ms);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { hour: "2-digit", minute: "2-digit" } : { dateStyle: "medium", timeStyle: "short" }).format(date);
}
