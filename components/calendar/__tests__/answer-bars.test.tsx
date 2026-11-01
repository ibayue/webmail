import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AnswerBars, useAnswerView } from '../answer-bars';
import { useAuthStore } from '@/stores/auth-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { CALENDAR_PRESETS } from '@/lib/jmap/share-rights';
import type { Calendar, CalendarEvent } from '@/lib/jmap/types';
import type { AnswerTarget } from '@/lib/calendar-delegate';

const event = {
  id: 'alice:e1', uid: 'u1', title: 'Planning', start: '2026-11-04T14:00:00', duration: 'PT1H',
  calendarIds: { 'alice:b': true }, isShared: true, accountId: 'alice',
  organizerCalendarAddress: 'mailto:carol@example.org',
  participants: {
    carol: { '@type': 'Participant', name: 'Carol', email: 'carol@example.org', roles: { owner: true }, participationStatus: 'accepted' },
    alice: { '@type': 'Participant', name: 'Alice', email: 'alice@example.org', roles: { attendee: true }, participationStatus: 'needs-action' },
  },
} as unknown as CalendarEvent;

const calendar = {
  id: 'alice:b', originalId: 'b', name: 'Alice', accountId: 'alice', accountName: 'alice@example.org', isShared: true,
  myRights: CALENDAR_PRESETS.readWrite,
} as unknown as Calendar;

function Harness({ onRespond }: { onRespond: (target: AnswerTarget, status: string) => void }) {
  const view = useAnswerView(event, calendar, ['bob@example.org'], false);
  return createElement(AnswerBars, { view, onRespond });
}

describe('AnswerBars', () => {
  afterEach(() => {
    useAuthStore.setState({ client: null } as never);
  });

  it('offers "Answer for <owner>" with the owner\'s name and answers with SENT-BY', async () => {
    const getAccountOwners = vi.fn(async () => ({ alice: { id: 'alice', type: 'individual' as const, name: 'alice@example.org', description: 'Alice Doe', email: 'alice@example.org' } }));
    useAuthStore.setState({ client: { getAccountOwners, hasAccountCapability: () => true } } as never);
    useCalendarStore.setState({ events: [event] });
    const onRespond = vi.fn();
    render(createElement(Harness, { onRespond }));

    const bar = await screen.findByTestId('answer-for-owner');
    // The i18n mock renders keys; the group is named by the label.
    expect(bar).toHaveAttribute('aria-label', 'answer_for');
    expect(getAccountOwners).toHaveBeenCalledWith(['alice']);
    fireEvent.click(bar.querySelectorAll('button')[0]);
    expect(onRespond).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'owner', eventId: 'alice:e1', participantId: 'alice', sentBy: 'mailto:bob@example.org',
    }), 'accepted');
    expect(screen.queryByTestId('answer-self')).toBeNull();
  });

  it('says the user can\'t answer for the owner with read access only', async () => {
    useAuthStore.setState({ client: { getAccountOwners: async () => ({}), hasAccountCapability: () => true } } as never);
    const readOnly = { ...calendar, myRights: CALENDAR_PRESETS.read } as Calendar;
    function ReadOnly() {
      const view = useAnswerView(event, readOnly, ['bob@example.org'], false);
      return createElement(AnswerBars, { view, onRespond: vi.fn() });
    }
    render(createElement(ReadOnly));
    expect(await screen.findByTestId('answer-note-no_write')).toHaveTextContent('no_write');
    expect(screen.queryByTestId('answer-for-owner')).toBeNull();
  });
});
