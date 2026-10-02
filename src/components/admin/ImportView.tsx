'use client';

/**
 * Import screen — two separate imports, one component:
 *   1 · Products   builds the product master (SKUs) from identity columns only
 *   2 · Inventory  loads what is physically in stock and attaches it to SKUs
 *
 * What each import expects, and how columns are named, lives in
 * src/lib/sheet-config.ts — edit that file to change fields, nothing here.
 * Every import ends in a server-checked PREVIEW (dry run) before anything is saved.
 */

import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { Upload, CheckCircle, AlertCircle, Eye, ArrowLeft, Loader2, AlertTriangle } from 'lucide-react';
import type { ProductType } from '@/lib/types';
import {
  PRODUCT_TYPES, TYPE_META, autoMap, detectProductType, fieldsFor, type ImportKind,
} from '@/lib/sheet-config';

type Mode = 'OVERWRITE' | 'ADD';
type Step = 'upload' | 'map' | 'preview' | 'done';

interface DryRun {
  blocked: string | null;
  summary: Record<string, unknown> & { mode: Mode };
  preview: Record<string, string | number>[];
  errors: string[];
}

const ENDPOINT: Record<ImportKind, string> = {
  SKU: '/api/admin/import-skus',
  INVENTORY: '/api/admin/import-inventory',
};

