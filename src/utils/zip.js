// A minimal ZIP writer (stored, no compression) for bundling files that are already compressed, e.g. PNGs.
// Streams entries one by one, so memory stays at one file at a time. Not ZIP64: under 4 GB and 65,535 entries.
import { crc32 } from 'node:zlib';
import { readFile } from 'node:fs/promises';

const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed timestamp; the archive is a download, not a backup

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

/**
 * Writes a zip of `entries` ([{ name, path }]) to a writable stream (e.g. an Express response).
 * Entries whose file is missing are skipped. Returns the number written.
 */
export async function writeZip(out, entries) {
  const central = [];
  let offset = 0;
  const write = (buf) => new Promise((resolve, reject) => {
    out.write(buf, (err) => (err ? reject(err) : resolve()));
    offset += buf.length;
  });

  for (const entry of entries) {
    let data;
    try { data = await readFile(entry.path); } catch { continue; }
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const header = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name,
    ]);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(DOS_DATE),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(offset), name,
    ]));
    await write(header);
    await write(data);
  }

  const dir = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(dir.length), u32(offset), u16(0),
  ]);
  await write(dir);
  await write(end);
  return central.length;
}
