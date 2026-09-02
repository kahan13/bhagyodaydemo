'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileSpreadsheet, FileText, RefreshCw } from 'lucide-react';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { fmtDate, fmtQty, fmtDateTime, CHANNEL_LABEL } from '@/lib/format';

type ReportKind =
  | 'current_stock' | 'low_stock' | 'movements' | 'inward' | 'outward'
  | 'brand_summary' | 'family_summary';

const REPORTS: { id: ReportKind; label: string; note: string; dated: boolean }[] = [
  { id: 'current_stock', label: 'Current stock', note: 'Every active SKU with its stock and reorder settings', dated: false },
  { id: 'low_stock', label: 'Low stock', note: 'SKUs below minimum, with suggested purchase quantity', dated: false },
  { id: 'movements', label: 'All movements', note: 'Complete transaction register for the period', dated: true },
  { id: 'inward', label: 'Inward register', note: 'Goods received in the period', dated: true },
  { id: 'outward', label: 'Outward register', note: 'Goods issued in the period', dated: true },
  { id: 'brand_summary', label: 'Brand summary', note: 'SKU count and stock value by brand', dated: false },
  { id: 'family_summary', label: 'Family summary', note: 'SKU count and stock by family or profile', dated: false },
];

const RANGES: [string, string][] = [
  ['today', 'Today'], ['week', 'This week'], ['month', 'This month'],
  ['year', 'This year'], ['custom', 'Custom range'], ['all', 'All time'],
];

const IST = 5.5 * 60 * 60 * 1000;

function bounds(range: string, from: string, to: string) {
  if (range === 'all') return {};
  if (range === 'custom') {
    return {
      start: from ? new Date(`${from}T00:00:00+05:30`).toISOString() : undefined,
      end: to ? new Date(`${to}T23:59:59.999+05:30`).toISOString() : undefined,
    };
  }
  const ist = new Date(Date.now() + IST);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const mid = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd) - IST);
  const today = mid(y, m, d);
  const end = new Date(today.getTime() + 86_400_000 - 1).toISOString();

  if (range === 'today') return { start: today.toISOString(), end };
  if (range === 'week') {
    const weekday = new Date(today.getTime() + IST).getUTCDay();
    return { start: new Date(today.getTime() - ((weekday + 6) % 7) * 86_400_000).toISOString(), end };
  }
  if (range === 'year') return { start: mid(y, 0, 1).toISOString(), end };
  return { start: mid(y, m, 1).toISOString(), end };
}

