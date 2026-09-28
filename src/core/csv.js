// Streaming RFC-4180 CSV parsing, lifted from the Iterable User Push userscript.

/**
 * Incremental RFC-4180 CSV parser.
 *
 * push(chunk) returns the rows that completed inside that chunk; any partial row (including a
 * quoted field containing a newline) is carried over until more text arrives. end() flushes a
 * final row that had no trailing newline. Handles CRLF / LF / CR (even mixed), escaped "" quotes,
 * and a UTF-8 BOM at the very start of the stream.
 */
export class CsvStreamParser {
  constructor() {
    this.field = '';
    this.row = [];
    this.inQuotes = false;
    this.quotePending = false; // saw `"` while inside quotes; escape or close?
    this.lastWasCR = false;
    this.started = false;      // used to strip the BOM only on the first char
    this.dirty = false;        // current row has content (guards the flush in end())
  }

  push(chunk) {
    const out = [];
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charAt(i);

      if (!this.started) {
        this.started = true;
        if (c === '﻿') continue;
      }

      // Resolve a quote seen at the end of a quoted run.
      if (this.quotePending) {
        this.quotePending = false;
        if (c === '"') { this.field += '"'; continue; } // "" -> literal quote
        this.inQuotes = false;                           // closing quote; c falls through
      }

      if (this.inQuotes) {
        if (c === '"') this.quotePending = true;
        else this.field += c;
        this.lastWasCR = false;
        continue;
      }

      if (c === '"' && this.field === '') { this.inQuotes = true; this.dirty = true; this.lastWasCR = false; continue; }

      if (c === '\n') {
        if (this.lastWasCR) { this.lastWasCR = false; continue; } // second half of CRLF
        out.push(this._endRow());
        continue;
      }
      if (c === '\r') {
        this.lastWasCR = true;
        out.push(this._endRow());
        continue;
      }

      this.lastWasCR = false;
      if (c === ',') { this.row.push(this.field); this.field = ''; this.dirty = true; }
      else { this.field += c; this.dirty = true; }
    }
    return out;
  }

  _endRow() {
    this.row.push(this.field);
    const r = this.row;
    this.field = ''; this.row = []; this.dirty = false;
    return r;
  }

  /** Flush whatever is left (a final line with no trailing newline). */
  end() {
    this.inQuotes = false; this.quotePending = false;
    if (!this.dirty && this.field === '' && this.row.length === 0) return [];
    return [this._endRow()];
  }
}

/** A blank line parses to a single empty field; treat it as no row at all. */
export function isBlankRow(fields) {
  return fields.length === 0 || (fields.length === 1 && fields[0] === '');
}

/** Parse a whole document at once (tests, small strings). Blank rows are dropped. */
export function parseCsvAll(text) {
  const p = new CsvStreamParser();
  return p.push(text).concat(p.end()).filter((r) => !isBlankRow(r));
}

/** Turn an array of fields into an object keyed by the header names. */
export function rowToObject(header, fields) {
  const o = {};
  for (let i = 0; i < header.length; i++) o[header[i]] = i < fields.length ? fields[i] : '';
  return o;
}

/** Quote a value for CSV output (RFC 4180 style). */
export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.split('"').join('""') + '"' : s;
}

/** Serialise rows (arrays of values) to CSV text with CRLF line endings. */
export function toCsv(rows) {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + (rows.length ? '\r\n' : '');
}

/**
 * Fast total-row count: stream the raw bytes and count 0x0A, no CSV parsing.
 * An approximation (a quoted newline inflates the count); good enough for progress bars.
 */
export async function countDataRows(file) {
  const reader = file.stream().getReader();
  let lines = 0, lastByte = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    const buf = r.value;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
    if (buf.length) lastByte = buf[buf.length - 1];
  }
  if (lastByte !== 10 && lastByte !== 0) lines++; // final line without trailing newline
  return Math.max(0, lines - 1);
}

/** Read just the header row (trimmed); cancels the stream as soon as it has one. */
export async function readHeader(file) {
  const reader = file.stream().pipeThrough(new TextDecoderStream('utf-8')).getReader();
  const parser = new CsvStreamParser();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      for (const row of parser.push(r.value)) {
        if (!isBlankRow(row)) return row.map((h) => h.trim());
      }
    }
    for (const row of parser.end()) {
      if (!isBlankRow(row)) return row.map((h) => h.trim());
    }
    return null;
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/**
 * Stream every data row of a File/Blob, calling onRow(fields, rowNumber). Nothing accumulates,
 * so a 1 GB file never lands in memory. onRow may return 'stop' to end early.
 * Resolves { header, rows } (rows = data rows handed to onRow).
 */
export async function streamRows(file, onRow) {
  const reader = file.stream().pipeThrough(new TextDecoderStream('utf-8')).getReader();
  const parser = new CsvStreamParser();
  let header = null, rowNum = 0, stopped = false;
  try {
    for (;;) {
      const r = await reader.read();
      const rows = r.done ? parser.end() : parser.push(r.value);
      for (const fields of rows) {
        if (isBlankRow(fields)) continue;
        if (header === null) { header = fields; continue; }
        rowNum++;
        if ((await onRow(fields, rowNum)) === 'stop') { stopped = true; break; }
      }
      if (stopped || r.done) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return { header, rows: rowNum };
}
