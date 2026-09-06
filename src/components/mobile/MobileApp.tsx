'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Mic, ArrowUpRight, ArrowDownLeft, Search, X, Monitor, Check, Boxes,
} from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtQty, fmtRelative, initials } from '@/lib/format';
import type { Movement, Session, Sku, TxnType } from '@/lib/types';
import VoiceEntry from '@/components/mobile/VoiceEntry';

/* =============================================================================
   Phone app
   -----------------------------------------------------------------------------
   One path in: type a few characters, tap the product, choose in or out, enter
   a quantity, add. The desktop's three-pane drill-down is deliberately absent —
   on a phone it turned into a column of nested lists that had to be scrolled to
   be understood.

   The entry panel is sized to fit one screen without scrolling, so the numbers
   that matter (stock now, the change, what is left) are all visible at the
   moment of deciding.
   ========================================================================== */

const QUICK = [5, 10, 20, 50, 100];

export default function MobileApp({ session }: { session: Session }) {
  const { skus, loading, search, applyStock, refresh } = useCatalog();

  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Sku | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [recent, setRecent] = useState<Movement[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const canWrite = session.permissions.includes('transactions.create');
  const results = useMemo(() => (query.trim() ? search(query, 30) : []), [query, search]);

  useEffect(() => { void loadRecent(); }, []);

  async function loadRecent() {
    const { data } = await supabaseBrowser()
      .from('v_movements')
      .select('id,txn_no,occurred_at,txn_type,quantity,unit_code,exact_size,brand_name,user_name,channel')
      .order('occurred_at', { ascending: false })
      .limit(6);
    setRecent((data ?? []) as unknown as Movement[]);
  }

  function afterCommit(message: string) {
    setPicked(null);
    setQuery('');
    setToast(message);
    setTimeout(() => setToast(null), 3200);
    void loadRecent();
  }

  return (
    <div className="min-h-screen bg-canvas flex flex-col">
      {/* ------------------------------------------------------------ top */}
      <header className="sticky top-0 z-30 bg-canvas/95 backdrop-blur-md border-b border-line">
        <div className="flex items-center gap-2.5 px-4 h-14">
          <span className="grid place-items-center h-8 w-8 rounded-lg bg-brand text-white shrink-0">
            <Boxes size={16} />
          </span>
          <p className="text-[15px] font-semibold truncate">Bhagyoday Belts</p>
          <Link href="/" className="btn btn-ghost h-9 w-9 p-0 ml-auto" aria-label="Desktop view">
            <Monitor size={17} />
          </Link>
          <span className="grid place-items-center h-8 w-8 rounded-lg bg-subtle text-[11px] font-semibold text-ink-2">
            {initials(session.user.full_name)}
          </span>
        </div>

        {/* Search sits directly under the title: it is the way in, not a feature. */}
        <div className="px-4 pb-3">
          <div className="relative">
            <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              className="field h-12 pl-11 pr-10 text-[16px] rounded-xl"
              placeholder="Type a size or brand…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            {query && (
              <button
                className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 p-1"
                onClick={() => setQuery('')}
                aria-label="Clear"
              >
                <X size={17} />
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 pb-6">
        {/* ------------------------------------------------- suggestions */}
        {query.trim() ? (
          <div className="card overflow-hidden fade-in mt-1">
            {loading && <p className="px-4 py-5 text-[14px] text-ink-3">Loading…</p>}

            {!loading && results.length === 0 && (
              <p className="px-4 py-6 text-[14px] text-ink-3 text-center">
                Nothing matches “{query}”.
              </p>
            )}

            <ul className="divide-y divide-line">
              {results.map((s) => (
                <li key={s.sku_code}>
                  <button
                    className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-subtle"
                    onClick={() => setPicked(s)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium truncate">{s.exact_size}</span>
                      <span className="block text-[13px] text-ink-3 truncate">{s.brand_name}</span>
                    </span>
                    {s.stock_status === 'OUT_OF_STOCK' && <span className="badge badge-danger">Out</span>}
                    {s.stock_status === 'LOW_STOCK' && <span className="badge badge-warn">Low</span>}
                    <span className="num text-[15px] font-semibold shrink-0">
                      {fmtQty(s.current_stock, s.unit_code)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="space-y-3 mt-1">
            <button
              className="w-full h-16 rounded-xl bg-brand text-white flex items-center justify-center gap-3 text-[16px] font-medium active:bg-brand-hover disabled:opacity-45"
              onClick={() => setVoiceOpen(true)}
              disabled={!canWrite}
            >
              <Mic size={20} /> Speak an entry
            </button>

            {!canWrite && (
              <p className="text-[13px] text-ink-3 text-center">
                Your account is read-only.
              </p>
            )}

            <div className="card overflow-hidden">
              <div className="card-head"><h2 className="card-title">Recent</h2></div>
              {recent.length === 0 ? (
                <p className="px-4 py-5 text-[13px] text-ink-3">Nothing yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {recent.map((m) => (
                    <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span className={`grid place-items-center h-7 w-7 rounded-lg shrink-0 ${
                        m.txn_type === 'INWARD' ? 'bg-ok-soft text-ok' : 'bg-brand-soft text-brand'
                      }`}>
                        {m.txn_type === 'INWARD' ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium truncate">{m.exact_size}</span>
                        <span className="block text-[11px] text-ink-3 truncate">
                          {m.user_name} · {fmtRelative(m.occurred_at)}
                        </span>
                      </span>
                      <span className="num text-[13px] font-medium">
                        {m.txn_type === 'OUTWARD' ? '−' : '+'}{fmtQty(Math.abs(m.quantity), m.unit_code)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-5 left-4 right-4 z-[70] bg-ink text-white rounded-xl px-4 py-3 text-[14px] flex items-center gap-2 slide-up">
          <Check size={17} className="shrink-0" /> {toast}
        </div>
      )}

      {picked && (
        <EntryPanel
          sku={picked}
          canWrite={canWrite}
          onClose={() => setPicked(null)}
          onSaved={(newStock, message) => { applyStock(picked.sku_code, newStock); afterCommit(message); }}
        />
      )}

      {voiceOpen && (
        <VoiceEntry
          onClose={() => setVoiceOpen(false)}
          onCommitted={() => { setVoiceOpen(false); void refresh(); void loadRecent(); }}
        />
      )}
    </div>
  );
}

/* ===========================================================================
   Entry panel — everything on one screen, no scrolling.
   =========================================================================== */

function EntryPanel({
  sku, canWrite, onClose, onSaved,
}: {
  sku: Sku;
  canWrite: boolean;
  onClose: () => void;
  onSaved: (newStock: number, message: string) => void;
}) {
  const [type, setType] = useState<TxnType | null>(null);
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = Number(qty) || 0;
  const after = type === 'OUTWARD' ? sku.current_stock - amount
    : type === 'INWARD' ? sku.current_stock + amount
    : null;

  const tooMuch = type === 'OUTWARD' && amount > sku.current_stock;
  const ready = canWrite && !!type && amount > 0 && !tooMuch;

  async function submit() {
    if (!ready || !type) return;
    setBusy(true);
    setError(null);

    const res = await fetch('/api/movements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sku_code: sku.sku_code,
        txn_type: type,
        quantity: amount,
        unit_code: sku.unit_code,
        channel: 'MOBILE_PWA',
      }),
    });

    const json = await res.json();
    setBusy(false);
    if (!res.ok) { setError(json.error ?? 'That did not go through.'); return; }

    const newStock = Number(json.movement.new_stock);
    onSaved(
      newStock,
      `${sku.exact_size} · ${type === 'OUTWARD' ? '−' : '+'}${fmtQty(amount, sku.unit_code)} · now ${fmtQty(newStock, sku.unit_code)}`,
    );
  }

  return (
    <div className="fixed inset-0 z-[75] bg-canvas flex flex-col">
      <div className="flex items-center gap-3 px-4 h-14 border-b border-line shrink-0">
        <button className="btn btn-ghost h-9 w-9 p-0" onClick={onClose} aria-label="Back">
          <X size={20} />
        </button>
        <p className="text-[16px] font-semibold">New entry</p>
      </div>

      <div className="flex-1 p-4 space-y-4 overflow-y-auto">
        {/* product */}
        <div>
          <p className="text-[22px] font-semibold leading-tight">{sku.exact_size}</p>
          <p className="text-[14px] text-ink-2 mt-0.5">{sku.brand_name}</p>
        </div>

        {/* direction — the first decision, so it comes first */}
        <div className="grid grid-cols-2 gap-3">
          <button
            className={`h-14 rounded-xl border text-[15px] font-medium flex items-center justify-center gap-2 transition-colors ${
              type === 'OUTWARD'
                ? 'bg-brand text-white border-brand'
                : 'bg-surface border-line-strong text-ink active:bg-subtle'
            }`}
            onClick={() => setType('OUTWARD')}
          >
            <ArrowUpRight size={19} /> Outward
          </button>
          <button
            className={`h-14 rounded-xl border text-[15px] font-medium flex items-center justify-center gap-2 transition-colors ${
              type === 'INWARD'
                ? 'bg-ok text-white border-ok'
                : 'bg-surface border-line-strong text-ink active:bg-subtle'
            }`}
            onClick={() => setType('INWARD')}
          >
            <ArrowDownLeft size={19} /> Inward
          </button>
        </div>

        {/* quantity */}
        <div>
          <label className="label" htmlFor="qty">
            How many? ({sku.unit_code === 'MTR' ? 'meters' : 'pieces'})
          </label>
          <input
            id="qty"
            className="field num h-14 text-[22px] font-semibold text-center"
            inputMode="decimal"
            placeholder="0"
            value={qty}
            onChange={(e) => setQty(e.target.value.replace(/[^0-9.]/g, ''))}
          />
          <div className="flex gap-2 mt-2">
            {QUICK.map((n) => (
              <button
                key={n}
                className="flex-1 h-9 rounded-lg border border-line text-[14px] num active:bg-subtle"
                onClick={() => setQty(String(n))}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        {/* the three numbers that matter, always visible */}
        <div className="card p-4 num text-[15px] space-y-2">
          <div className="flex justify-between text-ink-2">
            <span>In stock now</span>
            <span>{fmtQty(sku.current_stock, sku.unit_code)}</span>
          </div>
          <div className={`flex justify-between font-medium ${
            type === 'OUTWARD' ? 'text-brand' : type === 'INWARD' ? 'text-ok' : 'text-ink-3'
          }`}>
            <span>{type === 'OUTWARD' ? 'Going out' : type === 'INWARD' ? 'Coming in' : 'Change'}</span>
            <span>
              {type && amount > 0 ? `${type === 'OUTWARD' ? '−' : '+'}${fmtQty(amount, sku.unit_code)}` : '—'}
            </span>
          </div>
          <div className="flex justify-between text-[19px] font-semibold border-t border-line pt-2.5 mt-1">
            <span className="text-[15px] font-medium text-ink-2">Left after this</span>
            <span className={tooMuch ? 'text-danger' : ''}>
              {after !== null && amount > 0 ? fmtQty(after, sku.unit_code) : '—'}
            </span>
          </div>
        </div>

        {tooMuch && (
          <p className="text-[14px] text-danger bg-danger-soft rounded-lg px-4 py-2.5">
            Only {fmtQty(sku.current_stock, sku.unit_code)} in stock.
          </p>
        )}

        {!canWrite && (
          <p className="text-[14px] text-warn bg-warn-soft rounded-lg px-4 py-2.5">
            Your account is read-only.
          </p>
        )}

        {error && (
          <p className="text-[14px] text-danger bg-danger-soft rounded-lg px-4 py-2.5">{error}</p>
        )}
      </div>

      <div className="border-t border-line bg-surface p-4 shrink-0">
        <button
          className="btn btn-primary w-full text-[16px]"
          style={{ height: 52 }}
          disabled={!ready || busy}
          onClick={submit}
        >
          <Check size={20} /> {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
    </div>
  );
}
