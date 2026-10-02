'use client';

import { useEffect, useMemo, useState } from 'react';
import { Search, Plus, Pencil, ToggleLeft, ToggleRight, X } from 'lucide-react';
import { PRODUCT_TYPE_LABEL, type Permission, type ProductType } from '@/lib/types';
import { PRODUCT_TYPES, TYPE_META, buildIdentity, isIdentityError } from '@/lib/sheet-config';

interface Product {
  id: string; sku_code: string; product_type: ProductType;
  display_name: string; exact_size: string;
  hier_l1: string; hier_l2: string; hier_l3: string;
  brand_name: string; family_name: string;
  section?: string | null; colour?: string | null;
  length_mm?: number | null; width_mm?: number | null; thickness_mm?: number | null;
  remarks?: string | null; created_via?: string;
  unit_code: string; current_stock: number; min_stock_level: number;
  rack_location: string | null; is_active: boolean; stock_status: string;
  roll_length_mm?: number | null;
}

interface Brand { id: string; code: string; name: string; }
interface Family { id: string; code: string; name: string; product_type: string; }

interface Form {
  product_type: ProductType;
  family: string; section: string; size: string; colour: string; brand: string;
  length: string; width: string; thickness: string;
  display_name: string; min_stock_level: string; roll_length_mm: string;
  rack_location: string; remarks: string;
}

const EMPTY: Form = {
  product_type: 'TIMING_BELT', family: '', section: '', size: '', colour: '', brand: '',
  length: '', width: '', thickness: '', display_name: '', min_stock_level: '0',
  roll_length_mm: '', rack_location: '', remarks: '',
};

