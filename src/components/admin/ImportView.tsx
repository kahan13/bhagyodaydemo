'use client';

/**
 * Import screen — two separate imports, one component:
 *   1 · Products   builds the product master (SKUs) from identity columns (+ MSL)
 *   2 · Inventory  loads what is physically in stock and attaches it to SKUs
 *
 * One workbook, many sheets: every sheet is listed with a tick box, its product type
 * (read from the column headings) and whether its columns matched. One preview, one import.
 *
 * What each import expects, and how columns are named, lives in src/lib/sheet-config.ts.
 * Every import ends in a server-checked PREVIEW (dry run) before anything is saved.
 * A row with a blank Make / Section / Size is NOT dropped — it is imported as UNSPECIFIED,
 * flagged, and listed here under "Rows to fix" so it can be corrected first.
 */

import { useRef, useState } from 'react';
import { Upload, CheckCircle, AlertCircle, Eye, ArrowLeft, Loader2, AlertTriangle, Trash2 } from 'lucide-react';
import type { ProductType } from '@/lib/types';
import {
  PRODUCT_TYPES, TYPE_META, autoMap, detectProductType, detectTypeFromHeaders, fieldsFor, type FieldDef, type ImportKind,
} from '@/lib/sheet-config';
import { hiddenSheets, readWorkbook, readWorksheet } from '@/lib/sheet-read';

type Mode = 'OVERWRITE' | 'ADD';
type Step = 'upload' | 'sheets' | 'preview' | 'done';

interface SheetUi {
  name: string;
  rows: number;
  headers: string[];
  type: ProductType;
  /** The type could not be told from the headings or the tab name — the person should check it. */
  typeGuessed: boolean;
  mapping: Record<string, string>;
  include: boolean;
  /** Hidden in Excel — listed, but not ticked until the person chooses. */
  hidden: boolean;
}

interface Issue { sheet: string; row: number; kind: 'MISSING' | 'SKIPPED' | 'FILLED'; text: string }
interface PerSheet { name: string; type: ProductType; rows: number; [k: string]: unknown }

interface DryRun {
  blocked: string | null;
  summary: Record<string, unknown> & { mode: Mode };
  perSheet: PerSheet[];
  preview: Record<string, string | number>[];
  issues: Issue[];
  issueCount: number;
}

const ENDPOINT: Record<ImportKind, string> = {
  SKU: '/api/admin/import-skus',
  INVENTORY: '/api/admin/import-inventory',
  MSL: '/api/admin/import-msl',
};

const requiredMet = (s: SheetUi, kind: ImportKind) =>
  fieldsFor(kind, s.type).filter((f) => f.required).every((f) => s.mapping[f.key]);

