'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Mic, ArrowUpRight, ArrowDownLeft, Search, X, Monitor, ChevronRight, Boxes,
} from 'lucide-react';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtQty, fmtRelative, initials } from '@/lib/format';
import type { Movement, Permission, Session, Sku } from '@/lib/types';
import MovementDialog from '@/components/inventory/MovementDialog';
import VoiceEntry from '@/components/mobile/VoiceEntry';

/**
 * Built for one thumb and a noisy warehouse: big targets, no nested navigation,
 * and the shortest possible path from "customer wants 40 m" to a committed
 * movement. The desktop hierarchy is deliberately absent here.
 */
export default function MobileApp({ session }: { session: Session }) {
  const { skus, loading, search, applyStock, refresh } = useCatalog();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Sku | null>(null);
  const [action, setAction] = useState<'inward' | 'outward' | null>(null);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [recent, setRecent] = useState<Movement[]>([]);
  const [today, setToday] = useState({ inward: 0, outward: 0 });

  const can = (p: Permission) => session.permissions.includes(p);
  const canWrite = can('transactions.create');

  const results = useMemo(() => (query.trim() ? search(query, 25) : []), [query, search]);

  useEffect(() => { void loadActivity(); }, []);

  async function loadActivity() {
    const db = supabaseBrowser();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [{ data: rows }, { count: inCount }, { count: outCount }] = await Promise.all([
      db.from('v_movements')
        .select('id,txn_no,occurred_at,txn_type,quantity,unit_code,exact_size,brand_name,user_name,channel')
        .order('occurred_at', { ascending: false })
        .limit(8),
      db.from('v_movements').select('id', { count: 'exact', head: true })
        .eq('txn_type', 'INWARD').gte('occurred_at', startOfDay.toISOString()),
      db.from('v_movements').select('id', { count: 'exact', head: true })
        .eq('txn_type', 'OUTWARD').gte('occurred_at', startOfDay.toISOString()),
    ]);

    setRecent((rows ?? []) as unknown as Movement[]);
    setToday({ inward: inCount ?? 0, outward: outCount ?? 0 });
  }

  function commit(newStock: number) {
    if (picked) {
      applyStock(picked.sku_code, newStock);
      setPicked({ ...picked, current_stock: newStock });
    }
    setAction(null);
    setPicked(null);
    setQuery('');
    void loadActivity();
  }

  return (
    <div className="min-h-screen pb-10 bg-canvas">
      {/* --------------------------------------------------------- top bar */}
      <header className="sticky top-0 z-30 bg-canvas/90 backdrop-blur-md border-b border-line">
        <div className="flex items-center gap-3 px-4 h-14">
          <span className="grid place-items-center h-8 w-8 rounded-lg bg-brand text-white shrink-0">
            <Boxes size={16} />
          </span>
          <div className="min-w-0 leading-tight">
            <p className="text-[14px] font-semibold truncate">Belt Stock</p>
            <p className="text-[11px] text-ink-3 truncate">{session.user.full_name}</p>
          </div>
          <Link href="/" className="btn btn-ghost h-8 w-8 p-0 ml-auto" aria-label="Desktop view">
            <Monitor size={16} />
          </Link>
          <span className="grid place-items-center h-8 w-8 rounded-lg bg-subtle text-[11px] font-semibold text-ink-2">
            {initials(session.user.full_name)}
          </span>
        </div>
      </header>

      <div className="px-4 pt-4 space-y-4">
        {/* ------------------------------------------------------- search */}
        <div className="relative">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            className="field h-12 pl-10 text-[15px] rounded-xl"
            placeholder="Search size, brand or SKU"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
          {query && (
            <button className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3" onClick={() => setQuery('')} aria-label="Clear">
              <X size={16} />
            </button>
          )}
        </div>

        {/* ------------------------------------------------ search results */}
        {query.trim() && (
          <div className="card overflow-hidden fade-in">
            {loading && <p className="px-4 py-5 text-[13px] text-ink-3">Loading catalogue…</p>}
            {!loading && results.length === 0 && (
              <p className="px-4 py-5 text-[13px] text-ink-3">Nothing matches “{query}”.</p>
            )}
            <ul className="divide-y divide-line max-h-[52vh] overflow-y-auto">
              {results.map((s) => (
                <li key={s.sku_code}>
                  <button
                    className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-subtle"
                    onClick={() => { setPicked(s); setQuery(''); }}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-medium truncate">{s.exact_size}</span>
                      <span className="block text-[12px] text-ink-3 truncate">
                        {s.brand_name} · {s.family_code}
                      </span>
                    </span>
                    {s.stock_status === 'OUT_OF_STOCK' && <span className="badge badge-danger">Out</span>}
                    {s.stock_status === 'LOW_STOCK' && <span className="badge badge-warn">Low</span>}
                    <span className="num text-[14px] font-semibold shrink-0">
                      {fmtQty(s.current_stock, s.unit_code)}
                    </span>
                    <ChevronRight size={15} className="text-ink-3 shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ------------------------------------------------- quick actions */}
        {!query.trim() && (
          <>
            <button
              className="w-full h-16 rounded-xl bg-brand text-white flex items-center justify-center gap-3 text-[16px] font-medium active:bg-brand-hover disabled:opacity-45"
              onClick={() => setVoiceOpen(true)}
              disabled={!canWrite}
            >
              <Mic size={20} /> Speak a transaction
            </button>

            <div className="grid grid-cols-2 gap-3">
              <button
                className="h-14 rounded-xl bg-surface border border-line flex items-center justify-center gap-2 text-[14px] font-medium active:bg-subtle disabled:opacity-45"
                onClick={() => { setAction('outward'); setPicked(null); }}
                disabled={!canWrite}
              >
                <ArrowUpRight size={17} className="text-brand" /> Outward
              </button>
              <button
                className="h-14 rounded-xl bg-surface border border-line flex items-center justify-center gap-2 text-[14px] font-medium active:bg-subtle disabled:opacity-45"
                onClick={() => { setAction('inward'); setPicked(null); }}
                disabled={!canWrite}
              >
                <ArrowDownLeft size={17} className="text-ok" /> Inward
              </button>
            </div>

            {!canWrite && (
              <p className="text-[12px] text-ink-3 text-center">
                Your role is read-only. Ask an admin for operator access.
              </p>
            )}

            {/* --------------------------------------------- today's tally */}
            <div className="card p-4">
              <p className="eyebrow mb-3">Today</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="num text-[22px] font-semibold leading-none">{today.outward}</p>
                  <p className="text-[11px] text-ink-3 mt-1">Outward</p>
                </div>
                <div>
                  <p className="num text-[22px] font-semibold leading-none">{today.inward}</p>
                  <p className="text-[11px] text-ink-3 mt-1">Inward</p>
                </div>
                <div>
                  <p className="num text-[22px] font-semibold leading-none">{skus.length}</p>
                  <p className="text-[11px] text-ink-3 mt-1">SKUs</p>
                </div>
              </div>
            </div>

            {/* ------------------------------------------------- recent */}
            <div className="card overflow-hidden">
              <div className="card-head"><h2 className="card-title">Recent</h2></div>
              {recent.length === 0 ? (
                <p className="px-4 py-5 text-[13px] text-ink-3">Nothing recorded yet.</p>
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
          </>
        )}
      </div>

      {/* ---------------------------------------------- picked SKU sheet */}
      {picked && !action && (
        <div className="fixed inset-0 z-[60] flex items-end bg-ink/30" onClick={() => setPicked(null)}>
          <div className="w-full bg-surface rounded-t-2xl p-5 slide-up" onClick={(e) => e.stopPropagation()}>
            <p className="text-[17px] font-semibold">{picked.exact_size}</p>
            <p className="text-[13px] text-ink-3">{picked.brand_name} · {picked.family_name}</p>

            <div className="flex items-end justify-between mt-4 pb-4 border-b border-line">
              <div>
                <p className="eyebrow">In stock</p>
                <p className="num text-[32px] font-semibold leading-none mt-1">
                  {fmtQty(picked.current_stock, picked.unit_code)}
                </p>
              </div>
              {picked.stock_status === 'OUT_OF_STOCK' && <span className="badge badge-danger mb-1">Out</span>}
              {picked.stock_status === 'LOW_STOCK' && <span className="badge badge-warn mb-1">Low</span>}
            </div>

            <div className="grid grid-cols-2 gap-3 mt-4">
              <button className="btn btn-secondary btn-lg" disabled={!canWrite} onClick={() => setAction('inward')}>
                <ArrowDownLeft size={16} /> Inward
              </button>
              <button className="btn btn-primary btn-lg" disabled={!canWrite} onClick={() => setAction('outward')}>
                <ArrowUpRight size={16} /> Outward
              </button>
            </div>

            <button className="btn btn-ghost w-full mt-2" onClick={() => setPicked(null)}>Close</button>
          </div>
        </div>
      )}

      {/* pick a product first if the worker tapped a direction from the home screen */}
      {action && !picked && (
        <div className="fixed inset-0 z-[60] bg-canvas flex flex-col">
          <div className="flex items-center gap-3 px-4 h-14 border-b border-line">
            <button className="btn btn-ghost h-8 w-8 p-0" onClick={() => setAction(null)} aria-label="Back">
              <X size={17} />
            </button>
            <p className="text-[15px] font-semibold">
              {action === 'inward' ? 'Inward' : 'Outward'} — pick a product
            </p>
          </div>
          <div className="p-4">
            <div className="relative">
              <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <input
                className="field h-12 pl-10 text-[15px] rounded-xl"
                placeholder="Search size or brand"
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <ul className="flex-1 overflow-y-auto divide-y divide-line">
            {results.map((s) => (
              <li key={s.sku_code}>
                <button className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-subtle"
                  onClick={() => { setPicked(s); setQuery(''); }}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium truncate">{s.exact_size}</span>
                    <span className="block text-[12px] text-ink-3 truncate">{s.brand_name}</span>
                  </span>
                  <span className="num text-[14px] font-semibold">{fmtQty(s.current_stock, s.unit_code)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {action && picked && (
        <MovementDialog
          sku={picked}
          action={action}
          channel="MOBILE_PWA"
          onClose={() => setAction(null)}
          onDone={commit}
        />
      )}

      {voiceOpen && (
        <VoiceEntry
          onClose={() => setVoiceOpen(false)}
          onCommitted={() => { setVoiceOpen(false); void refresh(); void loadActivity(); }}
        />
      )}
    </div>
  );
}
