'use client';

import { X } from 'lucide-react';

/**
 * Inward entry for roll-tracked timing belts: N standard rolls plus optional
 * "other length" rolls (one-time lots — the SKU's standard roll length never
 * changes). The total is only a summary; every roll becomes its own lot.
 */
export interface RollRows {
  count: string;
  odd: { rolls: string; length: string }[];
}

export const emptyRolls = (): RollRows => ({ count: '', odd: [] });

export function rollsPayload(len: number, rows: RollRows): { rolls: number; roll_length: number }[] {
  const out: { rolls: number; roll_length: number }[] = [];
  const n = Math.floor(Number(rows.count) || 0);
  if (n > 0 && len > 0) out.push({ rolls: n, roll_length: len });
  for (const o of rows.odd) {
    const r = Math.floor(Number(o.rolls) || 0), l = Number(o.length) || 0;
    if (r > 0 && l > 0) out.push({ rolls: r, roll_length: l });
  }
  return out;
}

export const rollsTotal = (p: { rolls: number; roll_length: number }[]) =>
  p.reduce((a, r) => a + r.rolls * r.roll_length, 0);

export default function RollEntry({
  len, rows, onChange,
}: { len: number; rows: RollRows; onChange: (r: RollRows) => void }) {
  const payload = rollsPayload(len, rows);
  const total = rollsTotal(payload);
  const digits = (v: string) => v.replace(/[^0-9]/g, '');
  const dec = (v: string) => v.replace(/[^0-9.]/g, '');
  return (
    <div className="space-y-3">
      <div>
        <label className="label">Standard rolls received ({len} mm each) <span className="text-danger">*</span></label>
        <input
          id="roll-count"
          className="field num text-[18px] h-11"
          inputMode="numeric"
          value={rows.count}
          placeholder="0"
          onChange={(e) => onChange({ ...rows, count: digits(e.target.value) })}
        />
      </div>

      {rows.odd.map((o, i) => (
        <div key={i} className="flex items-end gap-2">
          <div className="flex-1">
            <label className="label">Odd rolls</label>
            <input className="field num" inputMode="numeric" value={o.rolls}
              onChange={(e) => onChange({ ...rows, odd: rows.odd.map((x, j) => j === i ? { ...x, rolls: digits(e.target.value) } : x) })} />
          </div>
          <div className="flex-1">
            <label className="label">Length (mm)</label>
            <input className="field num" inputMode="decimal" value={o.length} placeholder="e.g. 45"
              onChange={(e) => onChange({ ...rows, odd: rows.odd.map((x, j) => j === i ? { ...x, length: dec(e.target.value) } : x) })} />
          </div>
          <button type="button" className="btn btn-ghost h-9 w-9 p-0"
            onClick={() => onChange({ ...rows, odd: rows.odd.filter((_, j) => j !== i) })}>
            <X size={14} />
          </button>
        </div>
      ))}

      <button type="button" className="text-[14px] text-brand font-medium"
        onClick={() => onChange({ ...rows, odd: [...rows.odd, { rolls: '1', length: '' }] })}>
        + Other length (a roll that is not {len} mm)
      </button>

      {total > 0 && (
        <div className="bg-ok-soft/30 rounded-lg px-3 py-2 text-[14px]">
          Adding {payload.reduce((a, r) => a + r.rolls, 0)} roll{payload.reduce((a, r) => a + r.rolls, 0) === 1 ? '' : 's'}
          <span className="text-ink-3"> = {payload.map((r) => `${r.rolls}×${r.roll_length}`).join(' + ')}</span>
          <span className="num font-semibold"> · total {total} mm</span>
        </div>
      )}
    </div>
  );
}
