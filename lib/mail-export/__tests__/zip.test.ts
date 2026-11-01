import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { ZipWriter } from '@/lib/mail-export/zip-writer';
import { crc32 } from '@/lib/mail-export/crc32';
import { listZipEntries, readZipEntry, streamZipEntry } from '@/lib/mail-import/zip-reader';

const enc = new TextEncoder();
const dec = new TextDecoder();
const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

describe('crc32', () => {
  it('matches the reference value and streams', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(enc.encode('6789'), crc32(enc.encode('12345')))).toBe(0xcbf43926);
  });
});

describe('ZipWriter', () => {
  async function build(fill: (z: ZipWriter) => Promise<void>) {
    const chunks: Uint8Array[] = [];
    const z = new ZipWriter(async (c) => { chunks.push(c.slice()); });
    await fill(z);
    await z.finish();
    return join(chunks);
  }

  it('writes files, folders and a streamed entry that other readers open', async () => {
    const big = 'From MAILER-DAEMON x\n'.repeat(5000);
    const zip = await build(async (z) => {
      await z.addFile('Inbox/0001 Hello.eml', enc.encode('Subject: Hello\r\n\r\nbody'), new Date(2020, 4, 5, 10, 11, 12));
      await z.addDirectory('Empty');
      await z.addFile('Prüfung/ä.eml', enc.encode('x'.repeat(1000)));
      const s = await z.openStream('Archive.mbox');
      await s.write(enc.encode(big.slice(0, 1000)));
      await s.write(enc.encode(big.slice(1000)));
      await s.close();
    });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['Archive.mbox', 'Empty/', 'Inbox/0001 Hello.eml', 'Prüfung/ä.eml']);
    expect(strFromU8(files['Inbox/0001 Hello.eml'])).toBe('Subject: Hello\r\n\r\nbody');
    expect(strFromU8(files['Archive.mbox'])).toBe(big);
  });

  it('is read back by the importer, whole and in chunks', async () => {
    const big = enc.encode('line of mail\n'.repeat(20000));
    const zip = await build(async (z) => {
      await z.addFile('a.eml', enc.encode('A'));
      const s = await z.openStream('b.mbox');
      for (let i = 0; i < big.length; i += 7000) await s.write(big.subarray(i, i + 7000));
      await s.close();
    });
    const file = new Blob([zip]);
    const entries = await listZipEntries(file);
    expect(entries.map((e) => [e.name, e.size])).toEqual([['a.eml', 1], ['b.mbox', big.length]]);
    expect(dec.decode(await readZipEntry(file, entries[0]))).toBe('A');
    const parts: Uint8Array[] = [];
    for await (const c of streamZipEntry(file, entries[1], 4096)) parts.push(c);
    // Compared as text: jsdom and Node each have their own Uint8Array.
    expect(dec.decode(join(parts))).toBe(dec.decode(big));
  });

  it('writes Zip64 records past 65,535 entries', async () => {
    const zip = await build(async (z) => {
      for (let i = 0; i < 65_540; i++) await z.addFile(`${i}`, new Uint8Array(0));
    });
    // The classic end record says "see Zip64", and the Zip64 one has the count.
    const entries = await listZipEntries(new Blob([zip]));
    expect(entries).toHaveLength(65_540);
    expect(entries[65_539].name).toBe('65539');
  }, 60_000);
});