export default function ImportView() {
  const fileRef = useRef<HTMLInputElement>(null);

  const [kind, setKind] = useState<ImportKind>('SKU');
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<SheetUi[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('ADD');
  const [mslMode, setMslMode] = useState<'FILL' | 'OVERWRITE'>('FILL');
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [dry, setDry] = useState<DryRun | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const chosen = sheets.filter((s) => s.include);
  const types = [...new Set(chosen.map((s) => s.type))];
  const allReady = chosen.length > 0 && chosen.every((s) => requiredMet(s, kind));

  const reset = (nextKind: ImportKind = kind) => {
    setKind(nextKind); setStep('upload'); setFile(null); setSheets([]); setEditing(null);
    setMode('ADD'); setMslMode('FILL'); setConfirmWipe(false); setErr(''); setDry(null); setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const buildSheets = (wb: ReturnType<typeof readWorkbook>, forKind: ImportKind): SheetUi[] => {
    const hiddenSet = hiddenSheets(wb);
    return wb.SheetNames.map((name) => {
      const { headers, rows } = readWorksheet(wb, name);
      const fromHeaders = detectTypeFromHeaders(headers);
      const type = fromHeaders ?? detectProductType(name) ?? 'V_BELT';
      const mapping = autoMap(headers, fieldsFor(forKind, type));
      const ready = fieldsFor(forKind, type).filter((f) => f.required).every((f) => mapping[f.key]);
      const hidden = hiddenSet.has(name);
      return { name, rows: rows.length, headers, type, typeGuessed: !fromHeaders, mapping, include: rows.length > 0 && ready && !hidden, hidden };
    });
  };

  const handleFile = async (f: File) => {
    setErr('');
    try {
      const wb = readWorkbook(await f.arrayBuffer());
      setFile(f);
      setSheets(buildSheets(wb, kind));
      setEditing(null);
      setDry(null);
      setStep('sheets');
    } catch {
      setErr('Could not read that file. Upload an .xlsx, .xls or .csv.');
    }
  };

  const patchSheet = (name: string, patch: Partial<SheetUi>) =>
    setSheets((all) => all.map((s) => (s.name === name ? { ...s, ...patch } : s)));

  const changeType = (s: SheetUi, type: ProductType) =>
    patchSheet(s.name, { type, typeGuessed: false, mapping: autoMap(s.headers, fieldsFor(kind, type)) });

  const post = async (dryRun: boolean) => {
    if (!file) return null;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('sheets', JSON.stringify(chosen.map((s) => ({ name: s.name, type: s.type, mapping: s.mapping }))));
    fd.append('mode', mode);
    fd.append('mslMode', mslMode);
    fd.append('dryRun', String(dryRun));
    const r = await fetch(ENDPOINT[kind], { method: 'POST', body: fd });
    const text = await r.text();
    let j: Record<string, unknown>;
    try { j = JSON.parse(text); } catch {
      j = { error: `The server returned an empty or unreadable response (HTTP ${r.status}). ` +
        'Check that the latest SQL (up to 031) has been run in Supabase, and look at the dev-server terminal for the exact error.' };
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

  const wipes = kind !== 'MSL' && mode === 'OVERWRITE';
  const sm = (dry?.summary ?? {}) as Record<string, unknown>;
  const actionable = kind === 'SKU'
    ? Number(sm.newSkus ?? 0)
    : kind === 'MSL'
      ? Number(sm.update ?? 0)
      : Number(sm.matched ?? 0) + Number(sm.newSkus ?? 0);
  const canImport = !!dry && !dry.blocked && (!wipes || confirmWipe) && !busy && actionable > 0;
  const usesLots = types.some((t) => TYPE_META[t].usesLots);
  const typeLabel = types.length ? types.map((t) => TYPE_META[t].label.toLowerCase()).join(' + ') : 'selected';

  const issuesOf = (k: Issue['kind']) => (dry?.issues ?? []).filter((i) => i.kind === k);

  return (
    <div className="flex flex-col h-[calc(100vh/var(--z,1)-56px)]">
      <div className="px-4 lg:px-6 py-3.5 border-b border-line bg-surface flex items-center gap-3">
        <h1 className="text-[19px] font-semibold">Import Data</h1>
        {step !== 'upload' && (
          <button onClick={() => reset()} className="ml-auto btn text-[15px]">Start Over</button>
        )}
      </div>

      <div className="px-4 lg:px-6 border-b border-line flex gap-5 bg-surface">
        {([['SKU', '1 · Products'], ['INVENTORY', '2 · Inventory'], ['MSL', '3 · MSL']] as [ImportKind, string][]).map(([k, label]) => (
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
              {kind === 'MSL'
                ? 'Sets only the MSL (minimum stock level) of products that are already in Product Master. Your sheet stays as it is — it just needs the product columns and an MSL column.'
                : kind === 'SKU'
                ? 'Builds the product master: Product Family → Section → Size → Make (Colour / L / W / T for conveyor), plus the MSL alert level. SKU numbers are generated automatically.'
                : 'Loads current stock from your register and attaches it to products. Rows are matched to products by Family + Section + Size + Make — not by SKU code.'}
            </p>
            <p className="text-[14px] text-ink-3 mb-6">
              {kind === 'MSL'
                ? 'Never creates products and never touches stock. Timing belts: MSL counts pieces.'
                : kind === 'SKU'
                ? 'Upload the whole workbook — every sheet is listed next, so all of them can be imported in one go.'
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

            {kind === 'SKU' && <WipePanel />}
          </div>
        )}

        {/* ── Sheets + mapping ── */}
        {step === 'sheets' && (
          <div className="max-w-4xl">
            <p className="text-[15px] text-ink-2 mb-1">
              <strong>{file?.name}</strong> — {sheets.length} sheet{sheets.length === 1 ? '' : 's'}.
              Tick the ones to import; they are all imported together.
            </p>
            <p className="text-[14px] text-ink-3 mb-4">
              The product type is read from each sheet&apos;s column headings. Change it if it is wrong.
            </p>

            <div className="flex gap-3 text-[14px] mb-2">
              <button className="text-brand font-medium"
                onClick={() => setSheets((all) => all.map((s) => ({ ...s, include: s.rows > 0 && !s.hidden && requiredMet(s, kind) })))}>
                Tick all ready
              </button>
              <button className="text-ink-3" onClick={() => setSheets((all) => all.map((s) => ({ ...s, include: false })))}>
                Untick all
              </button>
            </div>

            <div className="border border-line rounded-lg overflow-hidden">
              <table className="w-full text-[15px]">
                <thead>
                  <tr className="bg-surface-2 text-left text-ink-2 text-[14px]">
                    <th className="w-10 px-3 py-2" />
                    <th className="px-3 py-2 font-medium">Sheet</th>
                    <th className="px-3 py-2 font-medium text-right">Rows</th>
                    <th className="px-3 py-2 font-medium">Product type</th>
                    <th className="px-3 py-2 font-medium">Columns</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {sheets.map((s) => {
                    const fields = fieldsFor(kind, s.type);
                    const lacking = fields.filter((f) => f.required && !s.mapping[f.key]);
                    const ok = lacking.length === 0;
                    return (
                      <SheetRowGroup key={s.name}>
                        <tr className={`border-t border-line ${s.include ? '' : 'text-ink-3'}`}>
                          <td className="px-3 py-2">
                            <input type="checkbox" checked={s.include} disabled={s.rows === 0}
                              onChange={(e) => patchSheet(s.name, { include: e.target.checked })} />
                          </td>
                          <td className="px-3 py-2 font-medium">
                            {s.name}
                            {s.hidden && <span className="badge ml-2" title="This tab is hidden in Excel (right-click a tab → Unhide to see it)">hidden</span>}
                          </td>
                          <td className="px-3 py-2 text-right num">{s.rows || <span className="text-ink-3">empty</span>}</td>
                          <td className="px-3 py-2">
                            <select className={`field h-9 py-0 ${s.typeGuessed && s.rows > 0 ? 'border-warn' : ''}`} value={s.type}
                              onChange={(e) => changeType(s, e.target.value as ProductType)}>
                              {PRODUCT_TYPES.map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
                            </select>
                            {s.typeGuessed && s.rows > 0 && <span className="block text-[12px] text-warn">check this</span>}
                          </td>
                          <td className="px-3 py-2">
                            {s.rows === 0 ? <span className="text-ink-3">—</span> : ok
                              ? <span className="inline-flex items-center gap-1 text-ok"><CheckCircle size={14} /> matched</span>
                              : <span className="inline-flex items-center gap-1 text-danger"><AlertCircle size={14} /> choose {lacking.map((f) => f.label).join(', ')}</span>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {s.rows > 0 && (
                              <button className="text-[14px] text-brand font-medium"
                                onClick={() => setEditing(editing === s.name ? null : s.name)}>
                                {editing === s.name ? 'Close' : 'Edit columns'}
                              </button>
                            )}
                          </td>
                        </tr>
                        {editing === s.name && (
                          <tr className="border-t border-line bg-subtle">
                            <td />
                            <td colSpan={5} className="px-3 py-3">
                              <MappingTable fields={fields} headers={s.headers} mapping={s.mapping}
                                onChange={(mapping) => patchSheet(s.name, { mapping })} />
                            </td>
                          </tr>
                        )}
                      </SheetRowGroup>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {chosen.length > 0 && (
              <div className="mt-5">
                {kind === 'MSL'
                  ? <MslPicker value={mslMode} onChange={setMslMode} />
                  : <ModePicker kind={kind} typeLabel={typeLabel} usesLots={usesLots} mode={mode} setMode={setMode} />}
              </div>
            )}

            {err && <ErrorBox text={err} />}
            <div className="mt-6 flex items-center gap-3">
              <button onClick={runPreview} disabled={!allReady || busy} className="btn btn-primary flex items-center gap-1.5">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
                Preview {chosen.length > 0 ? `${chosen.length} sheet${chosen.length === 1 ? '' : 's'}` : ''}
              </button>
              {chosen.length === 0 && <p className="text-[14px] text-ink-3">Tick at least one sheet.</p>}
              {chosen.length > 0 && !allReady && <p className="text-[14px] text-danger">A ticked sheet still needs a column chosen — use Edit columns.</p>}
            </div>
          </div>
        )}

        {/* ── Preview ── */}
        {step === 'preview' && dry && (
          <div>
            <button onClick={() => setStep('sheets')} className="btn text-[14px] flex items-center gap-1.5 mb-4">
              <ArrowLeft size={13} /> Back to sheets
            </button>

            <SummaryCards kind={kind} summary={dry.summary} />

            {dry.blocked && (
              <div className="mb-4 flex items-start gap-2 text-[15px] text-danger bg-danger-soft border border-danger-line rounded-lg p-3">
                <AlertCircle size={15} className="mt-0.5 shrink-0" /> {dry.blocked}
              </div>
            )}

            {dry.perSheet.length > 1 && (
              <div className="mb-5 overflow-auto border border-line rounded-lg">
                <table className="w-full text-[14px]">
                  <thead>
                    <tr className="bg-surface-2 text-left text-ink-2">
                      <th className="px-3 py-2 font-medium">Sheet</th>
                      <th className="px-3 py-2 font-medium">Type</th>
                      <th className="px-3 py-2 font-medium text-right">Rows</th>
                      <th className="px-3 py-2 font-medium text-right">{kind === 'MSL' ? 'MSL to set' : kind === 'SKU' ? 'New' : 'New / matched'}</th>
                      <th className="px-3 py-2 font-medium text-right">{kind === 'MSL' ? 'Not found' : 'Need fixing'}</th>
                      <th className="px-3 py-2 font-medium text-right">{kind === 'MSL' ? 'No MSL' : 'Skipped'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dry.perSheet.map((p) => (
                      <tr key={p.name} className="border-t border-line">
                        <td className="px-3 py-1.5 font-medium">{p.name}</td>
                        <td className="px-3 py-1.5 text-ink-3">{TYPE_META[p.type].short}</td>
                        <td className="px-3 py-1.5 text-right num">{p.rows}</td>
                        <td className="px-3 py-1.5 text-right num">
                          {kind === 'MSL' ? String(p.update) : kind === 'SKU' ? String(p.newSkus) : `${p.newSkus} / ${p.matched}`}
                        </td>
                        <td className={`px-3 py-1.5 text-right num ${Number(kind === 'MSL' ? p.notFound : p.incomplete) ? 'text-warn font-medium' : 'text-ink-3'}`}>{String(kind === 'MSL' ? p.notFound : p.incomplete)}</td>
                        <td className={`px-3 py-1.5 text-right num ${Number(kind === 'MSL' ? p.noMsl : p.skipped) ? 'text-danger font-medium' : 'text-ink-3'}`}>{String(kind === 'MSL' ? p.noMsl : p.skipped)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Rows to fix */}
            {(issuesOf('MISSING').length > 0 || issuesOf('SKIPPED').length > 0) && (
              <div className="mb-5 border border-warn-line bg-warn-soft rounded-lg p-3">
                <p className="text-[15px] font-medium text-warn mb-1">
                  {kind === 'MSL' ? 'Rows not applied' : 'Rows to fix'} — {issuesOf('MISSING').length + issuesOf('SKIPPED').length} row(s)
                </p>
                <p className="text-[14px] text-ink-2 mb-2">
                  {kind === 'MSL'
                    ? 'These rows will not change any MSL. Fix the sheet (or import the product first) and run the MSL import again.'
                    : <>They will still be imported (product saved as UNSPECIFIED and flagged <em>Needs attention</em> in Product Master)
                      {kind === 'INVENTORY' ? ', except stock that cannot be read, which is left out' : ''}.
                      Fix the sheet and re-upload if you would rather they are complete first.</>}
                </p>
                <ul className="text-[14px] text-ink-2 space-y-0.5 max-h-56 overflow-auto">
                  {[...issuesOf('MISSING'), ...issuesOf('SKIPPED')].map((i, n) => (
                    <li key={n}><span className="text-ink-3">{i.sheet} · row {i.row}</span> — {i.text}</li>
                  ))}
                </ul>
              </div>
            )}
            {issuesOf('FILLED').length > 0 && (
              <details className="mb-5 border border-line rounded-lg p-3 bg-subtle">
                <summary className="text-[14px] cursor-pointer text-ink-2">
                  {issuesOf('FILLED').length} row(s) had a blank cell copied from the row above (merged / “same as above” cells)
                </summary>
                <ul className="text-[14px] text-ink-3 mt-2 space-y-0.5 max-h-40 overflow-auto">
                  {issuesOf('FILLED').map((i, n) => <li key={n}>{i.sheet} · row {i.row} — {i.text}</li>)}
                </ul>
              </details>
            )}
            {dry.issueCount > dry.issues.length && (
              <p className="text-[13px] text-ink-3 mb-4">Showing the first {dry.issues.length} of {dry.issueCount} notes.</p>
            )}

            <p className="text-[14px] text-ink-3 mb-2">
              First {dry.preview.length} rows exactly as they will be saved:
            </p>
            {kind === 'MSL' ? (
              <div className="overflow-auto border border-line rounded-lg">
                <table className="w-full text-[14px]">
                  <thead>
                    <tr className="bg-surface-2 text-left text-ink-2">
                      {dry.perSheet.length > 1 && <th className="px-3 py-2 font-medium">Sheet</th>}
                      <th className="px-3 py-2 font-medium">Row</th>
                      <th className="px-3 py-2 font-medium">Result</th>
                      <th className="px-3 py-2 font-medium">SKU</th>
                      <th className="px-3 py-2 font-medium">Family</th>
                      <th className="px-3 py-2 font-medium">Section</th>
                      <th className="px-3 py-2 font-medium">Size</th>
                      <th className="px-3 py-2 font-medium">Make</th>
                      <th className="px-3 py-2 font-medium">MSL now</th>
                      <th className="px-3 py-2 font-medium">MSL in sheet</th>
                      <th className="px-3 py-2 font-medium">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dry.preview.map((r, i) => (
                      <tr key={i} className="border-t border-line align-top">
                        {dry.perSheet.length > 1 && <td className="px-3 py-1.5 text-ink-3">{r.sheet}</td>}
                        <td className="px-3 py-1.5 text-ink-3">{r.rowNum}</td>
                        <td className="px-3 py-1.5"><StatusBadge status={String(r.status)} /></td>
                        <td className="px-3 py-1.5 font-mono whitespace-nowrap">{r.skuCode}</td>
                        <td className="px-3 py-1.5">{r.family}</td>
                        <td className="px-3 py-1.5">{r.sectionOrColour}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap">{r.size}</td>
                        <td className="px-3 py-1.5">{r.brand}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap text-ink-3">{r.was}</td>
                        <td className="px-3 py-1.5 whitespace-nowrap font-medium">{r.msl}</td>
                        <td className="px-3 py-1.5 text-ink-3">{r.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
            <div className="overflow-auto border border-line rounded-lg">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="bg-surface-2 text-left text-ink-2">
                    {dry.perSheet.length > 1 && <th className="px-3 py-2 font-medium">Sheet</th>}
                    <th className="px-3 py-2 font-medium">Row</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                    <th className="px-3 py-2 font-medium">SKU</th>
                    <th className="px-3 py-2 font-medium">Family</th>
                    <th className="px-3 py-2 font-medium">Section</th>
                    <th className="px-3 py-2 font-medium">Size</th>
                    <th className="px-3 py-2 font-medium">Make</th>
                    {kind === 'INVENTORY' && usesLots && <th className="px-3 py-2 font-medium">Cut / Full</th>}
                    {kind === 'INVENTORY' && <th className="px-3 py-2 font-medium">Stock loaded</th>}
                    <th className="px-3 py-2 font-medium">MSL</th>
                    <th className="px-3 py-2 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {dry.preview.map((r, i) => (
                    <tr key={i} className="border-t border-line align-top">
                      {dry.perSheet.length > 1 && <td className="px-3 py-1.5 text-ink-3">{r.sheet}</td>}
                      <td className="px-3 py-1.5 text-ink-3">{r.rowNum}</td>
                      <td className="px-3 py-1.5"><StatusBadge status={String(r.status)} /></td>
                      <td className="px-3 py-1.5 font-mono whitespace-nowrap">{r.skuCode}</td>
                      <td className="px-3 py-1.5"><Cell v={r.family} /></td>
                      <td className="px-3 py-1.5"><Cell v={r.sectionOrColour} /></td>
                      <td className="px-3 py-1.5 whitespace-nowrap"><Cell v={r.size} /></td>
                      <td className="px-3 py-1.5"><Cell v={r.brand} /></td>
                      {kind === 'INVENTORY' && usesLots && <td className="px-3 py-1.5 whitespace-nowrap">{r.lot}</td>}
                      {kind === 'INVENTORY' && <td className="px-3 py-1.5 whitespace-nowrap">{r.load}</td>}
                      <td className="px-3 py-1.5 whitespace-nowrap">{r.msl}</td>
                      <td className="px-3 py-1.5 text-ink-3">{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}

            {wipes && !dry.blocked && (
              <label className="mt-5 flex items-start gap-2 text-[15px] bg-warn-soft border border-warn-line rounded-lg p-3 cursor-pointer">
                <input type="checkbox" className="mt-0.5" checked={confirmWipe} onChange={(e) => setConfirmWipe(e.target.checked)} />
                <span>
                  <AlertTriangle size={13} className="inline -mt-0.5 mr-1 text-warn" />
                  Overwrite will <strong>wipe the existing {typeLabel} {kind === 'SKU' ? 'products' : 'stock and lots'}</strong> before
                  importing. I understand.
                </span>
              </label>
            )}

            {err && <ErrorBox text={err} />}
            <div className="mt-6 flex items-center gap-3">
              <button onClick={runImport} disabled={!canImport} className="btn btn-primary">
                {busy ? 'Importing…' : 'Looks good — Import'}
              </button>
              <button onClick={() => setStep('sheets')} className="btn" disabled={busy}>Back</button>
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
                  {kind === 'MSL'
                    ? `${result.updated} product(s) got an MSL · ${result.kept} kept as they were · ${result.notFound} not found in Product Master · ${result.noMsl} rows without a usable MSL`
                    : kind === 'SKU'
                    ? `${result.created} products created · ${result.existing} already existed · ${result.duplicates} duplicate rows in sheet`
                    : `${result.skusUpdated} products updated · ${result.lotsCreated} lots created · ${(result.newSkus as string[]).length} new products auto-created`}
                </p>
                {Number(result.incomplete) > 0 && (
                  <p className="text-[15px] text-warn mt-0.5">
                    {String(result.incomplete)} product(s) have a missing field — open Product Master and use <strong>Needs attention</strong>.
                  </p>
                )}
              </div>
            </div>

            {kind === 'INVENTORY' && ((result.newSkus as string[] | undefined) ?? []).length > 0 && (
              <div className="mb-4 border border-line rounded-lg p-3 bg-subtle">
                <p className="text-[14px] font-medium mb-1">Created from this import (not in Product Master before):</p>
                <p className="text-[14px] font-mono text-ink-2 break-words max-h-32 overflow-auto">{(result.newSkus as string[]).join(', ')}</p>
              </div>
            )}

            {(result.errors as string[]).length > 0 && (
              <div className="border border-warn-line bg-warn-soft rounded-lg p-4 mb-4">
                <p className="text-[15px] font-medium text-warn mb-2">{(result.errors as string[]).length} note(s):</p>
                <ul className="text-[14px] text-warn space-y-1 max-h-48 overflow-auto">
                  {(result.errors as string[]).map((e, i) => <li key={i}>• {e}</li>)}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button onClick={() => reset()} className="btn">Import another file</button>
              {kind === 'SKU' && <button onClick={() => reset('INVENTORY')} className="btn btn-primary">Next: import inventory →</button>}
              {kind !== 'MSL' && <button onClick={() => reset('MSL')} className="btn">Next: import MSL →</button>}
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

/** A fragment that is allowed inside <tbody>. */
function SheetRowGroup({ children }: { children: React.ReactNode }) { return <>{children}</>; }

/** A cell that shows UNSPECIFIED (a blank in the sheet) in amber so it cannot be missed. */
function Cell({ v }: { v: string | number }) {
  return v === 'UNSPECIFIED' ? <span className="text-warn font-medium">UNSPECIFIED</span> : <>{v}</>;
}

function MappingTable({ fields, headers, mapping, onChange }: {
  fields: FieldDef[]; headers: string[]; mapping: Record<string, string>;
  onChange: (m: Record<string, string>) => void;
}) {
  return (
    <table className="w-full text-[14px]">
      <tbody>
        {fields.map((f) => {
          const ok = !!mapping[f.key];
          return (
            <tr key={f.key}>
              <td className="py-1 pr-3 w-[38%]">
                <span className="font-medium">{f.label}</span>
                {f.required && <span className="text-danger ml-0.5">*</span>}
                {f.hint && <span className="block text-[12px] text-ink-3">{f.hint}</span>}
              </td>
              <td className="py-1">
                <select className={`field w-full h-9 py-0 ${f.required && !ok ? 'border-danger' : ''}`}
                  value={mapping[f.key] ?? ''}
                  onChange={(e) => onChange({ ...mapping, [f.key]: e.target.value })}>
                  <option value="">{f.required ? '— choose a column —' : '— not in my sheet —'}</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </td>
              <td className="pl-2 w-6">
                {ok ? <CheckCircle size={14} className="text-ok" />
                  : f.required ? <AlertCircle size={14} className="text-danger" /> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ModePicker({ kind, typeLabel, usesLots, mode, setMode }: {
  kind: ImportKind; typeLabel: string; usesLots: boolean; mode: Mode; setMode: (m: Mode) => void;
}) {
  const opts: [Mode, string, string][] = kind === 'SKU'
    ? [
      ['OVERWRITE', 'Overwrite', `Wipe the existing ${typeLabel} products, then import these sheets fresh.`],
      ['ADD', 'Add new only', 'Keep every product already in the system; create only the ones that are not there yet.'],
    ]
    : [
      ['OVERWRITE', 'Overwrite', `Wipe the current ${typeLabel} stock${usesLots ? ' and lots' : ''}, then load these sheets.`],
      ['ADD', 'Add to current stock', usesLots
        ? 'Keep current stock; every timing-belt row adds NEW lots on top.'
        : 'Keep current stock; add these sheets’ pieces on top.'],
    ];
  return (
    <div>
      <label className="label">If data already exists in the system</label>
      <p className="text-[13px] text-ink-3 mb-1">
        Loading several files of the same type? Use <strong>Overwrite</strong> for the first one only, then <strong>Add</strong> for the rest —
        Overwrite wipes everything of that type that is already there.
      </p>
      <div className="flex flex-wrap gap-5 mt-1">
        {opts.map(([m, title, desc]) => (
          <label key={m} className="flex items-start gap-1.5 text-[14px] cursor-pointer max-w-[320px]">
            <input type="radio" className="mt-0.5" checked={mode === m} onChange={() => setMode(m)} />
            <span><strong>{title}</strong><span className="block text-ink-3">{desc}</span></span>
          </label>
        ))}
      </div>
    </div>
  );
}

function MslPicker({ value, onChange }: { value: 'FILL' | 'OVERWRITE'; onChange: (v: 'FILL' | 'OVERWRITE') => void }) {
  const opts: ['FILL' | 'OVERWRITE', string, string][] = [
    ['FILL', 'Only fill products with no MSL', 'Products that already have an MSL are left exactly as they are.'],
    ['OVERWRITE', 'Overwrite existing MSL too', 'The MSL in the sheet replaces whatever is set now.'],
  ];
  return (
    <div>
      <label className="label">If a product already has an MSL</label>
      <div className="flex flex-wrap gap-5 mt-1">
        {opts.map(([v, title, desc]) => (
          <label key={v} className="flex items-start gap-1.5 text-[14px] cursor-pointer max-w-[320px]">
            <input type="radio" className="mt-0.5" checked={value === v} onChange={() => onChange(v)} />
            <span><strong>{title}</strong><span className="block text-ink-3">{desc}</span></span>
          </label>
        ))}
      </div>
    </div>
  );
}

function SummaryCards({ kind, summary }: { kind: ImportKind; summary: DryRun['summary'] }) {
  const s = summary as Record<string, unknown>;
  const cards: [string, unknown, boolean?][] = kind === 'MSL'
    ? [['MSL will be set', s.update], ['Kept as they were', Number(s.keep ?? 0) + Number(s.same ?? 0)],
       ['Not in Product Master', s.notFound, Number(s.notFound) > 0], ['No usable MSL', s.noMsl, Number(s.noMsl) > 0]]
    : kind === 'SKU'
    ? [['New products', s.newSkus], ['Already exist', s.existing], ['Duplicate rows', s.duplicates],
       ['Need fixing', s.incomplete, Number(s.incomplete) > 0]]
    : [['Matched products', s.matched], ['New products to create', s.newSkus],
       [s.lotsToCreate ? 'Lots to create' : 'Total pieces', s.lotsToCreate || s.totalLoad],
       ['Need fixing', Number(s.incomplete ?? 0) + Number(s.skipped ?? 0), Number(s.incomplete ?? 0) + Number(s.skipped ?? 0) > 0]];
  const brands = (s.newBrands as string[] | undefined) ?? [];
  const families = (s.newFamilies as string[] | undefined) ?? [];
  return (
    <div className="mb-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        {cards.map(([label, v, warn]) => (
          <div key={label} className="border border-line rounded-lg px-3 py-2.5 bg-surface">
            <p className="text-[13px] text-ink-3">{label}</p>
            <p className={`text-[22px] font-semibold num ${warn ? 'text-warn' : ''}`}>{String(v ?? 0)}</p>
          </div>
        ))}
      </div>
      <p className="text-[14px] text-ink-3">
        {Number(s.withMsl) > 0 && <>{String(s.withMsl)} product(s) carry an MSL. </>}
        {kind === 'SKU' && families.length > 0 && <>New product families: <strong className="text-ink-2">{families.join(', ')}</strong>. </>}
        {kind === 'SKU' && brands.length > 0 && <>New makes: <strong className="text-ink-2">{brands.join(', ')}</strong>.</>}
        {kind === 'INVENTORY' && Number(s.newSkus) > 0 && <>{String(s.newSkus)} product(s) are not in Product Master — they will be created automatically. </>}
        {kind === 'INVENTORY' && Number(s.noStock) > 0 && <>{String(s.noStock)} row(s) have no stock (0 / blank) — the product is kept with 0 stock.</>}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    NEW: ['New', 'badge-ok'], MATCH: ['Matched', 'badge-ok'], NEW_SKU: ['New SKU', 'badge-ok'],
    FIX: ['Needs fix', 'badge-warn'],
    UPDATE: ['Will set', 'badge-ok'], SAME: ['Same', 'badge'], KEEP: ['Kept', 'badge'],
    NOT_FOUND: ['Not found', 'badge-danger'], NO_MSL: ['No MSL', 'badge-warn'],
    EXISTS: ['Exists', 'badge'], DUPLICATE: ['Duplicate', 'badge'], ERROR: ['Skipped', 'badge-danger'],
  };
  const [label, cls] = map[status] ?? [status, 'badge'];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div className="mt-4 flex items-start gap-2 text-[15px] text-danger bg-danger-soft rounded-lg p-3">
      <AlertCircle size={14} className="mt-0.5 shrink-0" /> {text}
    </div>
  );
}

/** Start fresh: wipe every product (all types) before a new import. */
function WipePanel() {
  const [open, setOpen] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const wipe = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/admin/wipe-products', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: word }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setMsg({ ok: false, text: String(j.error ?? 'Could not wipe the products.') }); return; }
      const total = Object.values(j.wiped as Record<string, number>).reduce((a, b) => a + b, 0);
      setMsg({ ok: true, text: `${total} products wiped. You can import fresh data now.` });
      setWord(''); setOpen(false);
    } catch (e) { setMsg({ ok: false, text: String(e) }); } finally { setBusy(false); }
  };

  return (
    <div className="mt-8 border-t border-line pt-4">
      {!open ? (
        <button className="text-[14px] text-ink-3 hover:text-danger inline-flex items-center gap-1.5" onClick={() => setOpen(true)}>
          <Trash2 size={13} /> Start fresh — wipe all products…
        </button>
      ) : (
        <div className="border border-danger-line bg-danger-soft rounded-lg p-3 max-w-xl">
          <p className="text-[15px] font-medium text-danger mb-1">Wipe every product, stock and lot</p>
          <p className="text-[14px] text-ink-2 mb-2">
            Removes all timing-belt, V-belt and conveyor products so you can import fresh. Not possible once movements or
            orders exist for them.
          </p>
          <div className="flex items-center gap-2">
            <input className="field h-9 w-40" placeholder="type WIPE" value={word} onChange={(e) => setWord(e.target.value)} />
            <button className="btn btn-danger" disabled={word !== 'WIPE' || busy} onClick={wipe}>
              {busy ? 'Wiping…' : 'Wipe all products'}
            </button>
            <button className="btn" onClick={() => { setOpen(false); setWord(''); }} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <p className={`mt-2 text-[14px] ${msg.ok ? 'text-ok' : 'text-danger'}`}>{msg.text}</p>}
    </div>
  );
}
