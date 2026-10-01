'use client';

/**
 * ProductionOrderItemForm
 * ─────────────────────────────────────────────────────────────────────────────
 * One item row inside the Production Order create / edit dialog.
 * Embeds LotAllocationPicker once a SKU + qty are chosen.
 *
 * Usage:
 *   <ProductionOrderItemForm
 *     item={item}
 *     onChange={setItem}
 *     onRemove={handleRemove}
 *     readOnly={order.status !== 'DRAFT'}
 *   />
 */

import { useState } from 'react';
import { Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { fmtQty } from '@/lib/format';
import LotAllocationPicker, { type LotAllocation } from './LotAllocationPicker';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OrderItemDraft {
  _key:        string;        // local react key (uuid before save, db id after)
  sku_id:      string;
  sku_code:    string;
  sku_label:   string;        // display: exact_size · brand
  unit_code:   string;
  roll_length_mm: number | null;
  quantity:    number;
  notes:       string;
  allocations: LotAllocation[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ProductionOrderItemForm({
  item,
  onChange,
  onRemove,
  readOnly = false,
}: {
  item:       OrderItemDraft;
  onChange:   (next: OrderItemDraft) => void;
  onRemove:   () => void;
  readOnly?:  boolean;
}) {
  const { skus } = useCatalog();
  const [showLots, setShowLots] = useState(true);
  const [skuSearch, setSkuSearch] = useState('');

  // SKU dropdown options (open-ended timing belts only — they have roll_length_mm)
  const options = skus.filter((s) =>
    s.product_type === 'TIMING_BELT' &&
    (s.belt_form === 'OPEN_ENDED' || (s as any).roll_length_mm) &&
    (skuSearch === '' || (
      s.sku_code.toLowerCase().includes(skuSearch.toLowerCase()) ||
      s.exact_size.toLowerCase().includes(skuSearch.toLowerCase()) ||
      s.brand_name.toLowerCase().includes(skuSearch.toLowerCase())
    )),
  );

  const set = (patch: Partial<OrderItemDraft>) => onChange({ ...item, ...patch });

  const handleSkuChange = (skuId: string) => {
    const sku = skus.find((s) => s.id === skuId);
    if (!sku) return;
    set({
      sku_id:        sku.id,
      sku_code:      sku.sku_code,
      sku_label:     `${sku.exact_size} · ${sku.brand_name}`,
      unit_code:     sku.unit_code,
      roll_length_mm: (sku as any).roll_length_mm ?? null,
      allocations:   [],   // reset allocations when SKU changes
    });
  };

  const totalAllocated  = item.allocations.reduce((s, a) => s + a.allocated_qty, 0);
  const allocationValid = item.quantity > 0 && totalAllocated === item.quantity;
  const allocationShort = item.quantity > 0 && totalAllocated < item.quantity;

  return (
    <div className="rounded-xl border border-line bg-surface p-4 space-y-3">

      {/* Row 1: SKU picker + qty + remove */}
      <div className="flex items-start gap-2">

        {/* SKU selector */}
        <div className="flex-1 min-w-0">
          <label className="label">SKU</label>
          {readOnly ? (
            <p className="text-[13px] font-medium">{item.sku_label || '—'}</p>
          ) : (
            <select
              className="input w-full text-[13px]"
              value={item.sku_id}
              onChange={(e) => handleSkuChange(e.target.value)}
              required
            >
              <option value="">Select a SKU…</option>
              {options.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.exact_size} · {s.brand_name} · {s.sku_code}
                  {(s as any).roll_length_mm ? ` (${(s as any).roll_length_mm}mm/roll)` : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Qty */}
        <div className="w-36 shrink-0">
          <label className="label">Required qty</label>
          {readOnly ? (
            <p className="text-[13px] num font-semibold">{fmtQty(item.quantity, item.unit_code)}</p>
          ) : (
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                className="input w-full text-[13px] num"
                placeholder="mm"
                value={item.quantity || ''}
                onChange={(e) => set({ quantity: Number(e.target.value), allocations: [] })}
              />
              <span className="text-[12px] text-ink-3 shrink-0">{item.unit_code || 'mm'}</span>
            </div>
          )}
          {item.roll_length_mm && item.quantity > 0 && (
            <p className="text-[11px] text-ink-3 mt-0.5 num">
              ≈ {(item.quantity / item.roll_length_mm).toFixed(2)} rolls
            </p>
          )}
        </div>

        {/* Remove */}
        {!readOnly && (
          <button
            type="button"
            onClick={onRemove}
            className="mt-5 text-ink-3 hover:text-red-500 transition-colors p-1.5 rounded"
            title="Remove item"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* Notes */}
      {!readOnly && (
        <div>
          <label className="label">Notes (optional)</label>
          <input
            type="text"
            className="input w-full text-[13px]"
            placeholder="e.g. cut to 380mm before fitting"
            value={item.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </div>
      )}
      {readOnly && item.notes && (
        <p className="text-[12px] text-ink-2 italic">{item.notes}</p>
      )}

      {/* Lot allocation section — only if SKU + qty chosen */}
      {item.sku_id && item.quantity > 0 && (
        <div className="border-t border-line pt-3">
          <button
            type="button"
            className="flex items-center gap-1.5 text-[12px] text-ink-2 hover:text-ink w-full mb-2"
            onClick={() => setShowLots((v) => !v)}
          >
            {showLots ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            <span className="font-medium">Lot allocation</span>
            {/* summary badge */}
            {allocationValid && (
              <span className="ml-auto text-[11px] text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5">
                ✓ {fmtQty(totalAllocated, item.unit_code)} allocated
              </span>
            )}
            {allocationShort && (
              <span className="ml-auto text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                {fmtQty(totalAllocated, item.unit_code)} / {fmtQty(item.quantity, item.unit_code)}
              </span>
            )}
            {!item.allocations.length && (
              <span className="ml-auto text-[11px] text-ink-3">not yet allocated</span>
            )}
          </button>

          {showLots && (
            <LotAllocationPicker
              skuId={item.sku_id}
              unitCode={item.unit_code}
              required={item.quantity}
              value={item.allocations}
              onChange={(allocs) => set({ allocations: allocs })}
              readOnly={readOnly}
            />
          )}
        </div>
      )}
    </div>
  );
}
