'use client';

import { useRef, useState } from 'react';
import { Upload, CheckCircle, AlertCircle, ChevronDown, Plus, Trash2 } from 'lucide-react';
import * as XLSX from 'xlsx';

type ProductType = 'TIMING_BELT' | 'V_BELT';

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
  { key: 'family',             label: 'Family',    required: true, types: ['TIMING_BELT'] },
  { key: 'profile',            label: 'Profile',   required: true, types: ['V_BELT'] },
  // Lot fields: map these to create opening lots from the sheet
  { key: 'lot_status',         label: 'Lot Status (CUT PCS / FULL SLEEVE)',  isLotField: true },
  { key: 'lot_qty',            label: 'Lot Quantity (mm)',                   isLotField: true },
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
  { key: 'roll_length_mm',     label: 'Roll Length (mm) — 1 full sleeve' },
  { key: 'belt_form',          label: 'Belt Form',          types: ['TIMING_BELT'] },
  { key: 'pitch_mm',           label: 'Pitch (mm)',         types: ['TIMING_BELT'] },
  { key: 'pitch_length_mm',    label: 'Pitch Length (mm)',  types: ['TIMING_BELT'] },
  { key: 'width_mm',           label: 'Width (mm)',         types: ['TIMING_BELT'] },
  { key: 'teeth',              label: 'Teeth',              types: ['TIMING_BELT'] },
  { key: 'standard',           label: 'Standard',           types: ['TIMING_BELT'] },
  { key: 'construction',       label: 'Construction',       types: ['V_BELT'] },
  { key: 'nominal_length',     label: 'Nominal Length',     types: ['V_BELT'] },
  { key: 'length_designation', label: 'Length Designation', types: ['V_BELT'] },
];

const ALL_SYSTEM_KEYS = [...CORE_FIELDS, ...OPTIONAL_FIELDS].map((f) => f.key);

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export default function ImportMappedView() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<'upload' | 'map' | 'done'>('upload');
  const [productType, setProductType] = useState<ProductType>('TIMING_BELT');
  const [sheets, setSheets] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
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

  const hasLotColumns = mapping['lot_status'] && mapping['lot_qty'];

  const doImport = async () => {
    if (!rawFile || !requiredMet) return;
    setImporting(true);
    setErr('');
    const fd = new FormData();
    fd.append('file', rawFile);
    fd.append('sheet', selectedSheet);
    fd.append('productType', productType);
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
    if (fileRef.current) fileRef.current.value = '';
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
              Sheets with a <strong>CUT PCS / FULL SLEEVE</strong> column and a quantity column will automatically create opening lots for each row.
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
                  <select className="input" value={selectedSheet} onChange={(e) => onSheetChange(e.target.value)}>
                    {sheets.map((s) => <option key={s}>{s}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="label">Product Type in this file</label>
                <select className="input" value={productType} onChange={(e) => setProductType(e.target.value as ProductType)}>
                  <option value="TIMING_BELT">Timing Belts</option>
                  <option value="V_BELT">V-Belts</option>
                </select>
              </div>
            </div>

            {/* Lot-status hint */}
            {hasLotColumns ? (
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
                        <div className="relative">
                          <select
                            className={`input w-full pr-7 ${sf.required && !mapping[sf.key] ? 'border-red-300' : ''}`}
                            value={mapping[sf.key] ?? ''}
                            onChange={(e) => setMap(sf.key, e.target.value)}
                          >
                            <option value="">— skip —</option>
                            {fileHeaders.map((h) => <option key={h} value={h}>{h}</option>)}
                          </select>
                          <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-ink-3" />
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className="input w-full text-[12px]"
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
              <button onClick={doImport} disabled={!requiredMet || importing} className="btn btn-primary">
                {importing ? 'Importing…' : 'Import Now'}
              </button>
              {!requiredMet && (
                <p className="text-[12px] text-red-500">Map all required (*) fields to continue.</p>
              )}
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
