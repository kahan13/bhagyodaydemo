import { fmtQty, fmtMmPcs, fmtRolls, fmtLenWidPcs, fmtRollSize } from '@/lib/format';

export type LotEntry = {
  lot_no?: string; status: string; qty: number; new_lot?: boolean; was?: string; restored?: boolean;
  /** Open Roll / Rubber (kept in mm; `qty` is then the AREA in mm²) */
  width_mm?: number; len_mm?: number; pcs?: number;
  from_width_mm?: number; from_len_mm?: number; left_len_mm?: number;
  strip_lot_no?: string; strip_width_mm?: number; strip_len_mm?: number;
};
export type SnapGroup = { status: 'CUT_PCS' | 'FULL_SLEEVE'; each: number; count: number; width_mm?: number };

export const isAreaUnitCode = (unit?: string | null): boolean => (unit ?? '').toUpperCase() === 'MM2';

/** "25 mm × 10 m" for a snapshot group of Open Roll pieces (`each` is the area, so length = area ÷ width). */
export const snapRollSize = (g: SnapGroup): string => fmtRollSize(g.width_mm, Number(g.each) / Number(g.width_mm || 1));

/**
 * What an Open Roll movement did, one chip per roll size / cut — always width and length with their units:
 *   inward   "25 mm × 10 m × 3 rolls"
 *   outward  "2.5 m × 25 mm × 4 pcs  from  45 mm × 30 m"   (+ "side strip 20 mm × 10 m kept" when one is left)
 */
function rubberSplit(entries: LotEntry[], unit: string, isNewRolls: boolean) {
  const out: { key: string; status: string; text: string }[] = [];
  if (isNewRolls && entries.every((e) => e.width_mm && e.len_mm)) {
    const by = new Map<string, { w: number; l: number; n: number }>();
    for (const e of entries) {
      const k = `${e.width_mm}x${e.len_mm}`;
      const cur = by.get(k) ?? { w: Number(e.width_mm), l: Number(e.len_mm), n: 0 };
      cur.n += 1; by.set(k, cur);
    }
    return [...by.entries()].map(([k, v]) => ({ key: `r${k}`, status: 'OPEN_ROLL', text: fmtRolls(v.w, v.l, v.n) }));
  }
  entries.forEach((e, i) => {
    if (e.width_mm && e.len_mm && e.pcs && e.from_width_mm && e.from_len_mm) {
      out.push({ key: `c${i}`, status: 'OPEN_ROLL',
        text: `${fmtLenWidPcs(e.len_mm, e.width_mm, e.pcs)} from ${fmtRollSize(e.from_width_mm, e.from_len_mm)}` });
      if (e.strip_width_mm && e.strip_len_mm)
        out.push({ key: `s${i}`, status: 'OPEN_ROLL', text: `side strip ${fmtRollSize(e.strip_width_mm, e.strip_len_mm)} kept` });
    } else {
      const st = e.status === 'WASTED' ? 'WASTED' : 'OPEN_ROLL';
      out.push({ key: `o${i}`, status: st, text: `${fmtQty(e.qty, unit)} ${st === 'WASTED' ? 'Waste' : 'Open Roll'}` });
    }
  });
  return out;
}
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
  if (isAreaUnitCode(unit)) return rubberSplit(entries, unit, isNewRolls);
  if (isNewRolls) {
    const by = new Map<number, number>();
    for (const e of entries) by.set(Number(e.qty), (by.get(Number(e.qty)) ?? 0) + 1);
    return [...by.entries()].map(([len, n]) => ({
      key: `r${len}`, status: 'FULL_SLEEVE',
      text: `${fmtMmPcs(len, n, unit.toUpperCase() === 'RIB' ? 'ribs' : 'mm')} Full Sleeve`,
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
