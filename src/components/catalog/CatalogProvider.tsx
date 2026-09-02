'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import type { Sku } from '@/lib/types';

/* =============================================================================
   The whole SKU catalogue, fetched once and held in memory.
   -----------------------------------------------------------------------------
   A few hundred SKUs is well under a megabyte, so keeping it client-side makes
   browsing, filtering, searching and voice matching instant — no round trip per
   keystroke or tab switch. The cache lives at module scope, so moving between
   pages reuses it instead of refetching.

   Stock figures still come from the server: after any movement, refresh() pulls
   fresh numbers. The cache is a convenience, never the source of truth.
   ========================================================================== */

const COLUMNS =
  'id,sku_code,product_type,display_name,exact_size,hier_l1,hier_l2,hier_l3,search_text,' +
  'brand_code,brand_name,family_code,family_name,profile_group,belt_form,construction,standard,' +
  'pitch_mm,pitch_length_mm,width_mm,teeth,nominal_length,length_designation,rack_location,' +
  'unit_code,opening_stock,current_stock,min_stock_level,supplier_moq,reorder_quantity,' +
  'supplier_name,is_active,stock_status,shortfall,suggested_purchase_qty';

let cache: Sku[] | null = null;
let inflight: Promise<Sku[]> | null = null;

async function load(force = false): Promise<Sku[]> {
  if (cache && !force) return cache;
  if (inflight && !force) return inflight;

  // Awaited rather than chained with .then(): the query builder's thenable
  // leaves its callback parameters untyped, which strict mode rejects.
  inflight = (async () => {
    try {
      const { data, error } = await supabaseBrowser()
        .from('v_sku_status')
        .select(COLUMNS)
        .eq('is_active', true)
        .order('product_type')
        .order('hier_l1')
        .order('hier_l2')
        .order('hier_l3');

      if (error) throw new Error(error.message);
      cache = (data ?? []) as unknown as Sku[];
      return cache;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

interface CatalogValue {
  skus: Sku[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Applies a committed movement locally so the figure updates immediately. */
  applyStock: (skuCode: string, newStock: number) => void;
  search: (query: string, limit?: number) => Sku[];
}

const CatalogContext = createContext<CatalogValue | null>(null);

export function CatalogProvider({ children }: { children: React.ReactNode }) {
  const [skus, setSkus] = useState<Sku[]>(cache ?? []);
  const [loading, setLoading] = useState(!cache);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!cache) {
      load()
        .then((rows) => { if (mounted.current) { setSkus(rows); setLoading(false); } })
        .catch((e: Error) => { if (mounted.current) { setError(e.message); setLoading(false); } });
    }
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const rows = await load(true);
      if (mounted.current) { setSkus([...rows]); setError(null); }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }, []);

  const applyStock = useCallback((skuCode: string, newStock: number) => {
    if (!cache) return;
    const row = cache.find((s) => s.sku_code === skuCode);
    if (!row) return;
    row.current_stock = newStock;
    row.stock_status = newStock <= 0 ? 'OUT_OF_STOCK'
      : newStock < row.min_stock_level ? 'LOW_STOCK' : 'OK';
    row.shortfall = Math.max(row.min_stock_level - newStock, 0);
    row.suggested_purchase_qty = newStock < row.min_stock_level
      ? Math.max(row.supplier_moq, row.min_stock_level - newStock) : 0;
    setSkus([...cache]);
  }, []);

  const search = useCallback((query: string, limit = 40): Sku[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const scored: { sku: Sku; rank: number }[] = [];

    for (const sku of skus) {
      const hay = `${sku.exact_size} ${sku.brand_name} ${sku.family_code} ${sku.sku_code}`.toLowerCase();
      let rank = 0;
      let all = true;
      for (const t of terms) {
        if (!hay.includes(t)) { all = false; break; }
        if (sku.exact_size.toLowerCase().startsWith(t)) rank += 12;
        else if (sku.exact_size.toLowerCase().includes(t)) rank += 8;
        if (sku.brand_name.toLowerCase().startsWith(t)) rank += 5;
        rank += 1;
      }
      if (all) scored.push({ sku, rank });
    }

    return scored.sort((a, b) => b.rank - a.rank).slice(0, limit).map((s) => s.sku);
  }, [skus]);

  const value = useMemo(
    () => ({ skus, loading, error, refresh, applyStock, search }),
    [skus, loading, error, refresh, applyStock, search],
  );

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

export function useCatalog(): CatalogValue {
  const ctx = useContext(CatalogContext);
  if (!ctx) throw new Error('useCatalog must be used inside CatalogProvider');
  return ctx;
}
