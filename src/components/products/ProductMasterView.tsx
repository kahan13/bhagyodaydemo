'use client';

import { useEffect, useState, useMemo } from 'react';
import { Search, Plus, Pencil, ToggleLeft, ToggleRight, X } from 'lucide-react';
import type { Permission, ProductType } from '@/lib/types';

interface Product {
  id: string; sku_code: string; product_type: ProductType;
  display_name: string; exact_size: string;
  hier_l1: string; hier_l2: string; hier_l3: string;
  brand_code: string; brand_name: string;
  family_code: string; family_name: string;
  unit_code: string; opening_stock: number; current_stock: number;
  min_stock_level: number; supplier_moq: number; reorder_quantity: number;
  rack_location: string | null; is_active: boolean; stock_status: string;
  belt_form?: string; pitch_mm?: number; pitch_length_mm?: number;
  width_mm?: number; teeth?: number; standard?: string;
  construction?: string; nominal_length?: number; length_designation?: string;
}

interface Brand { id: string; code: string; name: string; has_timing_belts: boolean; has_v_belts: boolean; }
interface Family { id: string; code: string; name: string; product_type: string; }

const EMPTY: Partial<Product> = { product_type: 'TIMING_BELT', is_active: true, unit_code: 'PCS' };

export default function ProductMasterView({
  permissions, brands, families,
}: {
  permissions: Permission[];
  brands: Brand[];
  families: Family[];
}) {
  const can = (p: Permission) => permissions.includes(p);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<ProductType | 'ALL'>('ALL');
  const [showInactive, setShowInactive] = useState(false);
  const [dialog, setDialog] = useState<'add' | 'edit' | null>(null);
  const [form, setForm] = useState<Partial<Product>>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    setLoading(true);
    const r = await fetch('/api/products');
    if (r.ok) setProducts(await r.json());
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (!showInactive && !p.is_active) return false;
      if (typeFilter !== 'ALL' && p.product_type !== typeFilter) return false;
      if (!q) return true;
      return (
        p.sku_code.toLowerCase().includes(q) ||
        p.exact_size.toLowerCase().includes(q) ||
        p.brand_name.toLowerCase().includes(q) ||
        p.hier_l1.toLowerCase().includes(q)
      );
    });
  }, [products, query, typeFilter, showInactive]);

  const timingFamilies = families.filter((f) => f.product_type === 'TIMING_BELT');
  const vbeltFamilies = families.filter((f) => f.product_type === 'V_BELT');
  const activeFamilies = form.product_type === 'TIMING_BELT' ? timingFamilies : vbeltFamilies;
  const activeBrands = brands.filter((b) =>
    form.product_type === 'TIMING_BELT' ? b.has_timing_belts : b.has_v_belts
  );

  const set = (k: keyof Product, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const openAdd = () => { setForm(EMPTY); setErr(''); setDialog('add'); };
  const openEdit = (p: Product) => { setForm({ ...p }); setErr(''); setDialog('edit'); };
  const close = () => { setDialog(null); setErr(''); };

  const save = async () => {
    if (!form.sku_code?.trim()) { setErr('SKU code is required.'); return; }
    if (!form.exact_size?.trim()) { setErr('Size is required.'); return; }
    if (!form.brand_code?.trim()) { setErr('Brand is required.'); return; }
    if (!form.family_code?.trim()) { setErr('Profile / Family is required.'); return; }
    setSaving(true); setErr('');
    const method = dialog === 'add' ? 'POST' : 'PATCH';
    const body = { ...form,
      brand_name: brands.find((b) => b.code === form.brand_code)?.name ?? form.brand_code,
      family_name: families.find((f) => f.code === form.family_code)?.name ?? form.family_code,
    };
    const r = await fetch('/api/products', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    setSaving(false);
    if (!r.ok) { setErr(j.error ?? 'Save failed'); return; }
    close(); load();
  };

  const toggleActive = async (p: Product) => {
    const method = p.is_active ? 'DELETE' : 'PATCH';
    await fetch('/api/products', {
      method, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, is_active: !p.is_active }),
    });
    load();
  };

  const counts = {
    ALL: products.filter((p) => showInactive || p.is_active).length,
    TIMING_BELT: products.filter((p) => (showInactive || p.is_active) && p.product_type === 'TIMING_BELT').length,
    V_BELT: products.filter((p) => (showInactive || p.is_active) && p.product_type === 'V_BELT').length,
  };

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      {/* Header */}
      <div className="px-4 lg:px-6 py-3.5 border-b border-line bg-surface flex flex-wrap items-center gap-3">
        <h1 className="text-[17px] font-semibold">Product Master</h1>
        <div className="relative ml-2">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search size, brand or SKU…"
            className="input pl-8 w-56 text-[13px]" />
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-2 cursor-pointer ml-1">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="rounded" />
          Show inactive
        </label>
        {can('products.create') && (
          <button onClick={openAdd} className="btn btn-primary ml-auto flex items-center gap-1.5 text-[13px]">
            <Plus size={14} /> Add Product
          </button>
        )}
      </div>

      {/* Type tabs */}
      <div className="px-4 lg:px-6 border-b border-line flex gap-4 bg-surface">
        {(['ALL', 'TIMING_BELT', 'V_BELT'] as const).map((t) => (
          <button key={t} onClick={() => setTypeFilter(t)}
            className={`py-2.5 text-[13px] border-b-2 transition-colors ${typeFilter === t ? 'border-primary text-primary font-medium' : 'border-transparent text-ink-2 hover:text-ink'}`}>
            {t === 'ALL' ? 'All' : t === 'TIMING_BELT' ? 'Timing Belts' : 'V-Belts'}{' '}
            <span className="text-ink-3">{counts[t]}</span>
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <p className="py-16 text-center text-[13px] text-ink-3">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="py-16 text-center text-[13px] text-ink-3">No products found.</p>
        ) : (
          <table className="table w-full text-[13px]">
            <thead>
              <tr>
                <th>SKU Code</th>
                <th>Type</th>
                <th>Profile / Family</th>
                <th>Size</th>
                <th>Brand</th>
                <th className="num">Stock</th>
                <th className="num">Min</th>
                <th>Rack</th>
                <th>Unit</th>
                <th>Status</th>
                {can('products.edit') && <th />}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} className={!p.is_active ? 'opacity-45' : ''}>
                  <td className="font-mono text-[12px]">{p.sku_code}</td>
                  <td>{p.product_type === 'TIMING_BELT' ? 'Timing' : 'V-Belt'}</td>
                  <td>{p.hier_l1}</td>
                  <td>{p.exact_size}</td>
                  <td>{p.brand_name}</td>
                  <td className="num">{p.current_stock} {p.unit_code}</td>
                  <td className="num">{p.min_stock_level}</td>
                  <td>{p.rack_location ?? '—'}</td>
                  <td>{p.unit_code}</td>
                  <td>
                    <span className={`badge ${p.stock_status === 'OK' ? 'badge-ok' : p.stock_status === 'OUT_OF_STOCK' ? 'badge-danger' : 'badge-warn'}`}>
                      {p.stock_status === 'OK' ? 'OK' : p.stock_status === 'OUT_OF_STOCK' ? 'Out' : 'Low'}
                    </span>
                  </td>
                  {can('products.edit') && (
                    <td className="flex gap-2 justify-end">
                      <button onClick={() => openEdit(p)} className="icon-btn" title="Edit"><Pencil size={13} /></button>
                      <button onClick={() => toggleActive(p)} className="icon-btn" title={p.is_active ? 'Deactivate' : 'Reactivate'}>
                        {p.is_active ? <ToggleRight size={15} className="text-primary" /> : <ToggleLeft size={15} className="text-ink-3" />}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add / Edit dialog */}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-surface rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto m-4">
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <h2 className="font-semibold">{dialog === 'add' ? 'Add Product' : 'Edit Product'}</h2>
              <button onClick={close} className="icon-btn"><X size={16} /></button>
            </div>
            <div className="p-5 grid grid-cols-2 gap-4">
              {/* Product type */}
              <div className="col-span-2">
                <label className="label">Product Type</label>
                <div className="flex gap-3">
                  {(['TIMING_BELT', 'V_BELT'] as ProductType[]).map((t) => (
                    <label key={t} className="flex items-center gap-1.5 text-[13px] cursor-pointer">
                      <input type="radio" checked={form.product_type === t} onChange={() => set('product_type', t)} />
                      {t === 'TIMING_BELT' ? 'Timing Belt' : 'V-Belt'}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="label">SKU Code <span className="text-red-500">*</span></label>
                <input className="input w-full" value={form.sku_code ?? ''} onChange={(e) => set('sku_code', e.target.value)} disabled={dialog === 'edit'} />
              </div>
              <div>
                <label className="label">Size / Designation <span className="text-red-500">*</span></label>
                <input className="input w-full" value={form.exact_size ?? ''} onChange={(e) => set('exact_size', e.target.value)} />
              </div>

              <div>
                <label className="label">{form.product_type === 'TIMING_BELT' ? 'Family' : 'Profile'} <span className="text-red-500">*</span></label>
                <select className="input w-full" value={form.family_code ?? ''} onChange={(e) => set('family_code', e.target.value)}>
                  <option value="">Select…</option>
                  {activeFamilies.map((f) => <option key={f.code} value={f.code}>{f.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Brand <span className="text-red-500">*</span></label>
                <select className="input w-full" value={form.brand_code ?? ''} onChange={(e) => set('brand_code', e.target.value)}>
                  <option value="">Select…</option>
                  {activeBrands.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
                </select>
              </div>

              <div>
                <label className="label">Display Name</label>
                <input className="input w-full" value={form.display_name ?? ''} onChange={(e) => set('display_name', e.target.value)} placeholder="Auto-generated if empty" />
              </div>
              <div>
                <label className="label">Unit</label>
                <select className="input w-full" value={form.unit_code ?? 'PCS'} onChange={(e) => set('unit_code', e.target.value)}>
                  {['PCS', 'MTR', 'ROLL', 'SET'].map((u) => <option key={u}>{u}</option>)}
                </select>
              </div>

              {dialog === 'add' && (
                <div>
                  <label className="label">Opening Stock</label>
                  <input type="number" className="input w-full" value={form.opening_stock ?? 0} onChange={(e) => set('opening_stock', Number(e.target.value))} />
                </div>
              )}
              <div>
                <label className="label">Min Stock Level</label>
                <input type="number" className="input w-full" value={form.min_stock_level ?? 0} onChange={(e) => set('min_stock_level', Number(e.target.value))} />
              </div>
              <div>
                <label className="label">Supplier MOQ</label>
                <input type="number" className="input w-full" value={form.supplier_moq ?? 0} onChange={(e) => set('supplier_moq', Number(e.target.value))} />
              </div>
              <div>
                <label className="label">Reorder Qty</label>
                <input type="number" className="input w-full" value={form.reorder_quantity ?? 0} onChange={(e) => set('reorder_quantity', Number(e.target.value))} />
              </div>
              <div>
                <label className="label">Rack Location</label>
                <input className="input w-full" value={form.rack_location ?? ''} onChange={(e) => set('rack_location', e.target.value)} />
              </div>

              {/* Timing belt specific */}
              {form.product_type === 'TIMING_BELT' && (<>
                <div><label className="label">Belt Form</label>
                  <select className="input w-full" value={form.belt_form ?? ''} onChange={(e) => set('belt_form', e.target.value)}>
                    <option value="">—</option>
                    <option>Endless</option><option>Open-Ended</option>
                  </select></div>
                <div><label className="label">Pitch (mm)</label>
                  <input type="number" className="input w-full" value={form.pitch_mm ?? ''} onChange={(e) => set('pitch_mm', e.target.value ? Number(e.target.value) : null)} /></div>
                <div><label className="label">Pitch Length (mm)</label>
                  <input type="number" className="input w-full" value={form.pitch_length_mm ?? ''} onChange={(e) => set('pitch_length_mm', e.target.value ? Number(e.target.value) : null)} /></div>
                <div><label className="label">Width (mm)</label>
                  <input type="number" className="input w-full" value={form.width_mm ?? ''} onChange={(e) => set('width_mm', e.target.value ? Number(e.target.value) : null)} /></div>
                <div><label className="label">Teeth</label>
                  <input type="number" className="input w-full" value={form.teeth ?? ''} onChange={(e) => set('teeth', e.target.value ? Number(e.target.value) : null)} /></div>
                <div><label className="label">Standard</label>
                  <input className="input w-full" value={form.standard ?? ''} onChange={(e) => set('standard', e.target.value)} /></div>
              </>)}

              {/* V-Belt specific */}
              {form.product_type === 'V_BELT' && (<>
                <div><label className="label">Construction</label>
                  <input className="input w-full" value={form.construction ?? ''} onChange={(e) => set('construction', e.target.value)} /></div>
                <div><label className="label">Nominal Length</label>
                  <input type="number" className="input w-full" value={form.nominal_length ?? ''} onChange={(e) => set('nominal_length', e.target.value ? Number(e.target.value) : null)} /></div>
                <div><label className="label">Length Designation</label>
                  <input className="input w-full" value={form.length_designation ?? ''} onChange={(e) => set('length_designation', e.target.value)} /></div>
              </>)}
            </div>

            {err && <p className="px-5 pb-2 text-[12px] text-red-500">{err}</p>}
            <div className="px-5 py-4 border-t border-line flex justify-end gap-3">
              <button onClick={close} className="btn">Cancel</button>
              <button onClick={save} disabled={saving} className="btn btn-primary">
                {saving ? 'Saving…' : dialog === 'add' ? 'Add Product' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
