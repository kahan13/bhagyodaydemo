'use client';

import { useRef, useState } from 'react';
import { Upload, CheckCircle, AlertCircle, X, ChevronDown } from 'lucide-react';
import * as XLSX from 'xlsx';

type ProductType = 'TIMING_BELT' | 'V_BELT';

interface SystemField {
  key: string;
  label: string;
  required?: boolean;
  types?: ProductType[];
}

const SYSTEM_FIELDS: SystemField[] = [
  { key: 'sku_code',           label: 'SKU / Part Number',        required: true },
  { key: 'exact_size',         label: 'Size / Designation',       required: true },
  { key: 'brand',              label: 'Brand',                    required: true },
  { key: 'family',             label: 'Family',    required: true, types: ['TIMING_BELT'] },
  { key: 'profile',            label: 'Profile',   required: true, types: ['V_BELT'] },
  { key: 'opening_stock',      label: 'Opening Stock' },
  { key: 'unit',               label: 'Unit (PCS / MTR / ROLL)' },
  { key: 'min_stock_level',    label: 'Minimum Stock Level' },
  { key: 'supplier_moq',       label: 'Supplier MOQ' },
  { key: 'reorder_quantity',   label: 'Reorder Quantity' },
  { key: 'rack_location',      label: 'Rack Location' },
  { key: 'display_name',       label: 'Display Name' },
  { key: 'is_active',          label: 'Active? (Yes / No / 1 / 0)' },
  { key: 'belt_form',          label: 'Belt Form',                types: ['TIMING_BELT'] },
  { key: 'pitch_mm',           label: 'Pitch (mm)',               types: ['TIMING_BELT'] },
  { key: 'pitch_length_mm',    label: 'Pitch Length (mm)',        types: ['TIMING_BELT'] },
  { key: 'width_mm',           label: 'Width (mm)',               types: ['TIMING_BELT'] },
  { key: 'teeth',              label: 'Teeth',                    types: ['TIMING_BELT'] },
  { key: 'standard',           label: 'Standard',                 types: ['TIMING_BELT'] },
  { key: 'construction',       label: 'Construction',             types: ['V_BELT'] },
  { key: 'nominal_length',     label: 'Nominal Length',           types: ['V_BELT'] },
  { key: 'length_designation', label: 'Length Designation',       types: ['V_BELT'] },
];

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export default function ImportMappedView() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<'upload' | 'map' | 'done'>('upload');
  const [productType, setProductType] = useState<ProductType>('TIMING_BELT');
  const [sheets, setSheets] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
  const [rawFile, setRawFile] = useState<File | null>(null);
  // mapping: systemField → fileColumn
  const [mapping, setMapping] = useState<Record<string, string>>({});
  // labels: systemField → custom display label (defaults to file column name)
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ inserted: number; updated: number; errors: string[] } | null>(null);
  const [err, setErr] = useState('');

  const visibleFields = SYSTEM_FIELDS.filter(
    (f) => !f.types || f.types.includes(productType)
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
    // Auto-map by similarity
    const autoMap: Record<string, string> = {};
    for (const sf of SYSTEM_FIELDS) {
      const match = headers.find((h) =>
        slugify(h) === sf.key ||
        slugify(h).includes(sf.key.replace('_', '')) ||
        sf.key.includes(slugify(h))
      );
      if (match) autoMap[sf.key] = match;
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
    // Auto-fill label with the column name from the file
    if (colName && !labels[sfKey]) {
      setLabels((l) => ({ ...l, [sfKey]: colName }));
    }
    if (!colName) {
      setLabels((l) => { const n = { ...l }; delete n[sfKey]; return n; });
    }
  };

  const setLabel = (sfKey: string, val: string) => {
    setLabels((l) => ({ ...l, [sfKey]: val }));
  };

  const requiredMet = visibleFields
    .filter((f) => f.required)
    .every((f) => mapping[f.key]);

  const doImport = async () => {
    if (!rawFile || !requiredMet) return;
    setImporting(true); setErr('');
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
    setMapping({}); setLabels({}); setFileHeaders([]); setSheets([]); setRawFile(null);
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

        {/* Step 1 – Upload */}
        {step === 'upload' && (
          <div>
            <p className="text-[13px] text-ink-2 mb-6">
              Upload your Excel (.xlsx) or CSV file. You will map your column headers to the system fields on the next screen — the app will use your original column names as labels throughout.
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

        {/* Step 2 – Map */}
        {step === 'map' && (
          <div>
            {/* Sheet + type selectors */}
            <div className="flex flex-wrap gap-4 mb-6">
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

            <p className="text-[12px] text-ink-3 mb-4">
              <strong>{fileHeaders.length}</strong> columns detected. Map each system field to your column. The <em>App Label</em> is what will appear as the column header in the app — it defaults to your column name and you can rename it.
            </p>

            <table className="w-full text-[13px] border border-line rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-surface-2">
                  <th className="text-left px-3 py-2.5 font-medium text-ink-2 w-[30%]">System Field</th>
                  <th className="text-left px-3 py-2.5 font-medium text-ink-2 w-[35%]">Your Column</th>
                  <th className="text-left px-3 py-2.5 font-medium text-ink-2 w-[35%]">App Label</th>
                </tr>
              </thead>
              <tbody>
                {visibleFields.map((sf) => (
                  <tr key={sf.key} className="border-t border-line">
                    <td className="px-3 py-2">
                      {sf.label}
                      {sf.required && <span className="text-red-500 ml-0.5">*</span>}
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
                        placeholder={mapping[sf.key] ? mapping[sf.key] : '—'}
                        value={labels[sf.key] ?? ''}
                        onChange={(e) => setLabel(sf.key, e.target.value)}
                        disabled={!mapping[sf.key]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

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

        {/* Step 3 – Done */}
        {step === 'done' && result && (
          <div>
            <div className="flex items-center gap-3 mb-6">
              <CheckCircle size={28} className="text-green-500" />
              <div>
                <p className="font-semibold">Import complete</p>
                <p className="text-[13px] text-ink-2">
                  {result.inserted} products added · {result.updated} updated
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
