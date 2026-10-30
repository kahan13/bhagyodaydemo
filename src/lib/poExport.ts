/**
 * Excel and PDF of ONE purchase order, laid out as the order sheet that is sent to the supplier:
 * who is ordering, the PO number and date, and every item with the quantity wanted.
 * (What has been received, recorded or reversed is for the screen, not for the supplier.)
 * Free of server imports (runs in the browser).
 */
import { fmtDateTime } from '@/lib/format';

export interface PoExportLine {
  sku_code: string;
  size: string;
  brand: string;
  category: string;
  /** what is wanted, e.g. "470 mm × 3 pcs (1410 mm total)" or "30 m" */
  quantity: string;
  /** "Full sleeve" / "Cut pcs" for roll-tracked belts, empty otherwise */
  form: string;
}

export interface PoExportOrder {
  order_no: string;
  supplier: string | null;
  notes: string | null;
  created_at: string;
  lines: PoExportLine[];
}

const COLS: { label: string; get: (l: PoExportLine, i: number) => string; w: number }[] = [
  { label: '#',               get: (_l, i) => String(i + 1), w: 5 },
  { label: 'Product (size)',  get: (l) => l.size,     w: 22 },
  { label: 'SKU',             get: (l) => l.sku_code, w: 24 },
  { label: 'Brand',           get: (l) => l.brand,    w: 16 },
  { label: 'Category',        get: (l) => l.category, w: 16 },
  { label: 'Quantity ordered', get: (l) => l.quantity, w: 34 },
  { label: 'Full sleeve / Cut pcs', get: (l) => l.form || '—', w: 20 },
];

const fileName = (o: PoExportOrder, ext: string) => `${o.order_no}.${ext}`;

export async function exportPoExcel(o: PoExportOrder, company: Record<string, string>) {
  const XLSX = await import('xlsx');
  const contact = [company.phone, company.email, company.gstin ? `GSTIN ${company.gstin}` : ''].filter(Boolean).join('  ·  ');
  const head: (string | number)[][] = [
    [String(company.name ?? 'Bhagyoday Belts')],
    [String(company.address ?? '')],
    [contact],
    [],
    ['PURCHASE ORDER'],
    ['PO number', o.order_no],
    ['Date', fmtDateTime(o.created_at)],
    ['To (supplier)', o.supplier ?? '—'],
    ...(o.notes ? [['Notes', o.notes] as (string | number)[]] : []),
    [],
  ];
  const table = [COLS.map((c) => c.label), ...o.lines.map((l, i) => COLS.map((c) => c.get(l, i)))];
  const sheet = XLSX.utils.aoa_to_sheet([...head, ...table, [], [`${o.lines.length} item${o.lines.length === 1 ? '' : 's'}`]]);
  sheet['!cols'] = COLS.map((c) => ({ wch: c.w }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, o.order_no.slice(0, 28));
  XLSX.writeFile(book, fileName(o, 'xlsx'));
}

export async function exportPoPdf(o: PoExportOrder, company: Record<string, string>) {
  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt' });
  const width = doc.internal.pageSize.getWidth();

  doc.setFontSize(16);
  doc.setTextColor(14, 14, 18);
  doc.text(String(company.name ?? 'Bhagyoday Belt Company'), 40, 46);
  doc.setFontSize(9);
  doc.setTextColor(110);
  let y = 61;
  if (company.address) { doc.text(String(company.address), 40, y, { maxWidth: width - 80 }); y += 12; }
  const contact = [company.phone, company.email, company.gstin ? `GSTIN ${company.gstin}` : ''].filter(Boolean).join('   ·   ');
  if (contact) { doc.text(contact, 40, y); y += 12; }

  doc.setFontSize(14);
  doc.setTextColor(14, 14, 18);
  doc.text('PURCHASE ORDER', 40, y + 22);
  doc.setFontSize(10);
  doc.setTextColor(40);
  doc.text(`PO number: ${o.order_no}`, 40, y + 40);
  doc.text(`Date: ${fmtDateTime(o.created_at)}`, width - 40, y + 40, { align: 'right' });
  doc.text(`To (supplier): ${o.supplier ?? '—'}`, 40, y + 55);
  let start = y + 72;
  if (o.notes) { doc.text(`Notes: ${o.notes}`, 40, y + 70, { maxWidth: width - 80 }); start += 14; }

  autoTable(doc, {
    startY: start,
    head: [COLS.map((c) => c.label)],
    body: o.lines.map((l, i) => COLS.map((c) => c.get(l, i))),
    styles: { fontSize: 9, cellPadding: 5, textColor: [30, 30, 36], lineColor: [225, 225, 231] },
    headStyles: { fillColor: [91, 91, 214], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [250, 250, 252] },
    columnStyles: { 0: { cellWidth: 24 } },
    margin: { left: 40, right: 40 },
    foot: [[{ content: `${o.lines.length} item${o.lines.length === 1 ? '' : 's'}`, colSpan: COLS.length, styles: { halign: 'right', fontStyle: 'bold', fillColor: [255, 255, 255], textColor: [60, 60, 66] } }]],
    didDrawPage: () => {
      doc.setFontSize(8);
      doc.setTextColor(150);
      doc.text(`${company.name ?? 'Bhagyoday Belts'} · ${o.order_no} · Page ${doc.getNumberOfPages()}`, 40, doc.internal.pageSize.getHeight() - 22);
    },
  });

  doc.save(fileName(o, 'pdf'));
}