export default function ReportsView({
  canExport, brands, families, company,
}: {
  canExport: boolean;
  brands: string[];
  families: string[];
  company: Record<string, string>;
}) {
  const [kind, setKind] = useState<ReportKind>('current_stock');
  const [range, setRange] = useState('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [brand, setBrand] = useState('');
  const [family, setFamily] = useState('');
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<{ key: string; label: string; numeric?: boolean }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const definition = REPORTS.find((r) => r.id === kind)!;

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    const db = supabaseBrowser();
    const { start, end } = bounds(range, from, to);

    try {
      if (kind === 'current_stock' || kind === 'low_stock') {
        let q = db.from('v_sku_status')
          .select('sku_code,product_type,exact_size,brand_name,family_code,unit_code,current_stock,min_stock_level,supplier_moq,suggested_purchase_qty,rack_location,stock_status')
          .eq('is_active', true);
        if (kind === 'low_stock') q = q.in('stock_status', ['LOW_STOCK', 'OUT_OF_STOCK']);
        if (brand) q = q.eq('brand_name', brand);
        if (family) q = q.eq('family_code', family);

        const { data, error } = await q.order('exact_size').limit(5000);
        if (error) throw new Error(error.message);

        setColumns([
          { key: 'sku_code', label: 'SKU' },
          { key: 'exact_size', label: 'Size' },
          { key: 'brand_name', label: 'Brand' },
          { key: 'family_code', label: 'Family' },
          { key: 'current_stock', label: 'Stock', numeric: true },
          { key: 'unit_code', label: 'Unit' },
          { key: 'min_stock_level', label: 'Minimum', numeric: true },
          ...(kind === 'low_stock'
            ? [{ key: 'suggested_purchase_qty', label: 'Order', numeric: true }]
            : [{ key: 'rack_location', label: 'Rack' }]),
          { key: 'stock_status', label: 'Status' },
        ]);
        setRows((data ?? []) as Record<string, unknown>[]);
      } else if (kind === 'brand_summary' || kind === 'family_summary') {
        const { data, error } = await db.from('v_sku_status')
          .select('brand_name,family_code,current_stock,unit_code,stock_status')
          .eq('is_active', true).limit(20000);
        if (error) throw new Error(error.message);

        const groupKey = kind === 'brand_summary' ? 'brand_name' : 'family_code';
        const buckets = new Map<string, { skus: number; low: number; pcs: number; mtr: number }>();
        for (const r of (data ?? []) as Record<string, string | number>[]) {
          const key = String(r[groupKey]);
          const b = buckets.get(key) ?? { skus: 0, low: 0, pcs: 0, mtr: 0 };
          b.skus += 1;
          if (r.stock_status !== 'OK') b.low += 1;
          if (r.unit_code === 'MTR') b.mtr += Number(r.current_stock);
          else b.pcs += Number(r.current_stock);
          buckets.set(key, b);
        }

        setColumns([
          { key: 'name', label: kind === 'brand_summary' ? 'Brand' : 'Family / profile' },
          { key: 'skus', label: 'SKUs', numeric: true },
          { key: 'pcs', label: 'Pieces', numeric: true },
          { key: 'mtr', label: 'Metres', numeric: true },
          { key: 'low', label: 'Below minimum', numeric: true },
        ]);
        setRows([...buckets.entries()]
          .map(([name, v]) => ({ name, ...v }))
          .sort((a, b) => b.skus - a.skus));
      } else {
        let q = db.from('v_movements')
          .select('txn_no,occurred_at,txn_type,txn_mode,exact_size,brand_name,family_code,quantity,unit_code,previous_stock,new_stock,user_name,channel,reference');
        if (kind === 'inward') q = q.eq('txn_type', 'INWARD');
        if (kind === 'outward') q = q.eq('txn_type', 'OUTWARD');
        if (start) q = q.gte('occurred_at', start);
        if (end) q = q.lte('occurred_at', end);
        if (brand) q = q.eq('brand_name', brand);
        if (family) q = q.eq('family_code', family);

        const { data, error } = await q.order('occurred_at', { ascending: false }).limit(5000);
        if (error) throw new Error(error.message);

        setColumns([
          { key: 'txn_no', label: 'Transaction' },
          { key: 'occurred_at', label: 'Date & time' },
          { key: 'exact_size', label: 'Size' },
          { key: 'brand_name', label: 'Brand' },
          { key: 'txn_type', label: 'Type' },
          { key: 'quantity', label: 'Qty', numeric: true },
          { key: 'unit_code', label: 'Unit' },
          { key: 'previous_stock', label: 'Before', numeric: true },
          { key: 'new_stock', label: 'After', numeric: true },
          { key: 'user_name', label: 'User' },
          { key: 'channel', label: 'Device' },
          { key: 'reference', label: 'Reference' },
        ]);
        setRows((data ?? []) as Record<string, unknown>[]);
      }
    } catch (e) {
      setError((e as Error).message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [kind, range, from, to, brand, family]);

  useEffect(() => { void run(); }, [run]);

  function cell(row: Record<string, unknown>, key: string): string {
    const value = row[key];
    if (value === null || value === undefined || value === '') return '—';
    if (key === 'occurred_at') return fmtDateTime(String(value));
    if (key === 'channel') return CHANNEL_LABEL[String(value)] ?? String(value);
    if (key === 'stock_status') return String(value).replace(/_/g, ' ').toLowerCase();
    if (typeof value === 'number') return fmtQty(value);
    return String(value);
  }

  const title = `${definition.label} — ${company.name ?? 'Bhagyoday Belts'}`;
  const period = definition.dated
    ? RANGES.find(([v]) => v === range)?.[1] ?? ''
    : `As on ${fmtDate(new Date().toISOString())}`;

  async function exportExcel() {
    const XLSX = await import('xlsx');
    const sheet = XLSX.utils.json_to_sheet(
      rows.map((r) => Object.fromEntries(columns.map((c) => [c.label, cell(r, c.key)]))),
    );
    sheet['!cols'] = columns.map((c) => ({ wch: Math.max(12, c.label.length + 4) }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, definition.label.slice(0, 28));
    XLSX.writeFile(book, `Bhagyoday_${kind}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  async function exportPdf() {
    const { default: jsPDF } = await import('jspdf');
    const { default: autoTable } = await import('jspdf-autotable');

    const doc = new jsPDF({ orientation: columns.length > 8 ? 'landscape' : 'portrait', unit: 'pt' });
    const width = doc.internal.pageSize.getWidth();

    doc.setFontSize(15);
    doc.setTextColor(14, 14, 18);
    doc.text(String(company.name ?? 'Bhagyoday Belt Company'), 40, 44);

    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(String(company.address ?? ''), 40, 60, { maxWidth: width - 220 });

    doc.setFontSize(12);
    doc.setTextColor(14, 14, 18);
    doc.text(definition.label, 40, 92);

    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(`${period}   ·   ${rows.length} rows   ·   Generated ${fmtDateTime(new Date().toISOString())}`, 40, 107);

    autoTable(doc, {
      startY: 122,
      head: [columns.map((c) => c.label)],
      body: rows.map((r) => columns.map((c) => cell(r, c.key))),
      styles: { fontSize: 7.5, cellPadding: 4, textColor: [30, 30, 36], lineColor: [231, 231, 236] },
      headStyles: { fillColor: [91, 91, 214], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [250, 250, 252] },
      margin: { left: 40, right: 40 },
      didDrawPage: () => {
        const page = doc.getNumberOfPages();
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text(
          `${company.name ?? 'Bhagyoday Belts'} · Inventory Management System · Page ${page}`,
          40,
          doc.internal.pageSize.getHeight() - 22,
        );
      },
    });

    doc.save(`Bhagyoday_${kind}_${new Date().toISOString().slice(0, 10)}.pdf`);
  }

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      <div className="px-4 lg:px-6 py-3.5 border-b border-line bg-surface space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[17px] font-semibold">Reports</h1>
          <span className="text-[12px] text-ink-3 num">{rows.length.toLocaleString('en-IN')} rows</span>

          <div className="ml-auto flex gap-2">
            <button className="btn btn-secondary btn-sm" onClick={() => void run()} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} /> Refresh
            </button>
            <button className="btn btn-secondary btn-sm" onClick={exportExcel} disabled={!canExport || !rows.length}>
              <FileSpreadsheet size={13} /> Excel
            </button>
            <button className="btn btn-primary btn-sm" onClick={exportPdf} disabled={!canExport || !rows.length}>
              <FileText size={13} /> PDF
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="label" htmlFor="kind">Report</label>
            <select id="kind" className="field w-[178px]" value={kind}
              onChange={(e) => setKind(e.target.value as ReportKind)}>
              {REPORTS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>

          {definition.dated && (
            <>
              <div>
                <label className="label" htmlFor="range">Period</label>
                <select id="range" className="field w-[136px]" value={range} onChange={(e) => setRange(e.target.value)}>
                  {RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              {range === 'custom' && (
                <>
                  <div>
                    <label className="label" htmlFor="from">From</label>
                    <input id="from" type="date" className="field w-[148px]" value={from} onChange={(e) => setFrom(e.target.value)} />
                  </div>
                  <div>
                    <label className="label" htmlFor="to">To</label>
                    <input id="to" type="date" className="field w-[148px]" value={to} onChange={(e) => setTo(e.target.value)} />
                  </div>
                </>
              )}
            </>
          )}

          <div>
            <label className="label" htmlFor="brand">Brand</label>
            <select id="brand" className="field w-[150px]" value={brand} onChange={(e) => setBrand(e.target.value)}>
              <option value="">All</option>
              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="family">Family</label>
            <select id="family" className="field w-[118px]" value={family} onChange={(e) => setFamily(e.target.value)}>
              <option value="">All</option>
              {families.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>

          <p className="text-[11px] text-ink-3 pb-2 ml-1">{definition.note}</p>
        </div>
      </div>

      <div className="flex-1 min-h-0 scroll">
        {error && <p className="m-4 text-[13px] text-danger bg-danger-soft rounded-lg px-3.5 py-2.5">{error}</p>}

        {loading && (
          <div className="p-4 space-y-2">
            {Array.from({ length: 10 }, (_, i) => <div key={i} className="h-9 skeleton" />)}
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <p className="py-16 text-center text-[13px] text-ink-3">Nothing to report for these filters.</p>
        )}

        {!loading && rows.length > 0 && (
          <table className="table">
            <thead>
              <tr>{columns.map((c) => (
                <th key={c.key} className={c.numeric ? 'text-right' : undefined}>{c.label}</th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((r, i) => (
                <tr key={i}>
                  {columns.map((c) => (
                    <td key={c.key} className={c.numeric ? 'num text-right' : undefined}>
                      {cell(r, c.key)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && rows.length > 500 && (
          <p className="px-4 py-3 text-[12px] text-ink-3 border-t border-line">
            Showing the first 500 rows. Exports include all {rows.length.toLocaleString('en-IN')}.
          </p>
        )}
      </div>

      <div className="border-t border-line bg-surface px-4 lg:px-6 h-11 flex items-center shrink-0">
        <p className="text-[11px] text-ink-3">{title} · {period}</p>
      </div>
    </div>
  );
}
