import type { SupabaseClient } from '@supabase/supabase-js';
import { fmtMmPcs, fmtQty, fmtArea, fmtLenWidPcs, fmtRollSize } from '@/lib/format';

/**
 * A production-order line for a roll-tracked product is made of one or more PARTS.
 * Each part says how much is cut (MM × PCS) and which roll it comes from — described the way the shop
 * knows rolls, by what they are and how long they are (there are no lot numbers on the shelf):
 *
 *   25 mm × 9 pcs   225 mm total
 *     from Cut Pcs of 230 mm
 *   25 mm × 1 pcs   25 mm total
 *     from Full Sleeve of 450 mm
 *
 * Free of server imports so client components can use it.
 */

export interface AllocPart {
  seg_no: number | null;
  /** length of each piece in this part (null on orders made before parts existed) */
  mm: number | null;
  pcs: number | null;
  /** quantity of this part (mm × pcs) */
  qty: number;
  /** how long the roll was when the order was placed (230 for a cut roll, 450 for a full sleeve).
   *  Open Roll / Rubber: the roll's LENGTH in mm at that time. */
  size: number | null;
  /** Open Roll / Rubber only: width of each piece (mm) */
  width_mm?: number | null;
  /** Open Roll / Rubber only: width of the roll it comes from (mm) */
  size_w?: number | null;
  /** only used to find the roll again; never shown */
  lot_no: string;
  status: 'FULL_SLEEVE' | 'CUT_PCS';
  label: 'Full Sleeve' | 'Cut Pcs' | 'Open Roll';
}

/** Open Roll / Rubber is kept as AREA (unit MM2): there is no sleeve / cut-pcs split, only width × length. */
export const isAreaCode = (unitCode?: string | null): boolean => (unitCode ?? '').toUpperCase() === 'MM2';

export const unitWordOf = (unitCode?: string | null): string => ((unitCode ?? '').toUpperCase() === 'RIB' ? 'ribs' : 'mm');

/** "25 mm × 9 pcs"  (older orders: "225 mm") */
export function partMain(p: AllocPart, unitCode?: string | null): string {
  if (isAreaCode(unitCode) && p.mm && p.pcs && p.width_mm) return fmtLenWidPcs(p.mm, p.width_mm, p.pcs);
  return p.mm && p.pcs && p.mm * p.pcs === p.qty ? fmtMmPcs(p.mm, p.pcs, unitWordOf(unitCode)) : fmtQty(p.qty, unitCode);
}

/** "225 mm total" — empty when the main text already is the total (older orders) */
export function partTotal(p: AllocPart, unitCode?: string | null): string {
  if (isAreaCode(unitCode)) return p.mm && p.pcs && p.width_mm ? `${fmtArea(p.qty)} total` : '';
  return p.mm && p.pcs && p.mm * p.pcs === p.qty ? `${fmtQty(p.qty, unitCode)} total` : '';
}

/** "25 mm × 9 pcs (225 mm total)" for running text */
export function partLine(p: AllocPart, unitCode?: string | null): string {
  const t = partTotal(p, unitCode);
  return t ? `${partMain(p, unitCode)} (${t})` : partMain(p, unitCode);
}

/** "from Cut Pcs of 230 mm" / "from Full Sleeve of 450 mm" */
export const fromTag = (p: AllocPart, unitCode?: string | null): string =>
  isAreaCode(unitCode)
    ? `from Open Roll${p.size && p.size_w ? ` of ${fmtRollSize(p.size_w, p.size)}` : ''}`
    : `from ${p.label}${p.size ? ` of ${fmtQty(p.size, unitCode)}` : ''}`;

/** The whole line as one figure: "250 mm". */
export function totalLine(
  item: { quantity: number | string; unit_code?: string | null },
  _parts?: AllocPart[],
): string {
  return fmtQty(Number(item.quantity ?? 0), item.unit_code);
}

/** Parts of each production-order item, in the order they were entered. */
export async function loadItemParts(db: SupabaseClient, itemIds: string[]): Promise<Record<string, AllocPart[]>> {
  const out: Record<string, AllocPart[]> = {};
  if (itemIds.length === 0) return out;
  const { data } = await db
    .from('lot_allocations')
    .select('item_id,allocated_qty,lot_status,piece_qty,seg_no,seg_mm,seg_pcs,seg_width_mm,piece_width_mm,created_at,sku_lots(lot_no,status,current_qty,width_mm)')
    .in('item_id', itemIds)
    .order('seg_no', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  type Row = {
    item_id: string; allocated_qty: number; lot_status: string | null; piece_qty: number | null; seg_no: number | null;
    seg_mm: number | null; seg_pcs: number | null; seg_width_mm?: number | null; piece_width_mm?: number | null;
    sku_lots: { lot_no: string; status: string; current_qty: number; width_mm?: number | null } | { lot_no: string; status: string; current_qty: number; width_mm?: number | null }[] | null;
  };
  for (const r of (data ?? []) as unknown as Row[]) {
    const lot = Array.isArray(r.sku_lots) ? r.sku_lots[0] : r.sku_lots;
    const status = (r.lot_status ?? lot?.status ?? 'CUT_PCS') === 'FULL_SLEEVE' ? 'FULL_SLEEVE' : 'CUT_PCS';
    const rubber = r.seg_width_mm != null || r.piece_width_mm != null;
    // Open Roll: the roll's size at order time = its width × (area ÷ width)
    const rollW = rubber ? Number(r.piece_width_mm ?? lot?.width_mm ?? 0) || null : null;
    const rollArea = r.piece_qty != null ? Number(r.piece_qty) : lot?.current_qty != null ? Number(lot.current_qty) : null;
    (out[r.item_id] ??= []).push({
      seg_no: r.seg_no,
      mm: r.seg_mm != null ? Number(r.seg_mm) : null,
      pcs: r.seg_pcs != null ? Number(r.seg_pcs) : null,
      qty: Number(r.allocated_qty),
      // the roll's length when the order was placed (kept on the allocation); older rows fall back to the roll as it is now
      size: rubber ? (rollW && rollArea != null ? rollArea / rollW : null) : rollArea,
      width_mm: rubber && r.seg_width_mm != null ? Number(r.seg_width_mm) : null,
      size_w: rollW,
      lot_no: lot?.lot_no ?? '—',
      status,
      label: rubber ? 'Open Roll' : status === 'FULL_SLEEVE' ? 'Full Sleeve' : 'Cut Pcs',
    });
  }
  return out;
}
