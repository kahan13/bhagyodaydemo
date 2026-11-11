'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { onDataChanged } from '@/lib/dataSync';
import { fmtRollSize, fmtLenM, fmtWidMm } from '@/lib/format';
import type { RubberCut } from '@/lib/types';

/**
 * Open Roll / Rubber cut pieces — all in WIDTH (mm) × LENGTH (m).
 *
 * The arithmetic is plain subtraction, the same as the database does it:
 *   cut  w × l, n pieces, laid end to end, from a roll  W × L
 *   partial roll left = (W − w) × (L − n·l)
 *     (a cut as wide as the roll only shortens it → W × (L − n·l); a cut that uses the whole length only narrows it → (W − w) × L)
 */
export interface CutPreview {
  ok: boolean;
  /** why it cannot be cut, in words */
  error: string;
  pcs: number;
  cutW: number; cutLen: number;
  /** the partial roll left; null when nothing is left */
  partialW: number | null; partialLen: number | null;
  /** true when the cut is narrower AND shorter than the roll: the strips beside the cut are not kept as stock */
  stripsNotKept: boolean;
}

export function previewCut(srcW: number, srcLenMm: number, w: number, lenMm: number, pcs: number): CutPreview {
  const base = { pcs, cutW: w, cutLen: lenMm, partialW: null as number | null, partialLen: null as number | null, stripsNotKept: false };
  if (!(w > 0) || !(lenMm > 0) || !(pcs >= 1)) return { ...base, ok: false, error: '' };
  if (w > srcW) return { ...base, ok: false, error: `A ${fmtWidMm(w)} wide piece cannot be cut from a roll that is only ${fmtWidMm(srcW)} wide.` };
  const block = lenMm * pcs;
  if (block > srcLenMm + 1e-6) return { ...base, ok: false, error: `This roll is only ${fmtLenM(srcLenMm)} long, but ${pcs} × ${fmtLenM(lenMm)} needs ${fmtLenM(block)}.` };
  const sameW = Math.abs(w - srcW) < 1e-9;
  const sameL = Math.abs(block - srcLenMm) < 1e-6;
  if (sameW && sameL) return { ...base, ok: true, error: '' };
  return {
    ...base, ok: true, error: '',
    partialW: sameW ? srcW : srcW - w,
    partialLen: sameL ? srcLenMm : srcLenMm - block,
    stripsNotKept: !sameW && !sameL,
  };
}

/** The sentence for a cut:  "100 mm × 50 m roll → 50 mm × 10 m × 1 cut piece + 50 mm × 40 m partial roll" */
export function cutSentence(c: {
  src_width_mm: number; src_len_mm: number; cut_width_mm: number; cut_len_mm: number; pcs: number;
  partial_width_mm: number | null; partial_len_mm: number | null;
}): string {
  const pieces = `${fmtRollSize(c.cut_width_mm, c.cut_len_mm)} × ${c.pcs} cut piece${c.pcs === 1 ? '' : 's'}`;
  const partial = c.partial_width_mm && c.partial_len_mm ? ` + ${fmtRollSize(c.partial_width_mm, c.partial_len_mm)} partial roll` : '';
  return `${fmtRollSize(c.src_width_mm, c.src_len_mm)} roll → ${pieces}${partial}`;
}

/** Pending cuts (all, or one product's), kept live. */
export function usePendingCuts(skuId?: string | null) {
  const [cuts, setCuts] = useState<RubberCut[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    let q = supabaseBrowser().from('v_rubber_cuts').select('*').eq('status', 'PENDING');
    if (skuId) q = q.eq('sku_id', skuId);
    const { data, error } = await q.order('created_at', { ascending: true });
    if (!error && data) {
      setCuts((data as unknown as RubberCut[]).map((c) => ({
        ...c,
        src_width_mm: Number(c.src_width_mm), src_len_mm: Number(c.src_len_mm),
        cut_width_mm: Number(c.cut_width_mm), cut_len_mm: Number(c.cut_len_mm), pcs: Number(c.pcs),
        partial_width_mm: c.partial_width_mm != null ? Number(c.partial_width_mm) : null,
        partial_len_mm: c.partial_len_mm != null ? Number(c.partial_len_mm) : null,
      })));
    }
    setLoading(false);
  }, [skuId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onDataChanged(() => { load(); }), [load]);
  return { cuts, loading, reload: load };
}

/** What a stock piece is called on screen */
export const pieceKindLabel = (kind?: string | null): string =>
  kind === 'CUT_PIECE' ? 'Cut piece' : kind === 'PARTIAL_ROLL' ? 'Partial roll' : 'Roll';

/**
 * What is physically on the shelf for an Open Roll product: the book's lots with every pending cut applied
 * (the source roll is gone, the cut pieces and the partial roll are there instead).
 */
export function physicalGroups(groups: import('@/lib/types').LotGroup[], cuts: RubberCut[]): import('@/lib/types').LotGroup[] {
  const out = groups.map((g) => ({ ...g }));
  const add = (w: number, lenMm: number, n: number, kind: string) => {
    const area = w * lenMm;
    const hit = out.find((g) => Number(g.width_mm) === w && Math.abs(Number(g.piece_qty) - area) < 1e-6 && (g.piece_kind ?? 'ROLL') === kind);
    if (hit) hit.pieces = Number(hit.pieces) + n;
    else out.push({ status: 'FULL_SLEEVE', piece_qty: area, pieces: n, total_qty: area * n, width_mm: w, piece_kind: kind });
  };
  for (const c of cuts) {
    const area = c.src_width_mm * c.src_len_mm;
    const src = out.find((g) => Number(g.width_mm) === c.src_width_mm && Math.abs(Number(g.piece_qty) - area) < 1e-6);
    if (src) src.pieces = Number(src.pieces) - 1;
    add(c.cut_width_mm, c.cut_len_mm, c.pcs, 'CUT_PIECE');
    if (c.partial_width_mm && c.partial_len_mm) add(c.partial_width_mm, c.partial_len_mm, 1, 'PARTIAL_ROLL');
  }
  return out.filter((g) => Number(g.pieces) > 0);
}
