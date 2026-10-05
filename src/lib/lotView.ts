import { fmtQty } from '@/lib/format';

export type LotEntry = { lot_no?: string; status: string; qty: number; new_lot?: boolean; was?: string; restored?: boolean };
export type SnapGroup = { status: 'CUT_PCS' | 'FULL_SLEEVE'; each: number; count: number };
export type LotState = { before: SnapGroup[]; after: SnapGroup[] } | null | undefined;

export const LOT_NAME: Record<string, string> = { FULL_SLEEVE: 'Full Sleeve', CUT_PCS: 'Cut Pcs', EXHAUSTED: 'Used up', WASTED: 'Waste' };

/** text colour class for a lot kind */
export const lotTone = (status: string) =>
  status === 'CUT_PCS' ? 'lot-cut' : status === 'FULL_SLEEVE' ? 'lot-full' : status === 'WASTED' ? 'lot-waste' : '';

/** chip class for a lot kind: Full Sleeve teal, Cut Pcs amber */
export const lotChip = (status: string) =>
  status === 'CUT_PCS' ? 'chip-cut' : status === 'FULL_SLEEVE' ? 'chip-full' : status === 'WASTED' ? 'chip-waste' : 'chip-plain';

/** "445 mm" — always with its unit */
export const withUnit = (q: number, unit: string) => fmtQty(q, unit);

/** One movement's quantity split by lot kind: [{label,status,text}] — unit always shown. */
export function qtySplit(entries: LotEntry[] | null | undefined, unit: string, isNewRolls: boolean) {
  if (!entries || entries.length === 0) return [] as { key: string; status: string; text: string }[];
  if (isNewRolls) {
    const by = new Map<number, number>();
    for (const e of entries) by.set(Number(e.qty), (by.get(Number(e.qty)) ?? 0) + 1);
    return [...by.entries()].map(([len, n]) => ({
      key: `r${len}`, status: 'FULL_SLEEVE',
      text: `${n} × ${fmtQty(len, unit)} Full Sleeve`,
    }));
  }
  const by = new Map<string, number>();
  for (const e of entries) {
    const st = e.status === 'WASTED' ? (e.was ?? 'WASTED') : e.status;
    by.set(st, (by.get(st) ?? 0) + Number(e.qty));
  }
  return [...by.entries()]
    .sort((a, b) => (a[0] === 'CUT_PCS' ? -1 : 1) - (b[0] === 'CUT_PCS' ? -1 : 1))
    .map(([st, q]) => ({ key: st, status: st, text: `${fmtQty(q, unit)} ${LOT_NAME[st] ?? st}` }));
}

export const snapTotal = (g: SnapGroup[]) => g.reduce((s, x) => s + Number(x.each) * Number(x.count), 0);