export default function ImportView() {
  const fileRef = useRef<HTMLInputElement>(null);
  const wbRef = useRef<XLSX.WorkBook | null>(null);

  const [kind, setKind] = useState<ImportKind>('SKU');
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [sheet, setSheet] = useState('');
  const [type, setType] = useState<ProductType>('TIMING_BELT');
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<Mode>('OVERWRITE');
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dry, setDry] = useState<DryRun | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const fields = fieldsFor(kind, type);
  const meta = TYPE_META[type];
  const requiredMet = fields.filter((f) => f.required).every((f) => mapping[f.key]);
  const autoCount = fields.filter((f) => mapping[f.key]).length;

  const reset = (nextKind: ImportKind = kind) => {
    setKind(nextKind); setStep('upload'); setFile(null); setSheets([]); setSheet(''); setHeaders([]);
    setMapping({}); setMode('OVERWRITE'); setConfirmWipe(false); setErr(''); setDry(null); setResult(null);
    wbRef.current = null;
    if (fileRef.current) fileRef.current.value = '';
  };

  const applySheet = (wb: XLSX.WorkBook, name: string, forKind: ImportKind, forceType?: ProductType) => {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, range: 0 });
    const hs = ((rows[0] ?? []) as unknown[]).map((h) => String(h ?? '').trim()).filter(Boolean);
    const t = forceType ?? detectProductType(name) ?? 'TIMING_BELT';
    setSheet(name); setHeaders(hs); setType(t);
    setMapping(autoMap(hs, fieldsFor(forKind, t)));
    setDry(null); setErr('');
  };

  const handleFile = async (f: File) => {
    setErr('');
    try {
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
      wbRef.current = wb;
      setFile(f);
      setSheets(wb.SheetNames);
      const first = wb.SheetNames.find((n) => detectProductType(n)) ?? wb.SheetNames[0];
      applySheet(wb, first, kind);
      setStep('map');
    } catch {
      setErr('Could not read that file. Upload an .xlsx, .xls or .csv.');
    }
  };

  const post = async (dryRun: boolean) => {
    if (!file) return null;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('sheet', sheet);
    fd.append('productType', type);
    fd.append('mode', mode);
    fd.append('dryRun', String(dryRun));
    fd.append('mapping', JSON.stringify(mapping));
    const r = await fetch(ENDPOINT[kind], { method: 'POST', body: fd });
    const text = await r.text();
    let j: Record<string, unknown>;
    try { j = JSON.parse(text); } catch {
      j = { error: `The server returned an empty or unreadable response (HTTP ${r.status}). ` +
        'Check that migration 018 has been run in Supabase, and look at the dev-server terminal for the exact error.' };
    }
    return { ok: r.ok, j };
  };

  const runPreview = async () => {
    setBusy(true); setErr(''); setConfirmWipe(false);
    try {
      const res = await post(true);
      if (!res) return;
      if (!res.ok) { setErr(String(res.j.error ?? 'Preview failed')); return; }
      setDry(res.j as unknown as DryRun);
      setStep('preview');
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  const runImport = async () => {
    setBusy(true); setErr('');
    try {
      const res = await post(false);
      if (!res) return;
      if (!res.ok) { setErr(String(res.j.error ?? 'Import failed')); return; }
      setResult(res.j); setStep('done');
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };

  const wipes = mode === 'OVERWRITE';
  const sm = (dry?.summary ?? {}) as Record<string, unknown>;
  const actionable = kind === 'SKU'
    ? Number(sm.newSkus ?? 0)
    : Number(sm.matched ?? 0) + Number(sm.newSkus ?? 0);
  const canImport = !!dry && !dry.blocked && (!wipes || confirmWipe) && !busy && actionable > 0;

  return (
    <div className="flex flex-col h-[calc(100vh/var(--z,1)-56px)]">
      <div className="px-4 lg:px-6 py-3.5 border-b border-line bg-surface flex items-center gap-3">
        <h1 className="text-[19px] font-semibold">Import Data</h1>
        {step !== 'upload' && (
          <button onClick={() => reset()} className="ml-auto btn text-[15px]">Start Over</button>
        )}
      </div>

      <div className="px-4 lg:px-6 border-b border-line flex gap-5 bg-surface">
        {([['SKU', '1 · Products'], ['INVENTORY', '2 · Inventory']] as [ImportKind, string][]).map(([k, label]) => (
          <button key={k} onClick={() => k !== kind && reset(k)}
            className={`py-2.5 text-[15px] border-b-2 transition-colors ${kind === k ? 'border-primary text-primary font-medium' : 'border-transparent text-ink-2 hover:text-ink'}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto px-4 lg:px-6 py-6 max-w-5xl">
        {/* ── Upload ── */}
        {step === 'upload' && (
          <div className="max-w-3xl">
            <p className="text-[15px] text-ink-2 mb-2">
              {kind === 'SKU'
                ? 'Builds the product master: Product Family → Section → Size → Make (Colour / L / W / T for conveyor). SKU numbers are generated automatically.'
                : 'Loads current stock from your register and attaches it to products. Rows are matched to products by Family + Section + Size + Make — not by SKU code.'}
            </p>
            <p className="text-[14px] text-ink-3 mb-6">
              {kind === 'SKU'
                ? 'Cut Pcs / Full Sleeve, UOM, QTY and Location are inventory details — they are handled in the Inventory import, not here.'
                : 'A product that is not in Product Master yet is created automatically and listed in the result.'}
            </p>
            <div
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void handleFile(f); }}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-line rounded-xl p-12 text-center cursor-pointer hover:border-primary transition-colors"
            >
              <Upload size={28} className="mx-auto text-ink-3 mb-3" />
              <p className="text-[16px] font-medium mb-1">Drop your file here or click to browse</p>
              <p className="text-[14px] text-ink-3">.xlsx, .xls or .csv</p>
            </div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
            {err && <p className="mt-3 text-[15px] text-danger">{err}</p>}
          </div>
        )}

        {/* ── Map ── */}
        {step === 'map' && (
          <div className="max-w-3xl">
            <div className="flex flex-wrap gap-4 mb-5">
              {sheets.length > 1 && (
                <div>
                  <label className="label">Sheet / Tab</label>
                  <select className="field" value={sheet}
                    onChange={(e) => wbRef.current && applySheet(wbRef.current, e.target.value, kind)}>
                    {sheets.map((s) => (
                      <option key={s} value={s}>{s}{detectProductType(s) ? '' : '  (not a product sheet)'}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="label">Product type in this sheet</label>
                <select className="field" value={type}
                  onChange={(e) => wbRef.current && applySheet(wbRef.current, sheet, kind, e.target.value as ProductType)}>
                  {PRODUCT_TYPES.map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
                </select>
              </div>
            </div>

            <ModePicker kind={kind} type={type} mode={mode} setMode={setMode} />

            <p className="text-[14px] text-ink-3 mb-3">
              <strong>{headers.length}</strong> columns found · <strong>{autoCount}</strong> of {fields.length} fields matched automatically
              by name. Change any that look wrong.
            </p>

            <table className="w-full text-[15px] border border-line rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-surface-2">
                  <th className="text-left px-3 py-2.5 font-medium text-ink-2 w-[42%]">System expects</th>
                  <th className="text-left px-3 py-2.5 font-medium text-ink-2">Your sheet column</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => {
                  const ok = !!mapping[f.key];
                  return (
                    <tr key={f.key} className="border-t border-line">
                      <td className="px-3 py-2">
                        <span className="font-medium">{f.label}</span>
                        {f.required && <span className="text-danger ml-0.5">*</span>}
                        {f.hint && <span className="block text-[13px] text-ink-3">{f.hint}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <select className={`field w-full ${f.required && !ok ? 'border-danger' : ''}`}
                          value={mapping[f.key] ?? ''}
                          onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}>
                          <option value="">{f.required ? '— choose a column —' : '— not in my sheet —'}</option>
                          {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </td>
                      <td className="px-2">
                        {ok ? <CheckCircle size={15} className="text-ok" />
                          : f.required ? <AlertCircle size={15} className="text-danger" /> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {err && <ErrorBox text={err} />}
            <div className="mt-6 flex items-center gap-3">
              <button onClick={runPreview} disabled={!requiredMet || busy} className="btn btn-primary flex items-center gap-1.5">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />} Preview
              </button>
              {!requiredMet && <p className="text-[14px] text-danger">Choose a column for every required (*) field.</p>}
            </div>
          </div>
        )}

        {/* ── Preview ── */}
        {step === 'preview' && dry && (
          <div>
            <button onClick={() => setStep('map')} className="btn text-[14px] flex items-center gap-1.5 mb-4">
              <ArrowLeft size={13} /> Back to mapping
            </button>

            <SummaryCards kind={kind} summary={dry.summary} />

            {dry.blocked && (
              <div className="mb-4 flex items-start gap-2 text-[15px] text-danger bg-red-50 border border-red-200 rounded-lg p-3">
                <AlertCircle size={15} className="mt-0.5 shrink-0" /> {dry.blocked}
              </div>
            )}

            <p className="text-[14px] text-ink-3 mb-2">
              First {dry.preview.length} rows exactly as they will be saved:
            </p>
            <div className="overflow-auto border border-line rounded-lg">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="bg-surface-2 text-left text-ink-2">
                    <th className="px-3 py-2 font-medium">Row</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                    <th className="px-3 py-2 font-medium">SKU</th>
                    <th className="px-3 py-2 font-medium">Product Family</th>
                    <th className="px-3 py-2 font-medium">{meta.levels[1]}</th>
                    <th className="px-3 py-2 font-medium">Size</th>
                    <th className="px-3 py-2 font-medium">Make</th>
                    {kind === 'INVENTORY' && meta.usesLots && <th className="px-3 py-2 font-medium">Cut / Full</th>}
                    {kind === 'INVENTORY' && <th className="px-3 py-2 font-medium">Stock loaded</th>}
                    <th className="px-3 py-2 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {dry.preview.map((r, i) => (
                    <tr key={i} className="border-t border-line align-top">
                      <td className="px-3 py-1.5 text-ink-3">{r.rowNum}</td>
                      <td className="px-3 py-1.5"><StatusBadge status={String(r.status)} /></td>
                      <td className="px-3 py-1.5 font-mono whitespace-nowrap">{r.skuCode}</td>
                      <td className="px-3 py-1.5">{r.family}</td>
                      <td className="px-3 py-1.5">{r.sectionOrColour}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{r.size}</td>
                      <td className="px-3 py-1.5">{r.brand}</td>
                      {kind === 'INVENTORY' && meta.usesLots && <td className="px-3 py-1.5 whitespace-nowrap">{r.lot}</td>}
                      {kind === 'INVENTORY' && <td className="px-3 py-1.5 whitespace-nowrap">{r.load}</td>}
                      <td className="px-3 py-1.5 text-ink-3">{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {dry.errors.length > 0 && (
              <div className="mt-4 border border-yellow-200 bg-yellow-50 rounded-lg p-3">
                <p className="text-[14px] font-medium text-yellow-800 mb-1.5">
                  {dry.errors.length} row(s) will be skipped:
                </p>
                <ul className="text-[14px] text-yellow-700 space-y-0.5 max-h-40 overflow-auto">
                  {dry.errors.map((e, i) => <li key={i}>• {e}</li>)}
                </ul>
              </div>
            )}

            {wipes && !dry.blocked && (
              <label className="mt-5 flex items-start gap-2 text-[15px] bg-amber-50 border border-amber-200 rounded-lg p-3 cursor-pointer">
                <input type="checkbox" className="mt-0.5" checked={confirmWipe} onChange={(e) => setConfirmWipe(e.target.checked)} />
                <span>
                  <AlertTriangle size={13} className="inline -mt-0.5 mr-1 text-warn" />
                  Overwrite will <strong>wipe the existing {meta.label.toLowerCase()} {kind === 'SKU' ? 'products' : 'stock and lots'}</strong> before
                  importing this sheet. I understand.
                </span>
              </label>
            )}

            {err && <ErrorBox text={err} />}
            <div className="mt-6 flex items-center gap-3">
              <button onClick={runImport} disabled={!canImport} className="btn btn-primary">
                {busy ? 'Importing…' : 'Looks good — Import'}
              </button>
              <button onClick={() => setStep('map')} className="btn" disabled={busy}>Back</button>
            </div>
          </div>
        )}

        {/* ── Done ── */}
        {step === 'done' && result && (
          <div className="max-w-3xl">
            <div className="flex items-center gap-3 mb-5">
              <CheckCircle size={28} className="text-ok" />
              <div>
                <p className="font-semibold">Import complete</p>
                <p className="text-[15px] text-ink-2">
                  {kind === 'SKU'
                    ? `${result.created} products created · ${result.existing} already existed · ${result.duplicates} duplicate rows in sheet`
                    : `${result.skusUpdated} products updated · ${result.lotsCreated} lots created · ${(result.newSkus as string[]).length} new products auto-created`}
                </p>
              </div>
            </div>

            {kind === 'INVENTORY' && (result.newSkus as string[]).length > 0 && (
              <div className="mb-4 border border-line rounded-lg p-3 bg-subtle">
                <p className="text-[14px] font-medium mb-1">Created from this import (not in Product Master before):</p>
                <p className="text-[14px] font-mono text-ink-2 break-words">{(result.newSkus as string[]).join(', ')}</p>
              </div>
            )}

            {(result.errors as string[]).length > 0 && (
              <div className="border border-yellow-200 bg-yellow-50 rounded-lg p-4 mb-4">
                <p className="text-[15px] font-medium text-yellow-800 mb-2">{(result.errors as string[]).length} rows skipped:</p>
                <ul className="text-[14px] text-yellow-700 space-y-1 max-h-48 overflow-auto">
                  {(result.errors as string[]).map((e, i) => <li key={i}>• {e}</li>)}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button onClick={() => reset()} className="btn">Import another file</button>
              {kind === 'SKU' && <button onClick={() => reset('INVENTORY')} className="btn btn-primary">Next: import inventory →</button>}
              <a href="/products" className="btn">Product Master →</a>
              <a href="/inventory" className="btn">Inventory →</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── small pieces ── */

function ModePicker({ kind, type, mode, setMode }: {
  kind: ImportKind; type: ProductType; mode: Mode; setMode: (m: Mode) => void;
}) {
  const meta = TYPE_META[type];
  const opts: [Mode, string, string][] = kind === 'SKU'
    ? [
      ['OVERWRITE', 'Overwrite', `Wipe the existing ${meta.label.toLowerCase()} products, then import this sheet fresh.`],
      ['ADD', 'Add new only', 'Keep every product already in the system; create only the ones that are not there yet.'],
    ]
    : [
      ['OVERWRITE', 'Overwrite', `Wipe the current ${meta.label.toLowerCase()} stock${meta.usesLots ? ' and lots' : ''}, then load this sheet.`],
      ['ADD', 'Add to current stock', meta.usesLots
        ? 'Keep current stock; every row adds NEW lots on top.'
        : 'Keep current stock; add this sheet’s pieces on top.'],
    ];
  return (
    <div className="mb-5">
      <label className="label">If data already exists in the system</label>
      <div className="flex flex-wrap gap-5 mt-1">
        {opts.map(([m, title, desc]) => (
          <label key={m} className="flex items-start gap-1.5 text-[14px] cursor-pointer max-w-[300px]">
            <input type="radio" className="mt-0.5" checked={mode === m} onChange={() => setMode(m)} />
            <span><strong>{title}</strong><span className="block text-ink-3">{desc}</span></span>
          </label>
        ))}
      </div>
    </div>
  );
}

function SummaryCards({ kind, summary }: { kind: ImportKind; summary: DryRun['summary'] }) {
  const s = summary as Record<string, unknown>;
  const cards: [string, unknown][] = kind === 'SKU'
    ? [['New products', s.newSkus], ['Already exist', s.existing], ['Duplicate rows', s.duplicates], ['Problem rows', s.errors]]
    : [['Matched products', s.matched], ['New products to create', s.newSkus],
       [s.lotsToCreate ? 'Lots to create' : 'Total pieces', s.lotsToCreate || s.totalLoad], ['Problem rows', s.errors]];
  const brands = (s.newBrands as string[] | undefined) ?? [];
  const families = (s.newFamilies as string[] | undefined) ?? [];
  return (
    <div className="mb-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        {cards.map(([label, v]) => (
          <div key={label} className="border border-line rounded-lg px-3 py-2.5 bg-surface">
            <p className="text-[13px] text-ink-3">{label}</p>
            <p className="text-[22px] font-semibold num">{String(v ?? 0)}</p>
          </div>
        ))}
      </div>
      {kind === 'SKU' && (brands.length > 0 || families.length > 0) && (
        <p className="text-[14px] text-ink-3">
          {families.length > 0 && <>New product families: <strong className="text-ink-2">{families.join(', ')}</strong>. </>}
          {brands.length > 0 && <>New makes: <strong className="text-ink-2">{brands.join(', ')}</strong>.</>}
        </p>
      )}
      {kind === 'INVENTORY' && Number(s.newSkus) > 0 && (
        <p className="text-[14px] text-ink-3">
          {String(s.newSkus)} product(s) in this sheet are not in Product Master — they will be created automatically.
        </p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    NEW: ['New', 'badge-ok'], MATCH: ['Matched', 'badge-ok'], NEW_SKU: ['New SKU', 'badge-warn'],
    EXISTS: ['Exists', 'badge'], DUPLICATE: ['Duplicate', 'badge'], ERROR: ['Problem', 'badge-danger'],
  };
  const [label, cls] = map[status] ?? [status, 'badge'];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div className="mt-4 flex items-start gap-2 text-[15px] text-danger bg-red-50 rounded-lg p-3">
      <AlertCircle size={14} className="mt-0.5 shrink-0" /> {text}
    </div>
  );
}
