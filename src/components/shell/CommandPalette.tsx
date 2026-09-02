'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search, CornerDownLeft } from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { fmtQty } from '@/lib/format';

/**
 * Cmd+K search. Runs against the in-memory catalogue, so results appear as
 * fast as the user types with no network involved.
 */
export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { search, loading } = useCatalog();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = query.trim() ? search(query, 8) : [];

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => { setCursor(0); }, [query]);

  if (!open) return null;

  function go(skuCode: string) {
    onClose();
    router.push(`/inventory?sku=${encodeURIComponent(skuCode)}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') return onClose();
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    if (e.key === 'Enter' && results[cursor]) { e.preventDefault(); go(results[cursor].sku_code); }
  }

  return (
    <div className="fixed inset-0 z-[60] bg-ink/25 backdrop-blur-[2px] flex items-start justify-center pt-[12vh] px-4" onClick={onClose}>
      <div
        className="w-full max-w-[560px] card shadow-lg overflow-hidden slide-up"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className="flex items-center gap-2.5 px-4 h-12 border-b border-line">
          <Search size={16} className="text-ink-3 shrink-0" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent outline-none text-[14px] placeholder:text-ink-3"
            placeholder="Search size, brand or SKU…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="text-[10px] px-1.5 py-0.5 rounded border border-line bg-subtle text-ink-3">esc</kbd>
        </div>

        <div className="max-h-[340px] scroll">
          {loading && <p className="px-4 py-6 text-[13px] text-ink-3">Loading catalogue…</p>}

          {!loading && !query.trim() && (
            <p className="px-4 py-6 text-[13px] text-ink-3">
              Type a size like <span className="text-ink">1200</span>, a brand like{' '}
              <span className="text-ink">optibelt</span>, or both.
            </p>
          )}

          {!loading && query.trim() && results.length === 0 && (
            <p className="px-4 py-6 text-[13px] text-ink-3">Nothing matches “{query}”.</p>
          )}

          {results.map((sku, i) => (
            <button
              key={sku.sku_code}
              onMouseEnter={() => setCursor(i)}
              onClick={() => go(sku.sku_code)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                i === cursor ? 'bg-brand-soft' : 'hover:bg-subtle'
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium truncate">{sku.exact_size}</span>
                <span className="block text-[11px] text-ink-3 truncate">
                  {sku.brand_name} · {sku.family_code}
                </span>
              </span>

              {sku.stock_status === 'OUT_OF_STOCK' && <span className="badge badge-danger">Out</span>}
              {sku.stock_status === 'LOW_STOCK' && <span className="badge badge-warn">Low</span>}

              <span className="num text-[13px] font-medium shrink-0">
                {fmtQty(sku.current_stock, sku.unit_code)}
              </span>

              {i === cursor && <CornerDownLeft size={13} className="text-brand shrink-0" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
