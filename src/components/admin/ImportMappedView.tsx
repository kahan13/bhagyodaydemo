'use client';

/**
 * Import screen — fixed for the real KAHAN workbook (3 sheets: Timing Belt,
 * V-Belt, Conveyor Belt). Changes from the previous version:
 *
 *   1. Added CONVEYOR_BELT as a third product type.
 *   2. Lot fields (lot_status, lot_qty, roll_length_mm) are now scoped with
 *      types: ['TIMING_BELT'] — they no longer leak into V-Belt or Conveyor
 *      Belt selections. Only Timing Belt rolls have a cut-pcs/full-sleeve
 *      concept in the real sheets.
 *   3. Added Conveyor-Belt-specific fields: `colour` (maps to the sheet's
 *      COLOUR column) and reused the existing `family` field for the sheet's
 *      PRODUCT FAMILY column (same grouping concept as Timing Belt's family).
 *      `exact_size` (already a core field) is the natural target for the
 *      sheet's SHORT DESCRIPTION formula column (e.g. "200 X 500 X 1.5").
 *   4. Fixed the double-arrow dropdown bug: every `className="input"` (an
 *      undefined CSS class with zero styling, so the browser's native arrow
 *      showed through) is now `className="field"` (the actually-styled class
 *      — appearance:none + a single custom chevron). The per-row "Your
 *      Column" select additionally had a manual <ChevronDown> icon stacked on
 *      top of that unstyled select, which is what produced two visible
 *      arrows there specifically — that manual icon and its wrapping
 *      `relative` div are removed since `.field` already draws its own
 *      chevron.
 */

import { useRef, useState } from 'react';
import { Upload, CheckCircle, AlertCircle, Plus, Trash2, Eye, ArrowLeft } from 'lucide-react';
import * as XLSX from 'xlsx';

type ProductType = 'TIMING_BELT' | 'V_BELT' | 'CONVEYOR_BELT';
type ImportMode = 'OVERWRITE' | 'APPEND';

const PREVIEW_ROW_COUNT = 8;

const normaliseLotStatusPreview = (raw: unknown): string => {
  const s = String(raw ?? '').toUpperCase().replace(/[\s_]+/g, '');
  if (!s) return '—';
  return s.startsWith('CUT') ? 'Cut Pcs' : 'Full Sleeve';
};

interface SystemField {
  key: string;
  label: string;
  required?: boolean;
  types?: ProductType[];
  isLotField?: boolean;  // fields that create opening lots, not SKU master fields
}

// Core SKU master fields – always shown
const CORE_FIELDS: SystemField[] = [
  { key: 'sku_code',           label: 'SKU / Part Number',        required: true },
  { key: 'exact_size',         label: 'Size / Designation',       required: true },
  { key: 'brand',              label: 'Brand',                    required: true },
  { key: 'family',             label: 'Family',    required: true, types: ['TIMING_BELT', 'CONVEYOR_BELT'] },
  { key: 'profile',            label: 'Profile',   required: true, types: ['V_BELT'] },
  // Lot fields: map these to create opening lots from the sheet.
  // Timing Belt only — Timing Belt is the only sheet with a CUT PCS / FULL
  // SLEEVE column in the real data.
  { key: 'lot_status',         label: 'Lot Status (CUT PCS / FULL SLEEVE)',  isLotField: true, types: ['TIMING_BELT'] },
  { key: 'lot_qty',            label: 'Lot Quantity (mm)',                   isLotField: true, types: ['TIMING_BELT'] },
];

// Optional SKU master fields – shown in the "add field" panel
const OPTIONAL_FIELDS: SystemField[] = [
  { key: 'opening_stock',      label: 'Opening Stock' },
  { key: 'unit',               label: 'Unit (PCS / MTR / ROLL)' },
  { key: 'min_stock_level',    label: 'Minimum Stock Level' },
  { key: 'supplier_moq',       label: 'Supplier MOQ' },
  { key: 'reorder_quantity',   label: 'Reorder Quantity' },
  { key: 'rack_location',      label: 'Rack Location' },
  { key: 'display_name',       label: 'Display Name' },
  { key: 'is_active',          label: 'Active? (Yes / No / 1 / 0)' },
  { key: 'roll_length_mm',     label: 'Roll Length (mm) — 1 full sleeve', types: ['TIMING_BELT'] },
  { key: 'belt_form',          label: 'Belt Form',          types: ['TIMING_BELT'] },
  { key: 'pitch_mm',           label: 'Pitch (mm)',         types: ['TIMING_BELT'] },
  { key: 'pitch_length_mm',    label: 'Pitch Length (mm)',  types: ['TIMING_BELT'] },
  { key: 'width_mm',           label: 'Width (mm)',         types: ['TIMING_BELT'] },
  { key: 'teeth',              label: 'Teeth',              types: ['TIMING_BELT'] },
  { key: 'standard',           label: 'Standard',           types: ['TIMING_BELT'] },
  { key: 'construction',       label: 'Construction',       types: ['V_BELT'] },
  { key: 'nominal_length',     label: 'Nominal Length',     types: ['V_BELT'] },
  { key: 'length_designation', label: 'Length Designation', types: ['V_BELT'] },
  { key: 'colour',             label: 'Colour',             types: ['CONVEYOR_BELT'] },
];

