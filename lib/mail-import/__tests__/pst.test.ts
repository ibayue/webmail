// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import PostalMime from 'postal-mime';
import { PSTFile } from 'pst-extractor';
import { walkPst, type PstItem } from '@/lib/mail-import/pst/items';
import { buildMime, encodeHeaderText, keptHeaders, type PstMailData } from '@/lib/mail-import/pst/mime';
import { itemKind, pstFolders } from '@/lib/mail-import/pst/extract';
import { registerPstFile, openSync, readSync } from '@/lib/mail-import/pst/shims/fs';

// Aspose's Outlook.pst (MIT, see fixtures/Outlook.pst.LICENSE).
const FIXTURE = path.join(__dirname, 'fixtures', 'Outlook.pst');

function readAll(): PstItem[] {
  const pst = new PSTFile(fs.readFileSync(FIXTURE));
  const { items, total } = walkPst(pst, { skipBefore: 0, maxMessageBytes: 50_000_000, boundarySeed: 'test' });
  const out = [...items];
  expect(total).toBe(out.length);
  return out;
}

const parse = (mime: Uint8Array) => PostalMime.parse(Buffer.from(mime));

describe('PST import (Outlook.pst fixture)', () => {
  const items = readAll();
  const messages = items.filter((i): i is Extract<PstItem, { kind: 'message' }> => i.kind === 'message');

  it('reads the mail of the IPM subtree, not the search folders, and counts contacts and calendar items', () => {
    expect(messages).toHaveLength(14);
    const skipped = items.filter((i) => i.kind === 'skipped').map((i) => (i as { reason: string }).reason).sort();
    expect(skipped).toEqual(['calendar', 'contact']);
    const folders = [...new Set(messages.map((m) => m.folder.join('/')))].sort();
    expect(folders).toEqual(['Inbox', 'Sent Items']);
  });

  it('keeps the read state and counts embedded messages it cannot read', () => {
    expect(messages.filter((m) => m.keywords.$seen)).toHaveLength(12);
    const unread = messages.filter((m) => !m.keywords.$seen).map((m) => m.label).sort();
    expect(unread).toEqual(['message 1', 'message 2']);
    expect(messages.reduce((n, m) => n + m.embeddedSkipped, 0)).toBe(4);
  });

  it('builds a received message from its original headers with a fresh MIME body', async () => {
    const m = messages.find((x) => x.label === 'Multiple attachments' && x.folder[0] === 'Inbox')!;
    const text = new TextDecoder().decode(m.mime);
    expect(text).toMatch(/^Return-Path: saqib\.razzaq@xp\.local\r\n/);
    expect(text).toContain('Received: from xp');
    // The original multipart boundary is gone; ours names the new structure.
    expect(text.match(/^Content-Type:/gim)?.[0]).toBeTruthy();
    expect(text).toContain('boundary="=_bulwark_test_');
    const parsed = await parse(m.mime);
    expect(parsed.subject).toBe('Multiple attachments');
    expect(parsed.from?.address).toBe('saqib.razzaq@xp.local');
    expect(parsed.attachments.map((a) => [a.filename, a.mimeType]).sort()).toEqual([
      ['Blue hills.jpg', 'image/jpeg'], ['Sunset.jpg', 'image/jpeg'], ['text file.txt', 'text/plain'],
    ]);
    const sunset = parsed.attachments.find((a) => a.filename === 'Sunset.jpg')!;
    expect((sunset.content as ArrayBuffer).byteLength).toBe(71189);
    expect(m.receivedAt).toBe('2011-06-21T23:51:07Z');
  });

  it('puts cid images in multipart/related with their Content-ID', async () => {
    const m = messages.find((x) => x.label === 'HTML body' && x.folder[0] === 'Inbox')!;
    const parsed = await parse(m.mime);
    expect(parsed.html).toContain('cid:image001.png@01CC3097.BF0BAC70');
    const inline = parsed.attachments.filter((a) => a.contentId);
    expect(inline).toHaveLength(12);
    expect(inline[0].contentId).toBe('<image001.png@01CC3097.BF0BAC70>');
    expect(new TextDecoder().decode(m.mime)).toContain('multipart/related');
  });

  it('builds a sent message without headers from its properties', async () => {
    const m = messages.find((x) => x.label === 'Multiple attachments' && x.folder[0] === 'Sent Items')!;
    const parsed = await parse(m.mime);
    expect(parsed.from?.address).toBe('saqib.razzaq@xp.local');
    expect(parsed.to?.[0]?.address).toBe('saqib.razzaq@xp.local');
    expect(parsed.date).toBe('2011-06-21T23:51:07.000Z');
    expect(parsed.text?.trim().length).toBeGreaterThan(0);
    expect(parsed.html).toBeTruthy();
    // No mimeTag in the PST: the type comes from the file name.
    expect(parsed.attachments.find((a) => a.filename === 'Sunset.jpg')?.mimeType).toBe('image/jpeg');
  });

  it('reports items before the resume point without building them', () => {
    const pst = new PSTFile(fs.readFileSync(FIXTURE));
    const again = [...walkPst(pst, { skipBefore: 5, maxMessageBytes: 50_000_000 }).items];
    expect(again.slice(0, 5).every((i) => i.kind === 'skipped' && i.reason === 'resumed')).toBe(true);
    expect(again.slice(5).map((i) => i.index)).toEqual(items.slice(5).map((i) => i.index));
  });

  it('skips messages larger than the server takes', () => {
    const pst = new PSTFile(fs.readFileSync(FIXTURE));
    const small = [...walkPst(pst, { skipBefore: 0, maxMessageBytes: 20_000 }).items];
    expect(small.some((i) => i.kind === 'skipped' && i.reason === 'too_large')).toBe(true);
  });
});

