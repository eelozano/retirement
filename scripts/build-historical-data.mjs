#!/usr/bin/env node
// Derives crates/engine/data/historical_us.csv from Robert Shiller's
// ie_data.xls (https://shillerdata.com/ — "U.S. Stock Markets 1871-Present
// and CAPE Ratio"): one row per calendar year, January to January,
//
//   year, stocks, bonds, inflation
//
// stocks     nominal total return of the S&P Composite, dividends reinvested
// bonds      nominal total return of the 10-year Treasury
// inflation  change in CPI-U
//
// Shiller publishes real total-return indices for both, so each nominal
// return is the real one with that year's CPI change put back:
// (1 + real) * (1 + inflation) - 1. A year is written only once the
// following January is in the file.
//
// Usage:
//   node scripts/build-historical-data.mjs <ie_data.xls> [--dump]
//
// --dump prints the Data sheet's first rows, for checking the column
// layout when Shiller changes it. The script reads the .xls itself (the
// legacy BIFF8 format inside a compound document), so it needs no packages
// and no spreadsheet application.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "crates/engine/data/historical_us.csv",
);

// ---------------------------------------------------------------------------
// Compound document (OLE2 / CFB): find the "Workbook" stream.

function readWorkbookStream(buf) {
  const signature = buf.readUInt32LE(0);
  if (signature !== 0xe011cfd0) throw new Error("not a compound document (.xls)");
  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const miniSectorSize = 1 << buf.readUInt16LE(0x20);
  const firstDirSector = buf.readInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const firstMiniFat = buf.readInt32LE(0x3c);
  let difatSector = buf.readInt32LE(0x44);
  const sectorAt = (n) => buf.subarray((n + 1) * sectorSize, (n + 2) * sectorSize);

  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readInt32LE(0x4c + 4 * i);
    if (s >= 0) fatSectors.push(s);
  }
  while (difatSector >= 0) {
    const sector = sectorAt(difatSector);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i++) {
      const s = sector.readInt32LE(4 * i);
      if (s >= 0) fatSectors.push(s);
    }
    difatSector = sector.readInt32LE(4 * per);
  }
  const fat = [];
  for (const s of fatSectors) {
    const sector = sectorAt(s);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(sector.readInt32LE(4 * i));
  }
  const chain = (start) => {
    const parts = [];
    for (let s = start; s >= 0; s = fat[s]) parts.push(sectorAt(s));
    return Buffer.concat(parts);
  };

  const dir = chain(firstDirSector);
  const entries = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 64);
    entries.push({
      name: dir.subarray(off, off + Math.max(0, nameLen - 2)).toString("utf16le"),
      type: dir[off + 66],
      start: dir.readInt32LE(off + 116),
      size: dir.readUInt32LE(off + 120),
    });
  }
  const book = entries.find((e) => e.name === "Workbook" || e.name === "Book");
  if (!book) throw new Error("no Workbook stream");
  if (book.size >= miniCutoff) return chain(book.start).subarray(0, book.size);

  // A small workbook lives in the mini stream, rooted at entry 0.
  const miniStream = chain(entries[0].start);
  const miniFat = [];
  const mf = chain(firstMiniFat);
  for (let i = 0; i < mf.length / 4; i++) miniFat.push(mf.readInt32LE(4 * i));
  const parts = [];
  for (let s = book.start; s >= 0; s = miniFat[s]) {
    parts.push(miniStream.subarray(s * miniSectorSize, (s + 1) * miniSectorSize));
  }
  return Buffer.concat(parts).subarray(0, book.size);
}

// ---------------------------------------------------------------------------
// BIFF8 records: sheet names, the shared string table, and numeric cells.

function* records(stream, from = 0) {
  let off = from;
  while (off + 4 <= stream.length) {
    const type = stream.readUInt16LE(off);
    const len = stream.readUInt16LE(off + 2);
    yield { type, data: stream.subarray(off + 4, off + 4 + len), offset: off };
    off += 4 + len;
  }
}