const ALL_SYSTEM_KEYS = [...CORE_FIELDS, ...OPTIONAL_FIELDS].map((f) => f.key);

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export default function ImportMappedView() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<'upload' | 'map' | 'preview' | 'done'>('upload');
  const [productType, setProductType] = useState<ProductType>('TIMING_BELT');
  const [importMode, setImportMode] = useState<ImportMode>('OVERWRITE');
  const [sheets, setSheets] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [rawFile, setRawFile] = useState<File | null>(null);

  // mapping: systemField.key → fileColumn name
  const [mapping, setMapping] = useState<Record<string, string>>({});
  // labels: systemField.key → display label override
  const [labels, setLabels] = useState<Record<string, string>>({});
  // which optional fields the user has added to the table
  const [activeOptional, setActiveOptional] = useState<string[]>([]);
  // add-field panel open
  const [addPanelOpen, setAddPanelOpen] = useState(false);

  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ inserted: number; updated: number; lots: number; errors: string[] } | null>(null);
  const [err, setErr] = useState('');

  // All fields shown in the mapping table
  const visibleCoreFields = CORE_FIELDS.filter(
    (f) => !f.types || f.types.includes(productType)
  );
  const visibleOptionalFields = OPTIONAL_FIELDS.filter(
    (f) => activeOptional.includes(f.key) && (!f.types || f.types.includes(productType))
  );
  const visibleFields = [...visibleCoreFields, ...visibleOptionalFields];

  // Optional fields not yet added (filtered by product type)
  const availableToAdd = OPTIONAL_FIELDS.filter(
    (f) =>
      !activeOptional.includes(f.key) &&
      (!f.types || f.types.includes(productType))
  );

  const handleFile = async (file: File) => {
    setErr('');
    setRawFile(file);
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    setSheets(wb.SheetNames);
    const sheetName = wb.SheetNames[0];
    setSelectedSheet(sheetName);
    loadHeaders(wb, sheetName);
    setStep('map');
  };

  const loadHeaders = (wb: XLSX.WorkBook, sheetName: string) => {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, range: 0 });
    const headers = (rows[0] as string[]).map(String).filter(Boolean);
    setFileHeaders(headers);
    setMapping({});
    setLabels({});
    setActiveOptional([]);

    // Keep a small slice of real row objects (column-name keyed) for the
    // preview step, so the preview shows your actual data, not placeholders.
    const dataRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
    setPreviewRows(dataRows.slice(0, PREVIEW_ROW_COUNT));

    // Auto-map by name similarity
    const autoMap: Record<string, string> = {};
    for (const sf of [...CORE_FIELDS, ...OPTIONAL_FIELDS]) {
      const match = headers.find(
        (h) =>
          slugify(h) === sf.key ||
          slugify(h).includes(sf.key.replace(/_/g, '')) ||
          sf.key.includes(slugify(h))
      );
      if (match) {
        autoMap[sf.key] = match;
        // Auto-activate optional fields that were auto-matched
        if (OPTIONAL_FIELDS.find((o) => o.key === sf.key)) {
          setActiveOptional((prev) => prev.includes(sf.key) ? prev : [...prev, sf.key]);
        }
      }
    }
    setMapping(autoMap);
  };

  const onSheetChange = async (sheetName: string) => {
    setSelectedSheet(sheetName);
    if (!rawFile) return;
    const buf = await rawFile.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    loadHeaders(wb, sheetName);
  };

  const setMap = (sfKey: string, colName: string) => {
    setMapping((m) => ({ ...m, [sfKey]: colName }));
    if (colName && !labels[sfKey]) {
      setLabels((l) => ({ ...l, [sfKey]: colName }));
    }
    if (!colName) {
      setLabels((l) => { const n = { ...l }; delete n[sfKey]; return n; });
    }
  };

  const addOptionalField = (key: string) => {
    setActiveOptional((prev) => [...prev, key]);
    setAddPanelOpen(false);
  };

  const removeOptionalField = (key: string) => {
    setActiveOptional((prev) => prev.filter((k) => k !== key));
    setMapping((m) => { const n = { ...m }; delete n[key]; return n; });
    setLabels((l) => { const n = { ...l }; delete n[key]; return n; });
  };

  const requiredMet = visibleCoreFields
    .filter((f) => f.required)
    .every((f) => mapping[f.key]);

  // Lot columns are only meaningful for Timing Belt — CORE_FIELDS already
  // hides lot_status/lot_qty for other product types, so this can only be
  // true when productType === 'TIMING_BELT'.
  const hasLotColumns = mapping['lot_status'] && mapping['lot_qty'];

  const doImport = async () => {
    if (!rawFile || !requiredMet) return;
    setImporting(true);
    setErr('');
    const fd = new FormData();
    fd.append('file', rawFile);
    fd.append('sheet', selectedSheet);
    fd.append('productType', productType);
    fd.append('importMode', importMode);
    fd.append('mapping', JSON.stringify(mapping));
    fd.append('labels', JSON.stringify(labels));
    try {
      const r = await fetch('/api/admin/import-mapped', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'Import failed'); setImporting(false); return; }
      setResult(j);
      setStep('done');
    } catch (e) {
      setErr(String(e));
    }
    setImporting(false);
  };

  const reset = () => {
    setStep('upload'); setResult(null); setErr('');
    setMapping({}); setLabels({}); setFileHeaders([]); setSheets([]);
    setRawFile(null); setActiveOptional([]); setAddPanelOpen(false);
    setPreviewRows([]); setImportMode('OVERWRITE');
    if (fileRef.current) fileRef.current.value = '';
  };

  // Resolve one preview row's value for one visible system field, matching
  // (a simplified version of) what the backend will actually store — so
  // what you see here is what ends up in the system, not a guess.
  const resolvePreviewValue = (row: Record<string, unknown>, sf: SystemField): string => {
    const col = mapping[sf.key];
    if (!col) return '—';
    const raw = row[col];
    if (sf.key === 'lot_status') return normaliseLotStatusPreview(raw);
    if (raw === '' || raw === undefined || raw === null) return '—';
    return String(raw);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      <div className="px-4 lg:px-6 py-3.5 border-b border-line bg-surface flex items-center gap-3">
        <h1 className="text-[17px] font-semibold">Import Product Data</h1>
        {step !== 'upload' && (
          <button onClick={reset} className="ml-auto btn text-[13px]">
            Start Over
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto px-4 lg:px-6 py-6 max-w-3xl">

        {/* ── Step 1 – Upload ─────────────────────────────────── */}
        {step === 'upload' && (
          <div>
            <p className="text-[13px] text-ink-2 mb-6">
              Upload your Excel (.xlsx) or CSV file. You&apos;ll map columns to system fields on the next screen.
              For Timing Belt sheets, a <strong>CUT PCS / FULL SLEEVE</strong> column and a quantity column will automatically create opening lots for each row.
            </p>
            <div
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
              onDragOver={(e) => e.preventDefault()}
              className="border-2 border-dashed border-line rounded-xl p-12 text-center cursor-pointer hover:border-primary transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={28} className="mx-auto text-ink-3 mb-3" />
              <p className="text-[14px] font-medium mb-1">Drop your file here or click to browse</p>
              <p className="text-[12px] text-ink-3">.xlsx, .xls or .csv</p>
            </div>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          </div>
        )}

        {/* ── Step 2 – Map ─────────────────────────────────────── */}
        {step === 'map' && (
          <div>
            {/* Sheet + product type selectors */}
            <div className="flex flex-wrap gap-4 mb-5">
              {sheets.length > 1 && (
                <div>
                  <label className="label">Sheet / Tab</label>
                  <select className="field" value={selectedSheet} onChange={(e) => onSheetChange(e.target.value)}>
                    {sheets.map((s) => <option key={s}>{s}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="label">Product Type in this file</label>
                <select className="field" value={productType} onChange={(e) => setProductType(e.target.value as ProductType)}>
                  <option value="TIMING_BELT">Timing Belts</option>
                  <option value="V_BELT">V-Belts</option>
                  <option value="CONVEYOR_BELT">Conveyor Belt</option>
                </select>
              </div>
            </div>

            {/* Overwrite vs Add-additional */}
            <div className="mb-5">
              <label className="label">If a SKU already exists in the system</label>
              <div className="flex gap-4 mt-1">
                <label className="flex items-start gap-1.5 text-[12px] cursor-pointer">
                  <input type="radio" className="mt-0.5" checked={importMode === 'OVERWRITE'}
                    onChange={() => setImportMode('OVERWRITE')} />
                  <span>
                    <strong>Overwrite</strong>
                    <span className="block text-ink-3">
                      {productType === 'TIMING_BELT'
                        ? 'Updates product details. Stock is untouched — lots are only changed by inward/outward.'
                        : 'Replaces stock and details with this sheet’s values.'}
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-1.5 text-[12px] cursor-pointer">
                  <input type="radio" className="mt-0.5" checked={importMode === 'APPEND'}
                    onChange={() => setImportMode('APPEND')} />
                  <span>
                    <strong>Add as additional</strong>
                    <span className="block text-ink-3">
                      {productType === 'TIMING_BELT'
                        ? 'Creates a new roll/lot for this SKU, on top of what’s already there.'
                        : 'Adds this sheet’s quantity on top of current stock.'}
                    </span>
                  </span>
                </label>
              </div>
            </div>

            {/* Lot-status hint — Timing Belt only */}
            {productType === 'TIMING_BELT' && (
              hasLotColumns ? (
                <div className="mb-4 flex items-start gap-2 text-[12px] text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2.5">
                  <CheckCircle size={13} className="mt-0.5 shrink-0" />
                  Lot columns mapped — opening lots (FULL SLEEVE / CUT PCS) will be created from each row.
                </div>
              ) : (
                <div className="mb-4 flex items-start gap-2 text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
                  <AlertCircle size={13} className="mt-0.5 shrink-0" />
                  Map <strong>Lot Status</strong> and <strong>Lot Quantity</strong> below to create opening lots from this sheet.
                  Opening stock will still be set from those columns.
                </div>
              )
            )}

            <p className="text-[12px] text-ink-3 mb-3">
              <strong>{fileHeaders.length}</strong> columns detected.
              Map each system field to your column. <em>App Label</em> is what appears in the app — defaults to your column name.
            </p>

            <table className="w-full text-[13px] border border-line rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-surface-2">
                  <th className="text-left px-3 py-2.5 font-medium text-ink-2 w-[30%]">System Field</th>
                  <th className="text-left px-3 py-2.5 font-medium text-ink-2 w-[35%]">Your Column</th>
                  <th className="text-left px-3 py-2.5 font-medium text-ink-2 w-[30%]">App Label</th>
                  <th className="w-[5%]" />
                </tr>
              </thead>
              <tbody>
                {visibleFields.map((sf) => {
                  const isOptional = OPTIONAL_FIELDS.some((o) => o.key === sf.key);
                  const isLot = sf.isLotField;
                  return (
                    <tr
                      key={sf.key}
                      className={`border-t border-line ${isLot ? 'bg-blue-50/40' : ''}`}
                    >
                      <td className="px-3 py-2">
                        <span className={isLot ? 'text-blue-700 font-medium' : ''}>
                          {sf.label}
                        </span>
                        {sf.required && <span className="text-red-500 ml-0.5">*</span>}
                        {isLot && (
                          <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-blue-500 bg-blue-100 rounded px-1 py-0.5">
                            lot
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className={`field w-full ${sf.required && !mapping[sf.key] ? 'border-red-300' : ''}`}
                          value={mapping[sf.key] ?? ''}
                          onChange={(e) => setMap(sf.key, e.target.value)}
                        >
                          <option value="">— skip —</option>
                          {fileHeaders.map((h) => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className="field w-full text-[12px]"
                          placeholder={mapping[sf.key] ?? '—'}
                          value={labels[sf.key] ?? ''}
                          onChange={(e) => setLabels((l) => ({ ...l, [sf.key]: e.target.value }))}
                          disabled={!mapping[sf.key]}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {isOptional && (
                          <button
                            onClick={() => removeOptionalField(sf.key)}
                            className="text-ink-3 hover:text-red-500 transition-colors"
                            title="Remove field"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Add optional field */}
            {availableToAdd.length > 0 && (
              <div className="mt-3 relative">
                <button
                  onClick={() => setAddPanelOpen((o) => !o)}
                  className="btn text-[12px] flex items-center gap-1.5"
                >
                  <Plus size={13} />
                  Add Column
                </button>
                {addPanelOpen && (
                  <div className="absolute top-full left-0 mt-1 z-20 bg-surface border border-line rounded-lg shadow-lg min-w-[280px] max-h-64 overflow-auto">
                    {availableToAdd.map((f) => (
                      <button
                        key={f.key}
                        onClick={() => addOptionalField(f.key)}
                        className="w-full text-left px-4 py-2.5 text-[13px] hover:bg-surface-2 transition-colors"
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {err && (
              <div className="mt-4 flex items-start gap-2 text-[13px] text-red-600 bg-red-50 rounded-lg p-3">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                {err}
              </div>
            )}

            <div className="mt-6 flex items-center gap-3">
              <button onClick={() => setStep('preview')} disabled={!requiredMet} className="btn btn-primary flex items-center gap-1.5">
                <Eye size={14} /> Preview
              </button>
              {!requiredMet && (
                <p className="text-[12px] text-red-500">Map all required (*) fields to continue.</p>
              )}
            </div>
          </div>
        )}

        {/* ── Step 2b – Preview ────────────────────────────────── */}
        {step === 'preview' && (
          <div>
            <button onClick={() => setStep('map')} className="btn text-[12px] flex items-center gap-1.5 mb-4">
              <ArrowLeft size={13} /> Back to Mapping
            </button>

            <p className="text-[12px] text-ink-3 mb-3">
              Showing the first {Math.min(PREVIEW_ROW_COUNT, previewRows.length)} of {previewRows.length < PREVIEW_ROW_COUNT ? previewRows.length : 'many'} rows,
              exactly as each column will be understood by the system. Column headers below are your <em>App Label</em> for each field —
              this is what you&apos;ll see everywhere else in the app (Product Master, Inventory, etc.).
            </p>

            <div className="overflow-auto border border-line rounded-lg">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-surface-2">
                    {visibleFields.map((sf) => (
                      <th key={sf.key} className="text-left px-3 py-2 font-medium text-ink-2 whitespace-nowrap">
                        {labels[sf.key] || sf.label}
                        {sf.isLotField && (
                          <span className="ml-1 text-[9px] font-medium uppercase tracking-wide text-blue-500 bg-blue-100 rounded px-1 py-0.5">lot</span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={i} className="border-t border-line">
                      {visibleFields.map((sf) => (
                        <td key={sf.key} className="px-3 py-2 whitespace-nowrap">
                          {resolvePreviewValue(row, sf)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {previewRows.length === 0 && (
                    <tr><td className="px-3 py-6 text-center text-ink-3" colSpan={visibleFields.length}>No data rows found in this sheet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {err && (
              <div className="mt-4 flex items-start gap-2 text-[13px] text-red-600 bg-red-50 rounded-lg p-3">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                {err}
              </div>
            )}

            <div className="mt-6 flex items-center gap-3">
              <button onClick={doImport} disabled={importing} className="btn btn-primary">
                {importing ? 'Importing…' : 'Looks good — Import Now'}
              </button>
              <button onClick={() => setStep('map')} className="btn" disabled={importing}>
                Back to Mapping
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3 – Done ────────────────────────────────────── */}
        {step === 'done' && result && (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <CheckCircle size={28} className="text-green-500" />
              <div>
                <p className="font-semibold">Import complete</p>
                <p className="text-[13px] text-ink-2">
                  {result.inserted} products added · {result.updated} updated
                  {result.lots > 0 && ` · ${result.lots} opening lots created`}
                </p>
              </div>
            </div>

            {result.errors.length > 0 && (
              <div className="border border-yellow-200 bg-yellow-50 rounded-lg p-4 mb-4">
                <p className="text-[13px] font-medium text-yellow-800 mb-2">{result.errors.length} rows skipped:</p>
                <ul className="text-[12px] text-yellow-700 space-y-1 max-h-48 overflow-auto">
                  {result.errors.map((e, i) => <li key={i}>• {e}</li>)}
                </ul>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={reset} className="btn">Import Another File</button>
              <a href="/products" className="btn btn-primary">View Product Master →</a>
              <a href="/inventory" className="btn">View Inventory →</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
