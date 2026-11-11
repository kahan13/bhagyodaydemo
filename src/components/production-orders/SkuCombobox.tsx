'use client';

import { useState, useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';
import type { ProductType } from '@/lib/types';
import { useListNav } from '@/lib/useListNav';
import { makeMatcher, hasQuery } from '@/lib/search';
import { isLotType } from '@/lib/lotUnit';
import { loadSkus, peekSkus, type SkuWithAtp, type SkuPick } from './skuCache';

const CATEGORY_PILLS: [ProductType, string][] = [
  ['TIMING_BELT', 'Timing Belt'], ['V_BELT', 'V-Belt'], ['CONVEYOR_BELT', 'Conveyor'], ['POLY_V_BELT', 'Poly V Belt'],
  ['OPEN_ROLL', 'Open Roll / Rubber'],
];

/** The category last picked on any order line — the next new line starts there. */
let lastCategory: ProductType = 'TIMING_BELT';

export default function SkuCombobox({
  onlyCategory,
  hideSearch = false,
  onCategory,
  value,
  onChange,
  cacheVersion,
  placeholder = 'Search size, brand or code (h100 = h-100)',
  lead,
  headerRight,
}: {
  /** show this one category only (no pills) */
  onlyCategory?: ProductType;
  /** hide the search box (the caller shows something else for this category first) */
  hideSearch?: boolean;
  /** told which category pill is active (also at start and when a product is picked) */
  onCategory?: (c: ProductType) => void;
  value: SkuPick;
  onChange: (val: SkuPick) => void;
  cacheVersion: number;
  placeholder?: string;
  /** shown before the category pills (the line number) */
  lead?: React.ReactNode;
  /** shown at the far right of the pill row (remove button) */
  headerRight?: React.ReactNode;
}) {
  const [skus, setSkus] = useState<SkuWithAtp[]>(peekSkus() ?? []);
  const [loadingSkus, setLoadingSkus] = useState(!peekSkus());
  const [open, setOpen] = useState(false);
  // Which kind of belt is being searched. A new line starts on whatever was used last,
  // so ten V-belt lines in a row don't need ten clicks.
  const [category, setCategory] = useState<ProductType>(onlyCategory ?? value.sku?.product_type ?? lastCategory);
  useEffect(() => { onCategory?.(category); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [category]);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoadingSkus(true);
    loadSkus().then((s) => { setSkus(s); setLoadingSkus(false); });
  }, [cacheVersion]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current && !inputRef.current.contains(e.target as Node)
      ) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Only the chosen category is searched, so "A-38" can never turn up a conveyor or a timing belt.
  const inCategory = skus.filter((s) => s.product_type === category);
  const match = makeMatcher(value.query);
  const found = !hasQuery(value.query)
    ? inCategory
    : inCategory.filter((s) => match([s.sku_code, s.display_name, s.exact_size, s.brand_name, s.search_text]));
  // Nothing to give (no free rolls / none on the shelf): struck out and kept at the end of the list.
  const noStock = (s: SkuWithAtp) =>
    isLotType(s.product_type)
      ? (s.lot_groups ?? []).reduce((a, g) => a + g.total_qty, 0) <= 0
      : s.atp_stock <= 0;
  const options = [...found.filter((s) => !noStock(s)), ...found.filter(noStock)].slice(0, 40);

  function selectOption(sku: SkuWithAtp) {
    onChange({ sku, query: sku.display_name });
    setOpen(false);
  }

  const nav = useListNav({
    count: options.length,
    open: open && options.length > 0,
    setOpen,
    onPick: (i) => { const o = options[i]; if (o) selectOption(o); },
  });

  function pickCategory(next: ProductType) {
    if (next === category) return;
    setCategory(next);
    if (!onlyCategory) lastCategory = next;
    // the chosen product belongs to the old category, so start the line afresh
    onChange({ sku: null, query: '' });
    inputRef.current?.focus();
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        {lead}
        {!onlyCategory && <div className="flex gap-1 flex-wrap" role="group" aria-label="Product category">
          {CATEGORY_PILLS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              onClick={() => pickCategory(t)}
              aria-pressed={category === t}
              className={`px-2.5 py-0.5 rounded-full text-[13px] font-medium border transition-colors ${
                category === t ? 'bg-brand text-white border-brand' : 'bg-surface border-line text-ink-2 hover:border-brand hover:text-brand'
              }`}
            >{label}</button>
          ))}
        </div>}
        {headerRight && <div className="ml-auto">{headerRight}</div>}
      </div>

      {!hideSearch && <div className="relative">
        <div className="relative flex items-center">
          <Search size={13} className="absolute left-2.5 text-ink-3 pointer-events-none" />
          <input
            ref={inputRef}
            className="field pl-7 pr-7"
            placeholder={loadingSkus ? 'Loading SKUs…' : placeholder}
            value={value.query}
            onChange={(e) => { onChange({ sku: null, query: e.target.value }); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={nav.onKeyDown}
            role="combobox"
            aria-expanded={open}
            autoComplete="off"
          />
          {value.query && (
            <button
              className="absolute right-2 text-ink-3 hover:text-ink"
              onClick={() => { onChange({ sku: null, query: '' }); inputRef.current?.focus(); setOpen(true); }}
              tabIndex={-1}
              type="button"
              aria-label="Clear"
            >
              <X size={13} />
            </button>
          )}
        </div>

        {/* one plain list: just the SKU name — what is in stock is shown once a SKU is picked */}
        {open && options.length > 0 && (
          <div
            ref={(el) => { (dropdownRef as React.MutableRefObject<HTMLDivElement | null>).current = el; (nav.listRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }}
            className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-line bg-surface shadow-lg max-h-72 overflow-y-auto"
          >
            {options.map((sku, idx) => (
              <button
                key={sku.id}
                data-nav-idx={idx}
                tabIndex={-1}
                onMouseEnter={() => nav.setCursor(idx)}
                className={`w-full text-left px-3 py-2 text-[15px] font-medium truncate transition-colors ${
                  idx === nav.cursor ? 'bg-brand-soft' : 'hover:bg-subtle'
                } ${noStock(sku) ? 'line-through text-ink-3' : ''}`}
                onClick={() => selectOption(sku)}
                title={noStock(sku) ? 'Out of stock' : undefined}
                type="button"
              >
                <span className={`font-mono ${noStock(sku) ? '' : 'text-brand'}`}>{sku.sku_code}</span>{' – '}{sku.display_name}
              </button>
            ))}
          </div>
        )}

        {open && !loadingSkus && options.length === 0 && value.query.length > 0 && (
          <div
            ref={dropdownRef}
            className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-line bg-surface shadow-lg px-3 py-4 text-center text-[14px] text-ink-3"
          >
            No SKUs match &quot;{value.query}&quot;
          </div>
        )}
      </div>}
    </div>
  );
}
