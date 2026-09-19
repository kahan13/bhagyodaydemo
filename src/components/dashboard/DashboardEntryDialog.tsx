'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import { X, Check, Search, ChevronDown } from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { fmtQty } from '@/lib/format';
import type { ProductType, Sku } from '@/lib/types';

interface User { id: string; full_name: string; }

export default function DashboardEntryDialog({
  action, users, lastRef, lastInvoice, onClose, onDone,
}: {
  action: 'inward' | 'outward';
  users: User[];
  lastRef: string | null;
  lastInvoice: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { skus } = useCatalog();
  const [productType, setProductType] = useState<ProductType>('TIMING_BELT');
  const [search, setSearch] = useState('');
  const [dropOpen, setDropOpen] = useState(false);
  const [sku, setSku] = useState<Sku | null>(null);
  const [qty, setQty] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [operatedBy, setOperatedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const pool = useMemo(() => {
    const q = search.trim().toLowerCase();
    return skus
      .filter((s) => s.product_type === productType && s.is_active)
      .filter((s) =>
        !q ||
        s.exact_size.toLowerCase().includes(q) ||
        s.brand_name.toLowerCase().includes(q) ||
        s.hier_l1.toLowerCase().includes(q) ||
        s.sku_code.toLowerCase().includes(q)
      )
      .slice(0, 40);
  }, [skus, productType, search]);

  const selectSku = (s: Sku) => {
    setSku(s);
    setSearch(`${s.exact_size} — ${s.brand_name}`);
    setDropOpen(false);
  };

  const clearSku = () => {
    setSku(null);
    setSearch('');
    setDropOpen(false);
    setTimeout(() => searchRef.current?.focus(), 50);
  };

  const amount = Number(qty || 0);
  const projected = action === 'inward' ? (sku?.current_stock ?? 0) + amount
    : (sku?.current_stock ?? 0) - amount;

  const invalid =
    !sku || !qty || amount <= 0 ||
    (action === 'outward' && sku && amount > sku.current_stock);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sku || invalid) return;
    setBusy(true); setError(null);

    const body: Record<string, unknown> = {
      sku_code: sku.sku_code,
      txn_type: action.toUpperCase(),
      quantity: amount,
      unit_code: sku.unit_code,
      reference: reference.trim() || null,
      notes: notes.trim() || null,
      channel: 'WEB',
    };
    if (action === 'outward') {
      if (invoiceNo.trim()) body.invoice_no = invoiceNo.trim();
      if (operatedBy) body.operated_by = operatedBy;
    }

    const res = await fetch('/api/movements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setError(json.error ?? 'Something went wrong.'); return; }
    onDone();
  };

  const title = action === 'inward' ? 'Record Inward' : 'Record Outward';

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-ink/30 backdrop-blur-[2px] p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-[480px] bg-surface border border-line rounded-xl shadow-xl"
      >
        {/* Header */}
        <div className="card-head border-b">
          <h2 className="card-title">{title}</h2>
          <button type="button" className="btn btn-ghost h-7 w-7 p-0" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Product type */}
          <div className="flex gap-1 p-1 bg-subtle rounded-lg">
            {(['TIMING_BELT', 'V_BELT'] as ProductType[]).map((t) => (
              <button
                key={t} type="button"
                onClick={() => { setProductType(t); clearSku(); }}
                className={`flex-1 py-1.5 text-[13px] rounded-md font-medium transition-colors ${
                  productType === t ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
                }`}
              >
                {t === 'TIMING_BELT' ? 'Timing Belt' : 'V-Belt'}
              </button>
            ))}
          </div>

          {/* Product search */}
          <div ref={dropRef} className="relative">
            <label className="label">Product <span className="text-danger">*</span></label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
              <input
                ref={searchRef}
                className="field pl-8 pr-8"
                placeholder="Search size, brand or SKU…"
                value={search}
                autoComplete="off"
                onChange={(e) => { setSearch(e.target.value); setSku(null); setDropOpen(true); }}
                onFocus={() => setDropOpen(true)}
              />
              {sku ? (
                <button type="button" onClick={clearSku} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink">
                  <X size={13} />
                </button>
              ) : (
                <ChevronDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
              )}
            </div>

            {dropOpen && !sku && (
              <div className="absolute z-10 mt-1 w-full bg-surface border border-line rounded-lg shadow-lg max-h-52 overflow-y-auto">
                {pool.length === 0 ? (
                  <p className="px-3 py-4 text-[13px] text-ink-3 text-center">No matches</p>
                ) : pool.map((s) => (
                  <button
                    key={s.id} type="button"
                    className="w-full text-left px-3 py-2.5 hover:bg-subtle flex items-center justify-between gap-3 border-b border-line last:border-0"
                    onMouseDown={() => selectSku(s)}
                  >
                    <span>
                      <span className="text-[13px] font-medium">{s.exact_size}</span>
                      <span className="text-[12px] text-ink-3 ml-1.5">{s.brand_name} · {s.hier_l1}</span>
                    </span>
                    <span className={`text-[12px] num font-medium shrink-0 ${
                      s.stock_status === 'OUT_OF_STOCK' ? 'text-danger' :
                      s.stock_status === 'LOW_STOCK' ? 'text-warn' : 'text-ink-2'
                    }`}>
                      {fmtQty(s.current_stock, s.unit_code)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Selected product summary */}
          {sku && (
            <div className="bg-subtle rounded-lg px-3.5 py-2.5 text-[13px]">
              <div className="flex justify-between items-start">
                <div>
                  <p className="font-medium">{sku.exact_size}</p>
                  <p className="text-[11px] text-ink-3 mt-0.5">{sku.brand_name} · {sku.hier_l1} · {sku.sku_code}</p>
                </div>
                <span className={`num text-[12px] font-medium ${
                  sku.stock_status === 'OUT_OF_STOCK' ? 'text-danger' :
                  sku.stock_status === 'LOW_STOCK' ? 'text-warn' : 'text-ink-2'
                }`}>
                  {fmtQty(sku.current_stock, sku.unit_code)} in stock
                </span>
              </div>
            </div>
          )}

          {/* Quantity */}
          <div>
            <label className="label" htmlFor="d-qty">Quantity ({sku?.unit_code ?? 'units'}) <span className="text-danger">*</span></label>
            <input
              id="d-qty"
              className="field num text-[16px] h-11"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0"
              autoFocus={!!sku}
            />
            {sku && qty && amount > 0 && (
              <p className="text-[12px] text-ink-3 mt-1 num">
                After: <span className={projected < 0 ? 'text-danger' : 'font-medium'}>
                  {fmtQty(projected, sku.unit_code)}
                </span>
              </p>
            )}
            {action === 'outward' && sku && amount > sku.current_stock && (
              <p className="text-[12px] text-danger mt-1">Only {fmtQty(sku.current_stock, sku.unit_code)} available.</p>
            )}
          </div>

          {/* Reference */}
          <div>
            <label className="label" htmlFor="d-ref">
              Reference
              {lastRef && (
                <span className="ml-1.5 text-ink-3 font-normal">
                  · last used: <button type="button" className="text-brand hover:underline" onClick={() => setReference(lastRef)}>{lastRef}</button>
                </span>
              )}
            </label>
            <input
              id="d-ref" className="field" value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={action === 'inward' ? 'e.g. PO-1042' : 'e.g. SO-4108'}
            />
          </div>

          {/* Outward-only fields */}
          {action === 'outward' && (
            <>
              <div>
                <label className="label" htmlFor="d-inv">
                  Invoice No <span className="text-ink-3 font-normal">(optional)</span>
                  {lastInvoice && (
                    <span className="ml-1.5 text-ink-3 font-normal">
                      · last: <button type="button" className="text-brand hover:underline" onClick={() => setInvoiceNo(lastInvoice)}>{lastInvoice}</button>
                    </span>
                  )}
                </label>
                <input
                  id="d-inv" className="field" value={invoiceNo}
                  onChange={(e) => setInvoiceNo(e.target.value)}
                  placeholder="INV-001"
                />
              </div>

              <div>
                <label className="label" htmlFor="d-op">Last Operated By</label>
                <select id="d-op" className="field" value={operatedBy} onChange={(e) => setOperatedBy(e.target.value)}>
                  <option value="">— select team member —</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.full_name}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          {/* Notes */}
          <div>
            <label className="label" htmlFor="d-notes">Notes</label>
            <textarea
              id="d-notes" rows={2} className="field" value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional"
            />
          </div>

          {error && <p className="text-[12px] text-danger bg-danger-soft rounded-lg px-3 py-2">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-line bg-subtle rounded-b-xl">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || invalid}>
            {busy ? 'Saving…' : <><Check size={14} /> Confirm</>}
          </button>
        </div>
      </form>
    </div>
  );
}