describe('buildMime', () => {
  const base: PstMailData = { subject: 'Prüfung', to: [{ name: 'Jörg', email: 'j@example.org' }], cc: [], bcc: [{ email: 'b@example.org' }], attachments: [] };

  it('encodes non-ASCII subjects, names and file names', async () => {
    const mime = buildMime({ ...base, text: 'Grüße', date: new Date('2020-01-02T03:04:05Z'), attachments: [{ filename: 'Bericht ä.pdf', mimeType: 'application/pdf', data: new Uint8Array([1, 2, 3]) }] });
    const text = new TextDecoder().decode(mime);
    // 7-bit: every character is ASCII.
    expect([...text].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    const parsed = await parse(mime);
    expect(parsed.subject).toBe('Prüfung');
    expect(parsed.to?.[0]).toMatchObject({ name: 'Jörg', address: 'j@example.org' });
    expect(parsed.bcc?.[0]?.address).toBe('b@example.org');
    expect(parsed.text?.trim()).toBe('Grüße');
    expect(parsed.attachments[0].filename).toBe('Bericht ä.pdf');
    expect(parsed.date).toBe('2020-01-02T03:04:05.000Z');
  });

  it('attaches an RTF-only body as message.rtf', async () => {
    const parsed = await parse(buildMime({ ...base, text: '\r\n\r\n', rtf: '{\\rtf1 hi}' }));
    expect(parsed.attachments.map((a) => a.filename)).toEqual(['message.rtf']);
  });

  it('drops the MIME fields of kept headers and keeps the rest', () => {
    const { text, names } = keptHeaders('From: a@example.org\r\nContent-Type: multipart/mixed;\r\n\tboundary="old"\r\nSubject: hi\r\n there\r\nMIME-Version: 1.0\r\n');
    expect(text).toBe('From: a@example.org\r\nSubject: hi\r\n there');
    expect([...names]).toEqual(['from', 'subject']);
  });

  it('splits long encoded words between characters', () => {
    const encoded = encodeHeaderText('ü'.repeat(40));
    for (const word of encoded.split('\r\n ')) expect(word.length).toBeLessThanOrEqual(75);
  });
});

describe('pstFolders without an IPM subtree entry (OST files)', () => {
  const folder = (displayName: string, children: unknown[] = [], containerClass = '') => ({
    displayName, containerClass, descriptorNodeId: 1, hasSubfolders: children.length > 0, getSubFolders: () => children,
  });
  it('reads IPM_SUBTREE as the top and leaves search and system folders out', () => {
    const pst = {
      getMessageStore: () => ({ getBinaryItem: () => null }),
      getRootFolder: () => folder('', [
        folder('Root - Mailbox', [
          folder('IPM_SUBTREE', [folder('Inbox', [folder('Projects')]), folder('Calendar', [], 'IPF.Appointment')]),
          folder('Finder', [folder('Saved search')]),
          folder('Freebusy Data'),
        ]),
        folder('Search Root', [folder('All Messages')]),
      ]),
    };
    const out = [...pstFolders(pst)].map((f) => `${f.path.join('/')}${f.mail ? '' : ' (not mail)'}`);
    expect(out).toEqual(['', '', '', 'Inbox', 'Inbox/Projects', 'Calendar (not mail)']);
  });
});

describe('itemKind', () => {
  it('sorts Outlook message classes', () => {
    expect(itemKind('IPM.Note')).toBe('mail');
    expect(itemKind('IPM.Note.SMIME.MultipartSigned')).toBe('mail');
    expect(itemKind('REPORT.IPM.Note.NDR')).toBe('mail');
    expect(itemKind('IPM.Contact')).toBe('contact');
    expect(itemKind('IPM.Schedule.Meeting.Request')).toBe('calendar');
    expect(itemKind('IPM.StickyNote')).toBe('other');
  });
});

describe('the worker\'s File-backed fs', () => {
  it('reads any range across its 64 KB pages', () => {
    const bytes = fs.readFileSync(FIXTURE);
    (globalThis as { FileReaderSync?: unknown }).FileReaderSync = class {
      readAsArrayBuffer(blob: { bytes: Uint8Array }) { return new Uint8Array(blob.bytes).buffer; }
    };
    const file = { size: bytes.length, slice: (a: number, b: number) => ({ bytes: bytes.subarray(a, b) }) };
    registerPstFile('t.pst', file as unknown as Blob);
    const fd = openSync('t.pst');
    for (const [pos, len] of [[0, 4], [65530, 20], [131072, 1], [200000, 150000], [bytes.length - 3, 10]]) {
      const out = new Uint8Array(len);
      const n = readSync(fd, out, 0, len, pos);
      expect(n).toBe(Math.min(len, bytes.length - pos));
      expect(Buffer.from(out.subarray(0, n)).equals(bytes.subarray(pos, pos + n))).toBe(true);
    }
  });
});
