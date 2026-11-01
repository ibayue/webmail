import { describe, it, expect } from 'vitest';
import { mboxState } from '@/lib/mail-import/mbox-status';

describe('mboxState', () => {
  it('imports a message without any state header as read, as before', () => {
    expect(mboxState('Subject: x\nDate: Tue, 5 May 2020 10:00:00 +0000')).toEqual({ keywords: { $seen: true }, expunged: false });
  });

  it('reads Status R as read and Status O alone as unread', () => {
    expect(mboxState('Status: RO').keywords).toEqual({ $seen: true });
    expect(mboxState('Status: O').keywords).toEqual({});
  });

  it('reads X-Status answered, flagged and draft', () => {
    expect(mboxState('Status: O\nX-Status: AFT').keywords).toEqual({ $answered: true, $flagged: true, $draft: true });
  });

  it('reads Thunderbird X-Mozilla-Status bits', () => {
    expect(mboxState('X-Mozilla-Status: 0001').keywords).toEqual({ $seen: true });
    expect(mboxState('X-Mozilla-Status: 0000').keywords).toEqual({});
    expect(mboxState('X-Mozilla-Status: 1006').keywords).toEqual({ $answered: true, $flagged: true, $forwarded: true });
  });

  it('marks a Thunderbird-expunged message (0x8) to be skipped', () => {
    expect(mboxState('X-Mozilla-Status: 0009').expunged).toBe(true);
    expect(mboxState('X-Mozilla-Status: 0001').expunged).toBe(false);
  });

  it('adds X-Keywords and X-Mozilla-Keys, skipping invalid and server-set ones', () => {
    const { keywords } = mboxState('Status: R\nX-Keywords: Work, $label1 bad(word) $HasAttachment\nX-Mozilla-Keys: todo');
    expect(keywords).toEqual({ $seen: true, work: true, $label1: true, todo: true });
  });

  it('reads Google Takeout labels', () => {
    expect(mboxState('X-Gmail-Labels: Inbox,Unread').keywords).toEqual({});
    expect(mboxState('X-Gmail-Labels: Inbox,Starred').keywords).toEqual({ $seen: true, $flagged: true });
  });

  it('reads folded and differently cased headers', () => {
    expect(mboxState('subject: a\r\nx-status:\r\n F\r\nSTATUS: O').keywords).toEqual({ $flagged: true });
  });
});
