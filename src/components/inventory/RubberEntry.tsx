'use client';

import { X } from 'lucide-react';
import { fmtArea, fmtLenWidPcs, fmtRolls } from '@/lib/format';

/**
 * Entry for Open Roll / Rubber — two directions, so every row has a length AND a width:
 *
 *   mode "rolls"  (inward, purchase, opening stock)   WIDTH mm  ×  LENGTH m  ×  ROLLS
 *   mode "cut"    (outward, production)               LENGTH m  ×  WIDTH mm  ×  PCS
 *
 * The person types the length in metres (2.5 for 2 m 500 mm) and the width in mm — the same units on the
 * stock sheet. The database keeps both in mm, so a row is turned into
 *   { rolls: n, roll_length: length in mm, width: width in mm }.
 */
export interface RubberRow { len: string; wid: string; n: string }
export type RubberRows = RubberRow[];

export const emptyRubber = (): RubberRows => [{ len: '', wid: '', n: '' }];

export interface RubberGroup { rolls: number; roll_length: number; width: number }

/** Metres typed on screen → whole-number mm (2.5 → 2500) */
export const mFromTyped = (m: string | number): number => Math.round((Number(m) || 0) * 1000 * 1000) / 1000;

export function rubberPayload(rows: RubberRows): RubberGroup[] {
  const out: RubberGroup[] = [];
  for (const r of rows) {
    const n = Math.floor(Number(r.n) || 0), l = mFromTyped(r.len), w = Number(r.wid) || 0;
    if (n > 0 && l > 0 && w > 0) out.push({ rolls: n, roll_length: l, width: w });
  }
  return out;
}

/** Total AREA in mm² (what the database stores as the quantity). */
export const rubberTotal = (p: RubberGroup[]): number => p.reduce((a, r) => a + r.rolls * r.roll_length * r.width, 0);

export const rubberText = (g: RubberGroup, mode: 'rolls' | 'cut'): string =>
  mode === 'rolls' ? fmtRolls(g.width, g.roll_length, g.rolls) : fmtLenWidPcs(g.roll_length, g.width, g.rolls);

export default function RubberEntry({
  rows, onChange, mode = 'rolls', maxArea,
}: {
  rows: RubberRows; onChange: (r: RubberRows) => void; mode?: 'rolls' | 'cut';
  /** the most that can be taken (mm²) — only to warn */
  maxArea?: number;
}) {
  const cut = mode === 'cut';
  const payload = rubberPayload(rows);
  const total = rubberTotal(payload);
  const count = payload.reduce((a, r) => a + r.rolls, 0);
  const dec = (v: string) => v.replace(/[^0-9.]/g, '');
  const digits = (v: string) => v.replace(/[^0-9]/g, '');
  const set = (i: number, patch: Partial<RubberRow>) => onChange(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const addRow = () => onChange([...rows, { len: '', wid: '', n: '' }]);

  const lenField = (r: RubberRow, i: number) => (
    <div className="w-28">
      <label className="label">LENGTH (m) <span className="text-danger">*</span></label>
      <input className="field num text-[18px] h-11" inputMode="decimal" placeholder="e.g. 10"
        value={r.len} onChange={(e) => set(i, { len: dec(e.target.value) })} />
    </div>
  );
  const widField = (r: RubberRow, i: number, first: boolean) => (
    <div className="w-28">
      <label className="label">WIDTH (mm) <span className="text-danger">*</span></label>
      <input id={first ? 'roll-first' : undefined} className="field num text-[18px] h-11" inputMode="decimal" placeholder="e.g. 25"
        value={r.wid} onChange={(e) => set(i, { wid: dec(e.target.value) })} />
    </div>
  );

  return (
    <div className="space-y-3">
      {rows.map((r, i) => {
        const filled = (Math.floor(Number(r.n) || 0) > 0) && mFromTyped(r.len) > 0 && Number(r.wid) > 0;
        return (
          <div key={i} className="flex flex-wrap items-end gap-2">
            {cut ? <>{lenField(r, i)}<span className="pb-2.5 text-[18px] text-ink-3 font-semibold">×</span>{widField(r, i, i === 0)}</>
                 : <>{widField(r, i, i === 0)}<span className="pb-2.5 text-[18px] text-ink-3 font-semibold">×</span>{lenField(r, i)}</>}
            <span className="pb-2.5 text-[18px] text-ink-3 font-semibold">×</span>
            <div className="w-24">
              <label className="label">{cut ? 'PCS' : 'ROLLS'} <span className="text-danger">*</span></label>
              <input className="field num text-[18px] h-11" inputMode="numeric" placeholder="0"
                value={r.n} onChange={(e) => set(i, { n: digits(e.target.value) })}
                onKeyDown={(e) => { if (e.key === 'Enter' && i === rows.length - 1 && filled) { e.preventDefault(); addRow(); } }} />
            </div>
            {filled && (
              <span className="pb-2.5 text-[13px] text-ink-3 num">
                {fmtArea(Math.floor(Number(r.n)) * mFromTyped(r.len) * Number(r.wid))}
              </span>
            )}
            {rows.length > 1 && (
              <button type="button" className="btn btn-ghost h-9 w-9 p-0 mb-1" aria-label="Remove row"
                onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                <X size={14} />
              </button>
            )}
          </div>
        );
      })}

      <button type="button" className="text-[14px] text-brand font-medium" onClick={addRow}>
        + Add another {cut ? 'LENGTH × WIDTH × PCS' : 'WIDTH × LENGTH × ROLLS'} row
      </button>

      {total > 0 && (
        <div className="bg-ok-soft/30 rounded-lg px-3 py-2 text-[14px]">
          {cut ? 'Taking' : 'Adding'} {count} {cut ? 'piece' : 'roll'}{count === 1 ? '' : 's'}
          <span className="text-ink-3"> = {payload.map((g) => rubberText(g, mode)).join(' + ')}</span>
          <span className="num font-semibold"> · {fmtArea(total)}</span>
          {maxArea !== undefined && total > maxArea && (
            <span className="text-danger font-medium"> · only {fmtArea(maxArea)} is in stock</span>
          )}
        </div>
      )}
    </div>
  );
}