/// The shared string table, which may run on through CONTINUE records; a
/// string split across one starts the next record with a fresh flags byte.
function readSst(parts) {
  const strings = [];
  let part = 0;
  let pos = 8; // skip cstTotal, cstUnique
  const need = (n) => {
    if (pos + n <= parts[part].length) return;
    if (pos >= parts[part].length) {
      part += 1;
      pos = 0;
    }
  };
  const total = parts[0].readUInt32LE(4);
  for (let i = 0; i < total; i++) {
    need(3);
    if (part >= parts.length) break;
    const buf = () => parts[part];
    const cch = buf().readUInt16LE(pos);
    let flags = buf()[pos + 2];
    pos += 3;
    let runs = 0;
    let ext = 0;
    if (flags & 0x08) {
      runs = buf().readUInt16LE(pos);
      pos += 2;
    }
    if (flags & 0x04) {
      ext = buf().readUInt32LE(pos);
      pos += 4;
    }
    let text = "";
    let remaining = cch;
    while (remaining > 0) {
      if (pos >= buf().length) {
        part += 1;
        flags = parts[part][0];
        pos = 1;
      }
      const wide = flags & 0x01;
      const avail = Math.floor((buf().length - pos) / (wide ? 2 : 1));
      const take = Math.min(remaining, avail);
      const bytes = buf().subarray(pos, pos + take * (wide ? 2 : 1));
      text += wide ? bytes.toString("utf16le") : bytes.toString("latin1");
      pos += bytes.length;
      remaining -= take;
    }
    let skip = runs * 4 + ext;
    while (skip > 0) {
      const avail = buf().length - pos;
      if (skip <= avail) {
        pos += skip;
        skip = 0;
      } else {
        skip -= avail;
        part += 1;
        pos = 0;
      }
    }
    strings.push(text);
  }
  return strings;
}

function decodeRk(rk) {
  let value;
  if (rk & 0x02) {
    value = rk >> 2;
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(rk & 0xfffffffc, 4);
    value = b.readDoubleLE(0);
  }
  return rk & 0x01 ? value / 100 : value;
}

