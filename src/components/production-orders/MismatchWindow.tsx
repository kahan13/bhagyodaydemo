'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import Modal from '@/components/ui/Modal';
import type { SkuMismatch, PendingAdjustment, MismatchOrderItem } from '@/lib/types';
import { MismatchPane, RecordOutwardModal } from './poShared';

/**
 * The Mismatch list, in a window — exactly what the Mismatch tab of Production Order in Progress shows:
 * every difference between book stock and physical stock, traced to the transaction that caused it
 * (an order waiting for its outward, a roll or quantity marked as waste, a stock adjustment),
 * with the same buttons to put it right. Open it for one product, or for all of them.
 */
export default function MismatchWindow({
  skuId, title, onClose,
}: {
  /** only this product's mismatches; leave out for all */
  skuId?: string;
  title?: string;
  onClose: () => void;
}) {
  const db = supabaseBrowser();
  const [mismatches, setMismatches] = useState<SkuMismatch[]>([]);
  const [pending, setPending] = useState<PendingAdjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [outwardTarget, setOutwardTarget] = useState<MismatchOrderItem | null>(null);
  const [recording, setRecording] = useState(false);

  const load = useCallback(async () => {
    // listed when book and physical differ OR an order is still waiting for its outward
    let q = db.from('v_production_stock_status').select('*').or('is_mismatched.eq.true,open_item_count.gt.0');
    if (skuId) q = q.eq('sku_id', skuId);
    let res = await q.order('stock_gap', { ascending: false });
    if (res.error) {            // database not yet updated with 032: fall back to the old test
      let q2 = db.from('v_production_stock_status').select('*').eq('is_mismatched', true);
      if (skuId) q2 = q2.eq('sku_id', skuId);
      res = await q2.order('stock_gap', { ascending: false });
    }
    if (!res.error && res.data) setMismatches(res.data as unknown as SkuMismatch[]);

    let p = db.from('prod_pending_adjustments').select('*, skus(sku_code,display_name,unit_code)').is('resolved_at', null);
    if (skuId) p = p.eq('sku_id', skuId);
    const pend = await p.order('created_at', { ascending: false });
    if (!pend.error && pend.data) setPending(pend.data as unknown as PendingAdjustment[]);
    setLoading(false);
  }, [db, skuId]);

  useEffect(() => { load(); }, [load]);

  async function recordOutward(notes: string, invoiceNo: string, operatedBy: string) {
    if (!outwardTarget) return;
    setRecording(true);
    const { error } = await db.rpc('record_production_outward_with_lots', {
      p_poi_id: outwardTarget.poi_id,
      p_notes: notes || null,
      p_channel: 'WEB',
      p_invoice_no: invoiceNo.trim() || null,
      p_operated_by: operatedBy || null,
    });
    setRecording(false);
    if (error) { window.alert('Error recording outward: ' + error.message); return; }
    setOutwardTarget(null);
    load();
  }

  async function resolve(p: PendingAdjustment) {
    setResolvingId(p.id);
    const { error } = await db.rpc('resolve_prod_adjustment', { p_id: p.id });
    setResolvingId(null);
    if (error) { window.alert(error.message); return; }
    load();
  }

  return (
    <>
      <Modal
        z={80}
        width="max-w-[900px]"
        title={title ?? 'Mismatches'}
        icon={<span className="shrink-0 rounded-full bg-warn/15 p-1.5"><AlertTriangle size={15} className="text-warn" /></span>}
        onClose={onClose}
        bodyClassName="p-0"
        footer={<button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>}
      >
        <p className="px-4 py-2.5 text-[14px] text-ink-3 border-b border-line">
          Book stock against physical production stock, traced to its cause. An order stays here — even after it is completed —
          until its outward is recorded.
        </p>
        <MismatchPane
          mismatches={mismatches} pending={pending}
          onRecordOutward={setOutwardTarget} onResolve={resolve}
          resolvingId={resolvingId} loadingMismatches={loading}
        />
      </Modal>
      {outwardTarget && (
        <RecordOutwardModal
          z={90} item={outwardTarget} onConfirm={recordOutward}
          onCancel={() => setOutwardTarget(null)} recording={recording}
        />
      )}
    </>
  );
}
