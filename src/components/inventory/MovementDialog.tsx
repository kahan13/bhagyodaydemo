'use client';

import { useState } from 'react';
import { X, Check } from 'lucide-react';
import { fmtQty } from '@/lib/format';
import type { Channel, Sku } from '@/lib/types';

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
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = Number(qty || 0);
  // For an adjustment the worker types the counted physical stock, not a delta.
  const delta = action === 'adjust' ? amount - sku.current_stock : amount;
  const projected = action === 'inward' ? sku.current_stock + amount
    : action === 'outward' ? sku.current_stock - amount
    : amount;

  const title = action === 'inward' ? 'Record inward'
    : action === 'outward' ? 'Record outward' : 'Adjust stock';

  const invalid =
    !qty ||
    (action !== 'adjust' && amount <= 0) ||
    (action === 'outward' && amount > sku.current_stock) ||
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
        reference: reference || (action === 'adjust' ? 'PHYSICAL COUNT' : null),
        notes: notes || null,
        channel,
      }),
    });

    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setError(json.error ?? 'That did not go through.'); return; }
    onDone(Number(json.movement.new_stock));
  }

  return (
    <div className="fixed inset-0 z-[70] grid place-items-end sm:place-items-center bg-ink/30 backdrop-blur-[2px] p-0 sm:p-4">
      <form
        onSubmit={submit}
        className="w-full sm:max-w-[420px] bg-surface border-t sm:border border-line sm:rounded-xl rounded-t-2xl shadow-lg slide-up"
      >
        <div className="card-head border-b">
          <h2 className="card-title">{title}</h2>
          <button type="button" className="btn btn-ghost h-7 w-7 p-0" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>

        <div className="p-5 space-y-3.5">
          <div className="bg-subtle rounded-lg px-3.5 py-3">
            <p className="text-[14px] font-medium">{sku.exact_size}</p>
            <p className="text-[11px] text-ink-3 mt-0.5">
              {sku.brand_name} · {sku.family_name}
            </p>
            <p className="num text-[12px] text-ink-2 mt-1.5">
              In stock {fmtQty(sku.current_stock, sku.unit_code)}
            </p>
          </div>

          <div>
            <label className="label" htmlFor="qty">
              {action === 'adjust'
                ? `Counted physical stock (${sku.unit_code})`
                : `Quantity (${sku.unit_code})`}
            </label>
            <input
              id="qty"
              className="field num text-[16px] h-11"
              inputMode="decimal"
              autoFocus
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0"
            />
          </div>

          <div>
            <label className="label" htmlFor="ref">Reference</label>
            <input
              id="ref" className="field" value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={action === 'inward' ? 'PO-1042' : action === 'outward' ? 'SO-4108' : 'Stock count'}
            />
          </div>

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

          {qty && (
            <div className="rounded-lg border border-line px-3.5 py-2.5 text-[13px] num space-y-1">
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

          {action === 'outward' && amount > sku.current_stock && (
            <p className="text-[12px] text-danger">
              Only {fmtQty(sku.current_stock, sku.unit_code)} available.
            </p>
          )}

          {error && <p className="text-[12px] text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-line bg-subtle sm:rounded-b-xl">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || invalid}>
            {busy ? 'Saving…' : <><Check size={14} /> Confirm</>}
          </button>
        </div>
      </form>
    </div>
  );
}
