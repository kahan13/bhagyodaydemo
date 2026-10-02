'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Trash2, Loader2, X, Search, AlertTriangle } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { useCatalog } from '@/components/catalog/CatalogProvider';
import { useListNav } from '@/lib/useListNav';

interface Preview {
  skus: number; skus_with_stock: number; lots: number; movements: number;
  purchase_orders: number; production_orders: number; activity_entries: number; imports: number;
}

/**
 * Super-Admin tools to empty the app before handing it over.
 * SKUs are never deleted. Every action needs a typed confirmation and shows counts first.
 */
export default function ClearDataPanel() {
  const { allSkus, refresh } = useCatalog();
  const [pv, setPv] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<'orders' | 'stock' | null>(null);

  const [confirmOrders, setConfirmOrders] = useState('');
  const [confirmStock, setConfirmStock] = useState('');
  const [scope, setScope] = useState<'all' | 'some'>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabaseBrowser().rpc('admin_clear_preview');
    if (error) { setErr(error.message); return; }
    setPv(data as Preview);
  }, []);
  useEffect(() => { load(); }, [load]);

  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return allSkus
      .filter((s) => !picked.includes(s.id) &&
        (s.exact_size.toLowerCase().includes(t) || s.brand_name.toLowerCase().includes(t) || s.sku_code.toLowerCase().includes(t)))
      .slice(0, 8);
  }, [allSkus, q, picked]);

  const nav = useListNav({
    count: hits.length,
    open: open && hits.length > 0,
    setOpen,
    onPick: (i) => { if (hits[i]) { setPicked((p) => [...p, hits[i].id]); setQ(''); } },
  });

  async function run(kind: 'orders' | 'stock') {
    setBusy(kind); setErr(null); setMsg(null);
    const db = supabaseBrowser();
    const { data, error } = kind === 'orders'
      ? await db.rpc('admin_clear_orders_and_transactions')
      : await db.rpc('admin_zero_stock', { p_sku_ids: scope === 'all' ? null : picked });
    setBusy(null);
    if (error) { setErr(error.message); return; }
    setMsg(kind === 'orders'
      ? 'Orders, transactions and logs cleared. Current stock was kept as opening stock.'
      : `Stock zeroed for ${(data as { skus_zeroed: number }).skus_zeroed} SKUs.`);
    setConfirmOrders(''); setConfirmStock(''); setPicked([]);
    await Promise.all([load(), refresh()]);
  }

  const okOrders = confirmOrders.trim().toUpperCase() === 'CLEAR ORDERS';
  const okStock = confirmStock.trim().toUpperCase() === 'ZERO STOCK' && (scope === 'all' || picked.length > 0);

  const Row = ({ label, value }: { label: string; value?: number }) => (
    <li className="flex justify-between text-[12px]"><span className="text-ink-3">{label}</span>
      <span className="num font-medium">{value ?? '…'}</span></li>
  );

  return (
    <section className="card p-5 lg:col-span-2 border-danger/40">
      <div className="flex items-center gap-2">
        <AlertTriangle size={16} className="text-danger" />
        <h2 className="card-title">Clear data</h2>
        <span className="badge badge-danger">Super Admin · cannot be undone</span>
      </div>
      <p className="text-[13px] text-ink-2 mt-2 leading-relaxed">
        Use before handing the app to a client. Products (SKUs) are never deleted. Download a backup first.
      </p>

      {err && <p className="text-[12px] text-danger bg-danger-soft rounded-lg px-3 py-2 mt-3">{err}</p>}
      {msg && <p className="text-[12px] text-ok bg-ok-soft rounded-lg px-3 py-2 mt-3">{msg}</p>}

      <div className="grid gap-4 lg:grid-cols-2 mt-4">
        {/* orders & transactions */}
        <div className="rounded-lg border border-line p-4 space-y-3">
          <h3 className="text-[13px] font-semibold">1 · Clear orders &amp; transactions</h3>
          <p className="text-[12px] text-ink-3 leading-relaxed">
            Deletes every purchase order, production order, transaction, import record and activity log.
            Keeps SKUs, current stock and roll lots — today&apos;s stock becomes the opening stock.
          </p>
          <ul className="space-y-1 bg-subtle rounded-lg p-3">
            <Row label="Purchase orders" value={pv?.purchase_orders} />
            <Row label="Production orders" value={pv?.production_orders} />
            <Row label="Transactions" value={pv?.movements} />
            <Row label="Activity entries" value={pv?.activity_entries} />
          </ul>
          <input
            className="field" placeholder="Type CLEAR ORDERS to confirm"
            value={confirmOrders} onChange={(e) => setConfirmOrders(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && okOrders && !busy) run('orders'); }}
          />
          <button className="btn btn-primary" disabled={!okOrders || !!busy} onClick={() => run('orders')}>
            {busy === 'orders' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Clear orders &amp; transactions
          </button>
        </div>

        {/* zero stock */}
        <div className="rounded-lg border border-line p-4 space-y-3">
          <h3 className="text-[13px] font-semibold">2 · Zero inventory quantities</h3>
          <p className="text-[12px] text-ink-3 leading-relaxed">
            Sets stock to 0 for the chosen SKUs, removes their roll lots and their transaction history.
            The SKUs stay.
          </p>
          <div className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
            {([['all', `All SKUs (${pv?.skus ?? '…'})`], ['some', 'Choose SKUs']] as const).map(([v, label]) => (
              <button key={v} type="button" onClick={() => setScope(v)}
                className={`px-3 py-1 rounded-md text-[12px] font-medium ${scope === v ? 'bg-surface shadow-sm text-ink' : 'text-ink-3'}`}>{label}</button>
            ))}
          </div>

          {scope === 'some' && (
            <div className="space-y-2">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
                <input
                  className="field pl-8 text-[13px]" placeholder="Search size, brand or SKU, then ↓ and Enter"
                  value={q} autoComplete="off" role="combobox" aria-expanded={open}
                  onChange={(e) => { setQ(e.target.value); setOpen(true); }}
                  onFocus={() => setOpen(true)}
                  onKeyDown={nav.onKeyDown}
                />
                {open && hits.length > 0 && (
                  <div ref={nav.listRef} className="absolute z-20 mt-1 w-full bg-surface border border-line rounded-lg shadow-lg max-h-56 overflow-y-auto">
                    {hits.map((s, idx) => (
                      <button key={s.id} type="button" tabIndex={-1} data-nav-idx={idx}
                        onMouseEnter={() => nav.setCursor(idx)}
                        onMouseDown={(e) => { e.preventDefault(); setPicked((p) => [...p, s.id]); setQ(''); }}
                        className={`w-full text-left px-3 py-2 text-[13px] border-b border-line last:border-0 ${idx === nav.cursor ? 'bg-brand-soft' : 'hover:bg-subtle'}`}>
                        <span className="font-medium">{s.exact_size}</span>
                        <span className="text-ink-3 ml-1.5 text-[11px]">{s.brand_name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {picked.map((id) => {
                  const s = allSkus.find((x) => x.id === id);
                  return (
                    <span key={id} className="inline-flex items-center gap-1 text-[11px] bg-subtle border border-line rounded-full pl-2 pr-1 py-0.5">
                      {s?.exact_size ?? id}
                      <button type="button" aria-label="Remove" onClick={() => setPicked((p) => p.filter((x) => x !== id))}><X size={11} /></button>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          <ul className="space-y-1 bg-subtle rounded-lg p-3">
            <Row label="SKUs with stock" value={pv?.skus_with_stock} />
            <Row label="Roll lots" value={pv?.lots} />
          </ul>
          <input
            className="field" placeholder="Type ZERO STOCK to confirm"
            value={confirmStock} onChange={(e) => setConfirmStock(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && okStock && !busy) run('stock'); }}
          />
          <button className="btn btn-primary" disabled={!okStock || !!busy} onClick={() => run('stock')}>
            {busy === 'stock' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Zero {scope === 'all' ? 'all' : picked.length} SKU{scope === 'all' || picked.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </section>
  );
}
