/**
 * sheet-read.ts — reads ONE worksheet into clean rows. Used by the browser (to show
 * the sheet list / mapping) and by the server (to import), so both see exactly the
 * same headers and the same row numbers.
 *
 *  - headers are cleaned ("MAKE " -> "MAKE") and made unique
 *  - columns with no header are ignored
 *  - fully blank rows are dropped, but every row keeps its real Excel row number
 */

import * as XLSX from 'xlsx';
import { cleanHeader } from '@/lib/sheet-config';

export interface SheetRow { __row: number; [header: string]: unknown }
export interface ReadSheet { headers: string[]; rows: SheetRow[] }

const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

export function readWorksheet(wb: XLSX.WorkBook, name: string): ReadSheet {
  const ws = wb.Sheets[name];
  if (!ws) return { headers: [], rows: [] };
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', blankrows: true, raw: true });
  const head = (grid[0] ?? []) as unknown[];

  const seen = new Map<string, number>();
  const cols: { idx: number; name: string }[] = [];
  head.forEach((h, idx) => {
    const base = cleanHeader(h);
    if (!base) return;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    cols.push({ idx, name: n === 1 ? base : `${base} (${n})` });
  });

  const rows: SheetRow[] = [];
  for (let r = 1; r < grid.length; r++) {
    const line = (grid[r] ?? []) as unknown[];
    if (cols.every((c) => isBlank(line[c.idx]))) continue;
    const o: SheetRow = { __row: r + 1 };
    for (const c of cols) o[c.name] = line[c.idx] ?? '';
    rows.push(o);
  }
  return { headers: cols.map((c) => c.name), rows };
}

/** Tabs hidden in Excel (right-click → Hide). Their data is still in the file. */
export function hiddenSheets(wb: XLSX.WorkBook): Set<string> {
  const out = new Set<string>();
  (wb.Workbook?.Sheets ?? []).forEach((s, i) => { if (s.Hidden && wb.SheetNames[i]) out.add(wb.SheetNames[i]); });
  return out;
}

export function readWorkbook(buf: ArrayBuffer): XLSX.WorkBook {
  return XLSX.read(buf, { type: 'array' });
}