function readSheet(stream, name) {
  const sheets = [];
  const sstParts = [];
  let inSst = false;
  for (const r of records(stream)) {
    if (r.type === 0x0085) {
      const cch = r.data[6];
      const wide = r.data[7] & 0x01;
      const raw = r.data.subarray(8, 8 + cch * (wide ? 2 : 1));
      sheets.push({
        name: wide ? raw.toString("utf16le") : raw.toString("latin1"),
        offset: r.data.readUInt32LE(0),
      });
    } else if (r.type === 0x00fc) {
      sstParts.push(r.data);
      inSst = true;
      continue;
    } else if (r.type === 0x003c && inSst) {
      sstParts.push(r.data);
      continue;
    } else if (r.type === 0x000a) {
      break; // end of the workbook globals
    }
    inSst = false;
  }
  const sst = sstParts.length ? readSst(sstParts) : [];
  const sheet = sheets.find((s) => s.name === name);
  if (!sheet) throw new Error(`no sheet named ${name}: ${sheets.map((s) => s.name)}`);

  const rows = [];
  const set = (row, col, value) => {
    rows[row] ??= [];
    rows[row][col] = value;
  };
  for (const r of records(stream, sheet.offset)) {
    const d = r.data;
    if (r.type === 0x000a) break;
    if (r.type === 0x0203) set(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
    else if (r.type === 0x027e)
      set(d.readUInt16LE(0), d.readUInt16LE(2), decodeRk(d.readUInt32LE(6)));
    else if (r.type === 0x00bd) {
      const row = d.readUInt16LE(0);
      const first = d.readUInt16LE(2);
      const count = (d.length - 6) / 6;
      for (let i = 0; i < count; i++)
        set(row, first + i, decodeRk(d.readUInt32LE(4 + 6 * i + 2)));
    } else if (r.type === 0x00fd)
      set(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)]);
    else if (r.type === 0x0006) {
      // A formula's cached result: a double unless its top bytes are 0xFFFF.
      if (d.readUInt16LE(12) !== 0xffff)
        set(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The Data sheet's layout. Checked against its header, so a reshuffle in a
// future file fails here rather than producing plausible wrong numbers.

const COLUMNS = {
  date: { col: 0, header: "Date" },
  cpi: { col: 4, header: "Consumer Price Index CPI" },
  realTotalReturnPrice: { col: 9, header: "Real Total Return Price" },
  realTotalBondReturns: { col: 18, header: "Real Total Bond Returns" },
};
/// The header runs over rows 4–7; the data starts on the row after.
const HEADER_ROWS = [4, 5, 6, 7];
const FIRST_DATA_ROW = 8;

function annual(rows) {
  for (const [key, { col, header }] of Object.entries(COLUMNS)) {
    const label = HEADER_ROWS.map((r) => rows[r]?.[col])
      .filter((v) => typeof v === "string")
      .map((v) => v.trim())
      .join(" ");
    if (label !== header) {
      throw new Error(
        `column ${col} (${key}) is headed ${JSON.stringify(label)}, expected ${header} — ` +
          "the sheet's layout has changed; rerun with --dump",
      );
    }
  }
  // Shiller dates months as 1871.01 … 1871.1 (October); keep Januaries.
  const january = new Map();
  for (const row of rows.slice(FIRST_DATA_ROW)) {
    if (!row || typeof row[COLUMNS.date.col] !== "number") continue;
    const date = row[COLUMNS.date.col];
    const year = Math.floor(date + 1e-9);
    const month = Math.round((date - year) * 100);
    if (month !== 1) continue;
    const cpi = row[COLUMNS.cpi.col];
    const stock = row[COLUMNS.realTotalReturnPrice.col];
    const bond = row[COLUMNS.realTotalBondReturns.col];
    if ([cpi, stock, bond].every((v) => typeof v === "number" && v > 0)) {
      january.set(year, { cpi, stock, bond });
    }
  }
  const out = [];
  const years = [...january.keys()].sort((a, b) => a - b);
  for (const year of years) {
    const now = january.get(year);
    const next = january.get(year + 1);
    if (!next) continue;
    const inflation = next.cpi / now.cpi - 1;
    const nominal = (realGrowth) => realGrowth * (1 + inflation) - 1;
    out.push({
      year,
      stocks: nominal(next.stock / now.stock),
      bonds: nominal(next.bond / now.bond),
      inflation,
    });
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i].year !== out[i - 1].year + 1)
      throw new Error(`gap after ${out[i - 1].year}`);
  }
  return out;
}

// ---------------------------------------------------------------------------

const [path, flag] = process.argv.slice(2);
if (!path) {
  console.error("usage: node scripts/build-historical-data.mjs <ie_data.xls> [--dump]");
  process.exit(2);
}
const rows = readSheet(readWorkbookStream(readFileSync(path)), "Data");
if (flag === "--dump") {
  for (let r = 0; r < 14; r++) console.log(r, JSON.stringify(rows[r] ?? []));
  process.exit(0);
}
const years = annual(rows);
const fmt = (v) => v.toFixed(6);
const lines = [
  "# Annual U.S. market and price history, January to January.",
  "# Source: Robert J. Shiller, ie_data.xls (https://shillerdata.com/), Data sheet.",
  "# stocks: S&P Composite nominal total return (dividends reinvested).",
  "# bonds: 10-year Treasury nominal total return.",
  "# inflation: CPI-U change.",
  "# Nominal = (1 + Shiller's real total return) * (1 + inflation) - 1.",
  "# Regenerate: node scripts/build-historical-data.mjs <ie_data.xls>",
  "year,stocks,bonds,inflation",
  ...years.map((y) => [y.year, fmt(y.stocks), fmt(y.bonds), fmt(y.inflation)].join(",")),
];
writeFileSync(OUT, `${lines.join("\n")}\n`);
console.log(
  `wrote ${years.length} years, ${years[0].year}–${years.at(-1).year}, to ${OUT}`,
);
