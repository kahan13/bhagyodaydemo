'use client';

import { X } from 'lucide-react';

/**
 * Inward entry for roll-tracked timing belts: rows of  QTY × MM.
 * There is no fixed roll length on the product — every row says how many pieces and how long
 * each one is. Each row is either Full Sleeve (default) or Cut Pcs. Every piece becomes its own lot.
 * Total = QTY × MM, summed over the rows.
 */
export interface RollRow { qty: string; mm: string; cut: boolean }
export type RollRows = RollRow[];

export const emptyRolls = (): RollRows => [{ qty: '', mm: '', cut: false }];

export interface RollGroup { rolls: number; roll_length: number; cut: boolean }

export function rollsPayload(rows: RollRows): RollGroup[] {
  const out: RollGroup[] = [];
  for (const r of rows) {
    const n = Math.floor(Number(r.qty) || 0), l = Number(r.mm) || 0;
    if (n > 0 && l > 0) out.push({ rolls: n, roll_length: l, cut: r.cut });
  }
  return out;
}

export const rollsTotal = (p: { rolls: number; roll_length: number }[]) =>
  p.reduce((a, r) => a + r.rolls * r.roll_length, 0);

/** Full Sleeve / Cut Pcs switch — Full Sleeve is the default. */
export function SleeveToggle({ cut, onChange, idPrefix }: { cut: boolean; onChange: (cut: boolean) => void; idPrefix?: string }) {
  const base = 'px-3 h-11 text-[14px] font-semibold border transition-colors';
  return (
    <div className="inline-flex rounded-lg overflow-hidden" role="group" aria-label="Full sleeve or cut pieces">
      <button type="button" id={idPrefix ? `${idPrefix}-full` : undefined}
        className={`${base} rounded-l-lg ${!cut ? 'bg-ok-soft text-ok border-ok-line' : 'bg-surface text-ink-2 border-line-strong hover:bg-subtle'}`}
        aria-pressed={!cut} onClick={() => onChange(false)}>
        Full sleeve
      </button>
      <button type="button" id={idPrefix ? `${idPrefix}-cut` : undefined}
        className={`${base} rounded-r-lg -ml-px ${cut ? 'bg-warn-soft text-warn border-warn-line' : 'bg-surface text-ink-2 border-line-strong hover:bg-subtle'}`}
        aria-pressed={cut} onClick={() => onChange(true)}>
        Cut pcs
      </button>
    </div>
  );
}

export const groupLabel = (g: { rolls: number; roll_length: number; cut?: boolean }) =>
  `${g.rolls}×${g.roll_length}${g.cut ? ' cut' : ''}`;

export default function RollEntry({
  rows, onChange, maxTotal,
}: { rows: RollRows; onChange: (r: RollRows) => void; maxTotal?: number }) {
  const payload = rollsPayload(rows);
  const total = rollsTotal(payload);
  const pieces = payload.reduce((a, r) => a + r.rolls, 0);
  const digits = (v: string) => v.replace(/[^0-9]/g, '');
  const dec = (v: string) => v.replace(/[^0-9.]/g, '');
  const set = (i: number, patch: Partial<RollRow>) =>
    onChange(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const addRow = () => onChange([...rows, { qty: '', mm: '', cut: false }]);

  return (
    <div className="space-y-3">
      {rows.map((r, i) => {
        const n = Math.floor(Number(r.qty) || 0), l = Number(r.mm) || 0;
        return (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <div className="w-24">
              <label className="label">Qty <span className="text-danger">*</span></label>
              <input
                id={i === 0 ? 'roll-count' : undefined}
                className="field num text-[18px] h-11" inputMode="numeric" placeholder="0"
                value={r.qty} onChange={(e) => set(i, { qty: digits(e.target.value) })} />
            </div>
            <span className="pb-2.5 text-[18px] text-ink-3 font-semibold">×</span>
            <div className="w-32">
              <label className="label">MM <span className="text-danger">*</span></label>
              <input
                className="field num text-[18px] h-11" inputMode="decimal" placeholder="e.g. 470"
                value={r.mm} onChange={(e) => set(i, { mm: dec(e.target.value) })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && i === rows.length - 1 && n > 0 && l > 0) { e.preventDefault(); addRow(); }
                }} />
            </div>
            <div className="pb-0.5">
              <SleeveToggle cut={r.cut} onChange={(cut) => set(i, { cut })} />
            </div>
            {n > 0 && l > 0 && (
              <span className="pb-2.5 num text-[15px] font-semibold">= {n * l} mm</span>
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
        + Add another length
      </button>

      {total > 0 && (
        <div className="bg-ok-soft/30 rounded-lg px-3 py-2 text-[14px]">
          Adding {pieces} piece{pieces === 1 ? '' : 's'}
          <span className="text-ink-3"> = {payload.map(groupLabel).join(' + ')}</span>
          <span className="num font-semibold"> · total {total} mm</span>
          {maxTotal !== undefined && total > maxTotal && (
            <span className="text-danger font-medium"> · only {maxTotal} mm is left on this order</span>
          )}
        </div>
      )}
    </div>
  );
}
