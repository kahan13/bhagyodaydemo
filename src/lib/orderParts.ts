import type { SupabaseClient } from '@supabase/supabase-js';
import { fmtMmPcs, fmtQty } from '@/lib/format';

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
  /** how long the roll was when the order was placed (230 for a cut roll, 450 for a full sleeve) */
  size: number | null;
  /** only used to find the roll again; never shown */
  lot_no: string;
  status: 'FULL_SLEEVE' | 'CUT_PCS';
  label: 'Full Sleeve' | 'Cut Pcs';
}

export const unitWordOf = (unitCode?: string | null): string => ((unitCode ?? '').toUpperCase() === 'RIB' ? 'ribs' : 'mm');

/** "25 mm × 9 pcs"  (older orders: "225 mm") */
export function partMain(p: AllocPart, unitCode?: string | null): string {
  return p.mm && p.pcs && p.mm * p.pcs === p.qty ? fmtMmPcs(p.mm, p.pcs, unitWordOf(unitCode)) : fmtQty(p.qty, unitCode);
}

/** "225 mm total" — empty when the main text already is the total (older orders) */
export function partTotal(p: AllocPart, unitCode?: string | null): string {
  return p.mm && p.pcs && p.mm * p.pcs === p.qty ? `${fmtQty(p.qty, unitCode)} total` : '';
}

/** "25 mm × 9 pcs (225 mm total)" for running text */
export function partLine(p: AllocPart, unitCode?: string | null): string {
  const t = partTotal(p, unitCode);
  return t ? `${partMain(p, unitCode)} (${t})` : partMain(p, unitCode);
}

/** "from Cut Pcs of 230 mm" / "from Full Sleeve of 450 mm" */
export const fromTag = (p: AllocPart, unitCode?: string | null): string =>
  `from ${p.label}${p.size ? ` of ${fmtQty(p.size, unitCode)}` : ''}`;

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
    .select('item_id,allocated_qty,lot_status,piece_qty,seg_no,seg_mm,seg_pcs,created_at,sku_lots(lot_no,status,current_qty)')
    .in('item_id', itemIds)
    .order('seg_no', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true });
  type Row = {
    item_id: string; allocated_qty: number; lot_status: string | null; piece_qty: number | null; seg_no: number | null;
    seg_mm: number | null; seg_pcs: number | null;
    sku_lots: { lot_no: string; status: string; current_qty: number } | { lot_no: string; status: string; current_qty: number }[] | null;
  };
  for (const r of (data ?? []) as unknown as Row[]) {
    const lot = Array.isArray(r.sku_lots) ? r.sku_lots[0] : r.sku_lots;
    const status = (r.lot_status ?? lot?.status ?? 'CUT_PCS') === 'FULL_SLEEVE' ? 'FULL_SLEEVE' : 'CUT_PCS';
    (out[r.item_id] ??= []).push({
      seg_no: r.seg_no,
      mm: r.seg_mm != null ? Number(r.seg_mm) : null,
      pcs: r.seg_pcs != null ? Number(r.seg_pcs) : null,
      qty: Number(r.allocated_qty),
      // the roll's length when the order was placed (kept on the allocation); older rows fall back to the roll as it is now
      size: r.piece_qty != null ? Number(r.piece_qty) : lot?.current_qty != null ? Number(lot.current_qty) : null,
      lot_no: lot?.lot_no ?? '—',
      status,
      label: status === 'FULL_SLEEVE' ? 'Full Sleeve' : 'Cut Pcs',
    });
  }
  return out;
}
