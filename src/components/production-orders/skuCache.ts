import { supabaseBrowser } from '@/lib/supabase-browser';
import type { LotGroup, Sku } from '@/lib/types';

/**
 * The SKU list (with live physical stock and free lots) used by the production-order screen.
 * Kept in memory so the search box opens instantly; every screen that changes stock calls
 * invalidateSkuCache() so the next search sees fresh numbers.
 */

export interface SkuAtp {
  sku_id: string;
  current_stock: number;
  physical_prod_stock: number;
  reserved_qty: number;
  atp_stock: number;
}

export type SkuPick = { sku: SkuWithAtp | null; query: string; group?: LotGroup | null };

export type SkuWithAtp = Sku & {
  atp_stock: number;        // = physical_prod_stock (already decremented by open orders)
  reserved_qty: number;
};

let _skuCache: SkuWithAtp[] | null = null;
let _skuInflight: Promise<SkuWithAtp[]> | null = null;
let _skuVersion = 0;

function fetchSkus(): Promise<SkuWithAtp[]> {
  if (_skuInflight) return _skuInflight;

  const p: Promise<SkuWithAtp[]> = Promise.all([
    supabaseBrowser()
      .from('v_sku_status')
      .select(
        'id,sku_code,display_name,exact_size,brand_name,family_name,unit_code,product_type,' +
        'hier_l1,hier_l2,hier_l3,search_text,brand_code,family_code,profile_group,belt_form,' +
        'construction,standard,pitch_mm,pitch_length_mm,width_mm,teeth,nominal_length,' +
        'length_designation,rack_location,opening_stock,current_stock,min_stock_level,' +
        'supplier_moq,reorder_quantity,supplier_name,is_active,stock_status,shortfall,suggested_purchase_qty'
      )
      .eq('is_active', true)
      .order('product_type')
      .order('hier_l1')
      .order('hier_l2'),
    supabaseBrowser()
      .from('v_sku_atp')
      .select('sku_id,current_stock,physical_prod_stock,reserved_qty,atp_stock'),
    supabaseBrowser()
      .from('v_sku_lot_groups_free')
      .select('sku_id,status,piece_qty,pieces,total_qty'),
  ]).then(([skuRes, atpRes, grpRes]) => {
    const groups: Record<string, LotGroup[]> = {};
    for (const r of ((grpRes.data ?? []) as unknown as (LotGroup & { sku_id: string })[])) {
      (groups[r.sku_id] ??= []).push({
        status: r.status, piece_qty: Number(r.piece_qty), pieces: Number(r.pieces), total_qty: Number(r.total_qty),
      });
    }
    for (const k of Object.keys(groups)) {
      groups[k].sort((a, b) => (a.status === b.status ? b.piece_qty - a.piece_qty : a.status === 'FULL_SLEEVE' ? -1 : 1));
    }
    if (atpRes.error) {
      console.error('[ATP] v_sku_atp fetch failed:', atpRes.error.message);
    }
    const skuData = (skuRes.data ?? []) as unknown as Sku[];
    const atpData = (atpRes.data ?? []) as SkuAtp[];

    const atpMap: Record<string, SkuAtp> = {};
    for (const row of atpData) atpMap[row.sku_id] = row;

    _skuCache = skuData.map((s) => ({
      ...s,
      physical_prod_stock: atpMap[s.id]?.physical_prod_stock ?? s.current_stock,
      atp_stock:           atpMap[s.id]?.atp_stock ?? s.current_stock,
      reserved_qty:        atpMap[s.id]?.reserved_qty ?? 0,
      lot_groups:          groups[s.id],
    }));
    _skuInflight = null;
    return _skuCache;
  });

  _skuInflight = p;
  return p;
}

/** The list if it is already in memory (so the search box can open without a spinner). */
export const peekSkus = (): SkuWithAtp[] | null => _skuCache;

export function loadSkus(): Promise<SkuWithAtp[]> {
  if (_skuCache) return Promise.resolve(_skuCache);
  return fetchSkus();
}

export function invalidateSkuCache() {
  _skuCache = null;
  _skuInflight = null;
  _skuVersion += 1;
}
export function getSkuVersion() { return _skuVersion; }