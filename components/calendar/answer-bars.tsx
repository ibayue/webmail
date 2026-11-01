"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/stores/auth-store";
import { useCalendarStore } from "@/stores/calendar-store";
import type { IJMAPClient } from "@/lib/jmap/client-interface";
import type { Calendar, CalendarEvent, CalendarParticipant, Principal } from "@/lib/jmap/types";
import { accountOwnerOf, resolveAnswerTargets, type AnswerTarget, type AnswerView } from "@/lib/calendar-delegate";
import { RsvpButtons } from "./rsvp-buttons";

type Status = CalendarParticipant["participationStatus"];

const owners = new WeakMap<IJMAPClient, Map<string, Promise<Principal | null>>>();

/** The principal behind a shared account, asked once per client. */
function loadAccountOwner(client: IJMAPClient, accountId: string): Promise<Principal | null> {
  let cache = owners.get(client);
  if (!cache) {
    cache = new Map();
    owners.set(client, cache);
  }
  let owner = cache.get(accountId);
  if (!owner) {
    owner = client.getAccountOwners
      ? client.getAccountOwners([accountId]).then((found) => found[accountId] ?? null).catch(() => null)
      : Promise.resolve(null);
    cache.set(accountId, owner);
  }
  return owner;
}

/**
 * The answer bars of an event: the user's own, and "Answer for <owner>" for
 * an invitation in a calendar shared with them by its owner
 * (lib/calendar-delegate.ts).
 */
export function useAnswerView(
  event: CalendarEvent | null,
  calendar: Calendar | null | undefined,
  userEmails: string[],
  canRsvpSelf: boolean,
): AnswerView {
  const client = useAuthStore((s) => s.client);
  const events = useCalendarStore((s) => s.events);
  const sharedAccountId = calendar?.isShared ? calendar.accountId ?? null : null;
  const [principal, setPrincipal] = useState<{ accountId: string; principal: Principal | null } | null>(null);

  useEffect(() => {
    if (!client || !sharedAccountId) return;
    let cancelled = false;
    void loadAccountOwner(client, sharedAccountId).then((found) => {
      if (!cancelled) setPrincipal({ accountId: sharedAccountId, principal: found });
    });
    return () => { cancelled = true; };
  }, [client, sharedAccountId]);

  return useMemo(() => {
    if (!event) return { targets: [], note: null, answeredBy: null };
    const owner = sharedAccountId
      ? accountOwnerOf(principal?.accountId === sharedAccountId ? principal.principal : null, calendar?.accountName)
      : null;
    const ownCopy = event.uid
      ? events.find((e) => e.uid === event.uid && !e.isShared && e.id !== event.id && !e.recurrenceId) ?? null
      : null;
    // Stalwart 1.0 lists principals:owner in every account; 0.16 never does.
    const server016 = !!client && !!sharedAccountId
      && !client.hasAccountCapability("urn:ietf:params:jmap:principals:owner", sharedAccountId);
    return resolveAnswerTargets({ event, calendar, userEmails, canRsvpSelf, owner, ownCopy, server016 });
  }, [event, calendar, userEmails, canRsvpSelf, sharedAccountId, principal, events, client]);
}

/**
 * The bars themselves: "Your response" and "Answer for <owner>", each with
 * accept, maybe and decline, and the line that says why there is no bar
 * for the owner, or who answered last for them.
 */
export function AnswerBars({ view, size, onRespond, className }: {
  view: AnswerView;
  size?: "xs";
  onRespond: (target: AnswerTarget, status: Status) => void;
  className?: string;
}) {
  const t = useTranslations("calendar");
  const tDelegate = useTranslations("calendar_delegate");
  if (view.targets.length === 0 && !view.note && !view.answeredBy) return null;
  return (
    <div className={className} data-testid="answer-bars">
      <div className="space-y-3">
        {view.targets.map((target) => {
          const label = target.kind === "owner"
            ? tDelegate("answer_for", { name: target.ownerName ?? "" })
            : t("participants.rsvp_label");
          return (
            <div
              key={`${target.kind}:${target.eventId}`}
              role="group"
              aria-label={label}
              className="flex flex-wrap items-center justify-between gap-2"
              data-testid={target.kind === "owner" ? "answer-for-owner" : "answer-self"}
            >
              <span className={size === "xs" ? "text-xs font-medium text-muted-foreground" : "text-sm font-medium"}>{label}</span>
              <RsvpButtons status={target.status} onRespond={(status) => onRespond(target, status)} size={size} />
            </div>
          );
        })}
      </div>
      {view.note && (
        <p className="mt-2 text-xs text-muted-foreground" role="note" data-testid={`answer-note-${view.note.kind}`}>
          {tDelegate(view.note.kind, { name: view.note.owner })}
        </p>
      )}
      {view.answeredBy && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="answered-by">
          {tDelegate("answered_by", { who: view.answeredBy })}
        </p>
      )}
    </div>
  );
}