const numStr = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));

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
  const [rollFilter, setRollFilter] = useState<'ALL' | 'WITH' | 'MISSING'>('ALL');
  const [dialog, setDialog] = useState<'add' | 'edit' | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    setLoading(true);
    const r = await fetch('/api/products');
    if (r.ok) setProducts(await r.json());
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter((p) => {
      if (!showInactive && !p.is_active) return false;
      if (typeFilter !== 'ALL' && p.product_type !== typeFilter) return false;
      if (rollFilter === 'WITH' && !(Number(p.roll_length_mm) > 0)) return false;
      if (rollFilter === 'MISSING' && Number(p.roll_length_mm) > 0) return false;
      if (!q) return true;
      return [p.sku_code, p.exact_size, p.brand_name, p.hier_l1, p.hier_l2, p.remarks ?? '']
        .some((v) => v.toLowerCase().includes(q));
    });
  }, [products, query, typeFilter, showInactive, rollFilter]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const openAdd = () => { setForm({ ...EMPTY, product_type: typeFilter === 'ALL' ? 'TIMING_BELT' : typeFilter }); setEditing(null); setErr(''); setDialog('add'); };
  const openEdit = (p: Product) => {
    setEditing(p);
    setForm({
      product_type: p.product_type, family: p.family_name, section: p.section ?? '', size: p.hier_l3,
      colour: p.colour ?? '', brand: p.brand_name,
      length: numStr(p.length_mm), width: numStr(p.width_mm), thickness: numStr(p.thickness_mm),
      display_name: p.display_name, min_stock_level: numStr(p.min_stock_level),
      roll_length_mm: numStr(p.roll_length_mm), rack_location: p.rack_location ?? '', remarks: p.remarks ?? '',
    });
    setErr(''); setDialog('edit');
  };
  const close = () => { setDialog(null); setEditing(null); setErr(''); };

  const isConveyor = form.product_type === 'CONVEYOR_BELT';
  const meta = TYPE_META[form.product_type];
  const familyOptions = families.filter((f) => f.product_type === form.product_type);

  // Live preview of the SKU code the server will generate (readable base only).
  const idPreview = buildIdentity(form.product_type, {
    family: form.family, section: form.section, size: form.size, colour: form.colour,
    brand: form.brand, length: form.length, width: form.width, thickness: form.thickness,
  });
  const codePreview = isIdentityError(idPreview) ? '' : idPreview.codeBase;

  const save = async () => {
    setSaving(true); setErr('');
    const adding = dialog === 'add';
    const payload = adding
      ? { ...form }
      : {
        id: editing!.id, display_name: form.display_name, min_stock_level: form.min_stock_level,
        roll_length_mm: form.roll_length_mm, rack_location: form.rack_location, remarks: form.remarks,
      };
    const r = await fetch('/api/products', {
      method: adding ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    setSaving(false);
    if (!r.ok) { setErr(j.error ?? 'Save failed'); return; }
    close(); void load();
  };

  const toggleActive = async (p: Product) => {
    await fetch('/api/products', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, is_active: !p.is_active }),
    });
    void load();
  };

  const active = (p: Product) => showInactive || p.is_active;
  const counts: Record<string, number> = { ALL: products.filter(active).length };
  for (const t of PRODUCT_TYPES) counts[t] = products.filter((p) => active(p) && p.product_type === t).length;

  const rollCounts = {
    with: products.filter((p) => active(p) && Number(p.roll_length_mm) > 0).length,
    missing: products.filter((p) => active(p) && !(Number(p.roll_length_mm) > 0)).length,
  };
  const unitLabel = (p: Product) => (p.unit_code === 'MM' ? 'mm' : p.unit_code);
  const lockId = dialog === 'edit';

  return (
    <div className="flex flex-col h-[calc(100vh/var(--z,1)-56px)]">
      <div className="px-4 lg:px-6 py-3.5 border-b border-line bg-surface flex flex-wrap items-center gap-3">
        <h1 className="text-[19px] font-semibold">Product Master</h1>
        <div className="relative ml-2">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search family, section, size, make or SKU…"
            className="field pl-8 w-72 text-[15px]" />
        </div>
        <div className="flex items-center gap-1 rounded-lg border-2 border-[#0b5fff] bg-white p-0.5" title="Filter by roll length">
          {([['ALL', 'All rolls', '#0b5fff'], ['WITH', `With roll length (${rollCounts.with})`, '#008a3e'], ['MISSING', `No roll length (${rollCounts.missing})`, '#d6141f']] as const).map(([k, label, c]) => (
            <button key={k} onClick={() => setRollFilter(k)}
              style={rollFilter === k ? { background: c, color: '#fff' } : { color: c }}
              className="h-8 px-2.5 rounded-md text-[14px] font-bold hover:opacity-90">{label}</button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[14px] text-ink-2 cursor-pointer ml-1">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="rounded" />
          Show inactive
        </label>
        {can('products.create') && (
          <button onClick={openAdd} className="btn btn-primary ml-auto flex items-center gap-1.5 text-[15px]">
            <Plus size={14} /> Add Product
          </button>
        )}
      </div>

      <div className="px-4 lg:px-6 border-b border-line flex gap-4 bg-surface">
        {(['ALL', ...PRODUCT_TYPES] as const).map((t) => (
          <button key={t} onClick={() => setTypeFilter(t)}
            className={`py-2.5 text-[15px] border-b-2 transition-colors ${typeFilter === t ? 'border-primary text-primary font-medium' : 'border-transparent text-ink-2 hover:text-ink'}`}>
            {t === 'ALL' ? 'All' : TYPE_META[t].label}{' '}
            <span className="text-ink-3">{counts[t]}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <p className="py-16 text-center text-[15px] text-ink-3">Loading…</p>
        ) : filtered.length === 0 ? (
          <p className="py-16 text-center text-[15px] text-ink-3">
            No products yet. Use <strong>Import Data → 1 · Products</strong> or <strong>Add Product</strong>.
          </p>
        ) : (
          <table className="table w-full text-[15px]">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Type</th>
                <th>Product Family</th>
                <th>Section / Colour</th>
                <th>Size</th>
                <th>Make</th>
                <th>Roll length</th>
                <th className="num">Stock</th>
                <th className="num">Min</th>
                <th>Remarks</th>
                <th>Status</th>
                {can('products.edit') && <th />}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} className={!p.is_active ? 'opacity-45' : ''}>
                  <td className="font-mono text-[14px] whitespace-nowrap">{p.sku_code}</td>
                  <td>{TYPE_META[p.product_type].short}</td>
                  <td>{p.hier_l1}</td>
                  <td>{p.section ?? p.colour ?? p.hier_l2}</td>
                  <td className="whitespace-nowrap">{p.hier_l3}</td>
                  <td>{p.brand_name}</td>
                  <td className="whitespace-nowrap">
                    {Number(p.roll_length_mm) > 0
                      ? <span className="badge badge-ok">{Number(p.roll_length_mm)} mm</span>
                      : <span className="badge badge-danger">No roll length</span>}
                  </td>
                  <td className="num whitespace-nowrap">{p.current_stock} {unitLabel(p)}</td>
                  <td className="num">{p.min_stock_level}</td>
                  <td className="text-ink-3 max-w-[200px] truncate" title={p.remarks ?? ''}>{p.remarks ?? '—'}</td>
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

      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-surface rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto m-4">
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <h2 className="font-semibold">{dialog === 'add' ? 'Add Product' : `Edit ${editing?.sku_code}`}</h2>
              <button onClick={close} className="icon-btn"><X size={16} /></button>
            </div>

            <div className="p-5 grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="label">Product Type</label>
                <div className="flex gap-4">
                  {PRODUCT_TYPES.map((t) => (
                    <label key={t} className={`flex items-center gap-1.5 text-[15px] ${lockId ? 'opacity-60' : 'cursor-pointer'}`}>
                      <input type="radio" disabled={lockId} checked={form.product_type === t} onChange={() => set('product_type', t)} />
                      {PRODUCT_TYPE_LABEL[t]}
                    </label>
                  ))}
                </div>
              </div>

              <div className="col-span-2">
                <label className="label">SKU</label>
                <p className="text-[15px] font-mono">
                  {dialog === 'edit' ? editing?.sku_code : (codePreview || <span className="text-ink-3 font-sans">Generated automatically once the fields below are filled</span>)}
                </p>
              </div>

              <div>
                <label className="label">Product Family <span className="text-danger">*</span></label>
                <input className="field w-full" list="pm-families" disabled={lockId} value={form.family}
                  onChange={(e) => set('family', e.target.value)} placeholder={isConveyor ? 'e.g. PU, PVC' : 'e.g. CLASSICAL'} />
                <datalist id="pm-families">{familyOptions.map((f) => <option key={f.id} value={f.name} />)}</datalist>
              </div>

              {isConveyor ? (
                <div>
                  <label className="label">Colour <span className="text-danger">*</span></label>
                  <input className="field w-full" disabled={lockId} value={form.colour} onChange={(e) => set('colour', e.target.value)} />
                </div>
              ) : (
                <div>
                  <label className="label">{form.product_type === 'V_BELT' ? 'Section of V Belt' : 'Section of Timing Belt'} <span className="text-danger">*</span></label>
                  <input className="field w-full" disabled={lockId} value={form.section} onChange={(e) => set('section', e.target.value)} placeholder="e.g. L, MXL, A, B" />
                </div>
              )}

              {isConveyor ? (
                <>
                  <div>
                    <label className="label">Make <span className="text-danger">*</span></label>
                    <input className="field w-full" list="pm-brands" disabled={lockId} value={form.brand} onChange={(e) => set('brand', e.target.value)} />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div><label className="label">L <span className="text-danger">*</span></label>
                      <input type="number" className="field w-full" disabled={lockId} value={form.length} onChange={(e) => set('length', e.target.value)} /></div>
                    <div><label className="label">W <span className="text-danger">*</span></label>
                      <input type="number" className="field w-full" disabled={lockId} value={form.width} onChange={(e) => set('width', e.target.value)} /></div>
                    <div><label className="label">T</label>
                      <input type="number" step="any" className="field w-full" disabled={lockId} value={form.thickness} onChange={(e) => set('thickness', e.target.value)} /></div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="label">Size <span className="text-danger">*</span></label>
                    <input className="field w-full" disabled={lockId} value={form.size} onChange={(e) => set('size', e.target.value)} />
                  </div>
                  <div>
                    <label className="label">Make <span className="text-danger">*</span></label>
                    <input className="field w-full" list="pm-brands" disabled={lockId} value={form.brand} onChange={(e) => set('brand', e.target.value)} />
                  </div>
                </>
              )}
              <datalist id="pm-brands">{brands.map((b) => <option key={b.id} value={b.name} />)}</datalist>

              {dialog === 'edit' && (
                <div className="col-span-2">
                  <label className="label">Display Name</label>
                  <input className="field w-full" value={form.display_name} onChange={(e) => set('display_name', e.target.value)} />
                </div>
              )}

              <div>
                <label className="label">Minimum Stock Level ({meta.unit === 'MM' ? 'mm' : 'pcs'})</label>
                <input type="number" className="field w-full" value={form.min_stock_level} onChange={(e) => set('min_stock_level', e.target.value)} />
              </div>
              <div>
                <label className="label">Location</label>
                <input className="field w-full" value={form.rack_location} onChange={(e) => set('rack_location', e.target.value)} />
              </div>

              {form.product_type === 'TIMING_BELT' && (
                <div className="col-span-2">
                  <label className="label">Roll Length (mm) <span className="text-ink-3 font-normal">— length of 1 full sleeve (filled automatically by the inventory import)</span></label>
                  <input type="number" className="field w-48" value={form.roll_length_mm} onChange={(e) => set('roll_length_mm', e.target.value)} />
                </div>
              )}

              <div className="col-span-2">
                <label className="label">Remarks</label>
                <input className="field w-full" value={form.remarks} onChange={(e) => set('remarks', e.target.value)} />
              </div>

              {dialog === 'add' && (
                <p className="col-span-2 text-[13px] text-ink-3">
                  Stock is not entered here. After adding, receive it through Inward, or load it with Import Data → 2 · Inventory.
                </p>
              )}
            </div>

            {err && <p className="px-5 pb-2 text-[14px] text-danger">{err}</p>}
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
