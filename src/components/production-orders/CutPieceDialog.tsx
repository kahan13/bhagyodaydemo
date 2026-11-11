'use client';

import { useEffect, useMemo, useState } from 'react';
import { Scissors, Loader, AlertTriangle, ArrowRight } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtRollSize, fmtWidMm, fmtLenM } from '@/lib/format';
import { mFromTyped } from '@/components/inventory/RubberEntry';
import { previewCut, usePendingCuts, pieceKindLabel } from '@/lib/rubberCuts';
import type { SkuPick } from './skuCache';
import SkuCombobox from './SkuCombobox';

/**
 * Create a cut piece (Open Roll / Rubber).
 *
 *   1. pick the product      2. pick the roll to cut from (shown width × length)
 *   3. type the cut: WIDTH mm × LENGTH m × QTY
 *   → below it: the roll as it is, the cut entered, and what it will look like afterwards.
 *
 * Nothing is automatic and no stock moves here: the cut starts as PENDING. The books change only when
 * someone presses Reconcile (Mismatch → Open Roll – cut pieces, or the banner on the production order screen).
 */

interface RollRow {
  id: string; lot_no: string; width_mm: number; len_mm: number; free: boolean; kind: string;
}

export default function CutPieceDialog({
  initialSku, onClose, onCreated, cacheVersion = 0,
}: {
  initialSku?: SkuPick['sku'];
  onClose: () => void;
  onCreated: (cutNo: string, sku: SkuPick['sku']) => void;
  cacheVersion?: number;
}) {
  const db = supabaseBrowser();
  const [pick, setPick] = useState<SkuPick>({ sku: initialSku ?? null, query: initialSku?.display_name ?? '' });
  const [rolls, setRolls] = useState<RollRow[] | null>(null);
  const [lotId, setLotId] = useState('');
  const [wid, setWid] = useState('');
  const [len, setLen] = useState('');
  const [pcs, setPcs] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const skuId = pick.sku?.id ?? null;
  const { cuts: pending } = usePendingCuts(skuId);
  const pendingLots = useMemo(() => new Set(pending.map((c) => c.source_lot_id)), [pending]);

  useEffect(() => {
    let alive = true;
    setRolls(null); setLotId('');
    if (!skuId) return;
    (async () => {
      const { data } = await db.from('v_lot_free')
        .select('id,lot_no,width_mm,current_qty,free_qty,piece_kind,created_at')
        .eq('sku_id', skuId).in('status', ['FULL_SLEEVE', 'CUT_PCS'])
        .order('created_at', { ascending: true });
      if (!alive) return;
      type R = { id: string; lot_no: string; width_mm: number | null; current_qty: number; free_qty: number; piece_kind: string };
      setRolls(((data ?? []) as unknown as R[]).filter((r) => Number(r.width_mm) > 0).map((r) => ({
        id: r.id, lot_no: r.lot_no, width_mm: Number(r.width_mm), len_mm: Number(r.current_qty) / Number(r.width_mm),
        free: Number(r.free_qty) >= Number(r.current_qty), kind: r.piece_kind,
      })));
    })();
    return () => { alive = false; };
  }, [skuId, db, cacheVersion]);

  const roll = rolls?.find((r) => r.id === lotId) ?? null;
  const w = Number(wid) || 0, l = mFromTyped(len), n = Math.floor(Number(pcs)) || 0;
  const prev = roll ? previewCut(roll.width_mm, roll.len_mm, w, l, n) : null;
  const entered = w > 0 && l > 0 && n >= 1;

  async function create() {
    if (!roll || !prev?.ok) return;
    setSaving(true); setError('');
    const { data, error: err } = await db.rpc('create_rubber_cut', { p_lot_id: roll.id, p_width_mm: w, p_len_mm: l, p_pcs: n, p_notes: null });
    setSaving(false);
    if (err) { setError(err.message); return; }
    onCreated((data as { cut_no: string }).cut_no, pick.sku);
  }

  return (
    <Modal
      z={80} width="max-w-[640px]" title="Create cut piece"
      icon={<span className="shrink-0 rounded-full bg-brand/10 p-1.5"><Scissors size={15} className="text-brand" /></span>}
      onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); create(); }}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving || !roll || !prev?.ok}>
            {saving ? <Loader size={14} className="animate-spin" /> : <Scissors size={14} />} Create cut piece
          </button>
        </>
      }
    >
      <p className="text-[14px] text-ink-3">
        Cut a piece out of a roll first, then make the production order from it. Creating a cut piece does not
        move stock — it only separates the piece. The book shows the full roll until you reconcile it.
      </p>

      <div>
        <label className="eyebrow mb-1 block">1 · Product</label>
        <SkuCombobox onlyCategory="OPEN_ROLL" value={pick} onChange={setPick} cacheVersion={cacheVersion} placeholder="Search size, brand or code" />
      </div>

      {pick.sku && (
        <div>
          <label className="eyebrow mb-1 block">2 · Roll to cut from</label>
          {rolls === null ? (
            <p className="text-[14px] text-ink-3 flex items-center gap-2"><Loader size={13} className="animate-spin" /> Loading rolls…</p>
          ) : rolls.length === 0 ? (
            <p className="text-[14px] text-danger font-medium">No roll in stock for this product.</p>
          ) : (
            <select className="field" value={lotId} onChange={(e) => setLotId(e.target.value)} aria-label="Roll to cut from">
              <option value="">Select roll…</option>
              {rolls.map((r) => {
                const blocked = pendingLots.has(r.id) ? 'cut waiting to be reconciled' : !r.free ? 'planned in an order' : '';
                return (
                  <option key={r.id} value={r.id} disabled={!!blocked}>
                    {pieceKindLabel(r.kind)} · {fmtRollSize(r.width_mm, r.len_mm)}{blocked ? ` (${blocked})` : ''}
                  </option>
                );
              })}
            </select>
          )}
        </div>
      )}

      {roll && (
        <div>
          <label className="eyebrow mb-1 block">3 · Cut piece (width × length × qty)</label>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-28">
              <label className="label">WIDTH (mm)</label>
              <input autoFocus className="field num text-[18px] h-11" inputMode="decimal" placeholder="e.g. 50"
                value={wid} onChange={(e) => setWid(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
            <span className="pb-2.5 text-[18px] text-ink-3 font-semibold">×</span>
            <div className="w-28">
              <label className="label">LENGTH (m)</label>
              <input className="field num text-[18px] h-11" inputMode="decimal" placeholder="e.g. 10"
                value={len} onChange={(e) => setLen(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
            <span className="pb-2.5 text-[18px] text-ink-3 font-semibold">×</span>
            <div className="w-24">
              <label className="label">QTY</label>
              <input className="field num text-[18px] h-11" inputMode="numeric" placeholder="1"
                value={pcs} onChange={(e) => setPcs(e.target.value.replace(/[^0-9]/g, ''))} />
            </div>
          </div>
        </div>
      )}

      {roll && (
        <div className="rounded-lg border border-line bg-subtle p-3 space-y-1.5 text-[14px]">
          <p><span className="eyebrow mr-2">Roll</span><b className="num">{fmtRollSize(roll.width_mm, roll.len_mm)}</b> <span className="text-ink-3">· 1 {pieceKindLabel(roll.kind).toLowerCase()}</span></p>
          {entered && (
            <p><span className="eyebrow mr-2">Cut</span><b className="num">{fmtRollSize(w, l)} × {n}</b></p>
          )}
          {entered && prev && !prev.ok && prev.error && (
            <p className="text-danger font-semibold flex items-center gap-1.5"><AlertTriangle size={13} /> {prev.error}</p>
          )}
          {entered && prev?.ok && (
            <>
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="eyebrow mr-1">After</span><ArrowRight size={13} className="text-ink-3" />
                <b className="num text-ok">{n} cut piece{n === 1 ? '' : 's'} · {fmtRollSize(w, l)}</b>
                {prev.partialW && prev.partialLen ? (
                  <><span className="text-ink-3">and</span><b className="num text-ok">1 partial roll · {fmtRollSize(prev.partialW, prev.partialLen)}</b></>
                ) : (
                  <span className="text-ink-3">— nothing is left of the roll</span>
                )}
              </p>
              {prev.stripsNotKept && (
                <p className="text-[13px] text-ink-3">
                  The partial roll is {fmtWidMm(roll.width_mm)} − {fmtWidMm(w)} wide and {fmtLenM(roll.len_mm)} − {fmtLenM(l * n)} long.
                  The strips beside the cut are not kept as stock.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {error && <p className="text-[14px] text-danger font-medium">{error}</p>}
    </Modal>
  );
}
