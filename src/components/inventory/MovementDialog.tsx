'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { fmtQty } from '@/lib/format';
import { isLotType, isRubber, lotUnitWord } from '@/lib/lotUnit';
import type { Channel, Sku } from '@/lib/types';
import LotBreakdown from '@/components/inventory/LotBreakdown';
import { OutwardRowsPlan, planRowsOutward } from '@/components/inventory/OutwardPlan';
import RollEntry, { emptyRolls, rollsPayload, rollsTotal } from '@/components/inventory/RollEntry';
import RubberEntry, { emptyRubber, rubberPayload, rubberTotal } from '@/components/inventory/RubberEntry';

/**
 * One dialog for inward, outward and adjustment, on desktop and phone alike.
 * It never computes stock itself — it shows a projection, then lets the
 * database engine decide, so the number on screen can never drift from the
 * ledger.
 */
export default function MovementDialog({
  sku, action, channel, onClose, onDone,
}: {
  sku: Sku;
  action: 'inward' | 'outward' | 'adjust';
  channel: Channel;
  onClose: () => void;
  onDone: (newStock: number) => void;
}) {
  const [qty, setQty] = useState('');
  const [rolls, setRolls] = useState(emptyRolls());
  const [rubber, setRubber] = useState(emptyRubber());
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // timing belts: inward and outward are typed as MM × PCS (outward also says Full Sleeve or Cut Pcs)
  // (poly V belts work the same way, in RIBS × PCS)
  const inRolls = (action === 'inward' || action === 'outward') && isLotType(sku.product_type);
  const unitWord = lotUnitWord(sku.product_type);
  const rub = isRubber(sku.product_type);                 // Open Roll / Rubber: length × width × pcs, stock in area
  const rollList = inRolls ? (rub ? rubberPayload(rubber) : rollsPayload(rolls)) : [];
  const rollProblems = action === 'outward' && inRolls && !rub && sku.lot_groups && sku.lot_groups.length > 0
    ? planRowsOutward(sku.lot_groups, rollList as ReturnType<typeof rollsPayload>, unitWord).problems : [];
  const amount = inRolls ? (rub ? rubberTotal(rubberPayload(rubber)) : rollsTotal(rollsPayload(rolls))) : Number(qty || 0);
  // For an adjustment the worker types the counted physical stock, not a delta.
  const delta = action === 'adjust' ? amount - sku.current_stock : amount;
  const projected = action === 'inward' ? sku.current_stock + amount
    : action === 'outward' ? sku.current_stock - amount
    : amount;

  const title = action === 'inward' ? 'Record inward'
    : action === 'outward' ? 'Record outward' : 'Adjust stock';

  const invalid =
    (!inRolls && !qty) ||
    (inRolls && amount <= 0) ||
    (action !== 'adjust' && amount <= 0) ||
    (action === 'outward' && amount > sku.current_stock) ||
    rollProblems.length > 0 ||
    (rub && action === 'adjust') ||
    (action === 'adjust' && (delta === 0 || !notes.trim()));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch('/api/movements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku_code: sku.sku_code,
        txn_type: action === 'adjust' ? 'ADJUSTMENT' : action.toUpperCase(),
        quantity: action === 'adjust' ? delta : amount,
        unit_code: sku.unit_code,
        reference: action === 'adjust' ? 'PHYSICAL COUNT' : null,
        notes: notes || null,
        channel,
        ...(inRolls ? { rolls: rollList } : {}),
      }),
    });

    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setError(json.error ?? 'That did not go through.'); return; }
    onDone(Number(json.movement.new_stock));
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      onSubmit={submit}
      width="sm:max-w-[420px]"
      align="sheet"
      bodyClassName="p-5 space-y-3.5"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || invalid}>
            {busy ? 'Saving…' : <><Check size={14} /> Confirm</>}
          </button>
        </>
      }
    >

          <div className="bg-subtle rounded-lg px-3.5 py-3">
            <p className="text-[16px] font-medium">{sku.exact_size}</p>
            <p className="text-[13px] text-ink-3 mt-0.5">
              {sku.brand_name} · {sku.family_name}
            </p>
            {sku.lot_groups && sku.lot_groups.length > 0 ? (
              <LotBreakdown groups={sku.lot_groups} unit={unitWord} className="mt-1.5" />
            ) : (
              <p className="num text-[14px] text-ink-2 mt-1.5">
                In stock {fmtQty(sku.current_stock, sku.unit_code)}
              </p>
            )}
          </div>

          {rub && action === 'adjust' ? (
            <p className="text-[14px] text-ink-2 bg-subtle rounded-lg px-3 py-2.5">
              Open Roll stock is corrected roll by roll: add a roll with <strong>Inward</strong> (width × length), take a piece with
              <strong> Outward</strong>, or mark a damaged roll as <strong>waste</strong> from its stock list.
            </p>
          ) : inRolls && rub ? (
            <RubberEntry rows={rubber} onChange={setRubber} mode={action === 'outward' ? 'cut' : 'rolls'}
              maxArea={action === 'outward' ? sku.current_stock : undefined} />
          ) : inRolls ? (
            <RollEntry rows={rolls} onChange={setRolls} mode={action === 'outward' ? 'out' : 'in'} unit={unitWord} />
          ) : (
          <div>
            <label className="label" htmlFor="qty">
              {action === 'adjust'
                ? `Counted physical stock (${sku.unit_code})`
                : `Quantity (${sku.unit_code})`}
            </label>
            <input
              id="qty"
              className="field num text-[18px] h-11"
              inputMode="decimal"
              autoFocus
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0"
            />
          </div>
          )}

          <div>
            <label className="label" htmlFor="notes">
              {action === 'adjust' ? 'Reason (required)' : 'Notes'}
            </label>
            <textarea
              id="notes" rows={2} className="field" value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={action === 'adjust' ? 'Physical stock discrepancy' : 'Optional'}
            />
          </div>

          {amount > 0 && (
            <div className="rounded-lg border border-line px-3.5 py-2.5 text-[15px] num space-y-1">
              <div className="flex justify-between text-ink-2">
                <span>Current</span><span>{fmtQty(sku.current_stock, sku.unit_code)}</span>
              </div>
              <div className="flex justify-between text-ink-2">
                <span>{action === 'adjust' ? 'Adjustment' : title.split(' ')[1]}</span>
                <span>{delta >= 0 ? '+' : '−'}{fmtQty(Math.abs(delta), sku.unit_code)}</span>
              </div>
              <div className="flex justify-between font-semibold border-t border-line pt-1.5 mt-1.5">
                <span>After</span><span>{fmtQty(projected, sku.unit_code)}</span>
              </div>
            </div>
          )}

          {action === 'outward' && inRolls && !rub && (
            <OutwardRowsPlan groups={sku.lot_groups} rows={rollList as ReturnType<typeof rollsPayload>} unit={sku.unit_code} />
          )}

          {action === 'outward' && amount > sku.current_stock && (
            <p className="text-[14px] text-danger">
              Only {fmtQty(sku.current_stock, sku.unit_code)} available.
            </p>
          )}

          {error && <p className="text-[14px] text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}
        
    </Modal>
  );
}
