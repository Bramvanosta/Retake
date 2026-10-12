/**
 * Tables for chart cards (L2.10): CSV / TSV files of the project parsed into a header and rows of strings (the planner
 * hands them to components as `TableMedia`). Pure.
 */
export { parseNumber } from './kit/figures.js';

/**
 * Parse CSV (RFC 4180: quoted fields, "" escapes, CRLF) or TSV text. The delimiter is the first of tab, semicolon,
 * comma found in the first line outside quotes (default comma). Empty lines are skipped; the first row is the header.
 */
export function parseCsv(text: string, delimiter?: string): { columns: string[]; rows: string[][] } {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const outside = firstLine.replace(/"[^"]*"/g, '');
  const d = delimiter ?? (outside.includes('\t') ? '\t' : outside.includes(';') ? ';' : ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field.trim());
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((c) => c !== '')) rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (ch === d) endField();
    else if (ch === '\n') endRow();
    else if (ch !== '\r') field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) endRow();
  const [columns = [], ...body] = rows;
  const width = columns.length;
  return { columns, rows: body.map((r) => (r.length >= width ? r.slice(0, Math.max(width, r.length)) : [...r, ...Array(width - r.length).fill('')])) };
}
