/**
 * Thermal-receipt layout for a production order.
 *
 * ONE line model (receiptLines) feeds both the on-screen preview / browser print and
 * the PDF, so they can never drift apart. To change paper, edit PAPER only:
 *   80 mm roll: widthMm 80, chars 42   (default — standard restaurant-style printer)
 *   58 mm roll: widthMm 58, chars 32
 * Print path: hidden iframe + @page { size: <width> auto } — works with any thermal printer
 * installed in Windows (Epson TM-T82, TVS RP3160, …) without a printer-specific driver.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProductionOrder } from '@/lib/types';
import { loadItemParts, partLine, fromTag, totalLine, type AllocPart } from '@/lib/orderParts';

export const PAPER = { widthMm: 80, marginMm: 4, chars: 42, fontPt: 8 } as const;
export const SHOP_NAME = 'BHAGYODAY BELTS';
/** empty lines left after the last line, for a name and signature */
const SIGN_LINES = 7;

/** One cut: "25 mm × 9 pcs (225 mm total)" and the roll it comes from: "from Cut Pcs of 230 mm". */
export interface ReceiptPart { text: string; from: string }
export interface ReceiptItem {
  name: string; qty: number; unit: string; direct: boolean; pieces?: number | null; mm?: number | null;
  /** the whole line ("250 mm") — only given when the line has several cuts */
  total?: string;
  /** one per cut */
  parts: ReceiptPart[];
}
export interface ReceiptModel {
  orderNo: string;
  createdAt: string;
  isDirect: boolean;
  customer: string | null;
  worker: string | null;
  deliveryMode: string | null;
  deliveryNote: string | null;
  target: string | null;
  notes: string | null;
  items: ReceiptItem[];
}

export type RLine =
  | { t: 'text'; s: string; bold?: boolean; big?: boolean; center?: boolean }
  | { t: 'rule'; ch: '-' | '=' };

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));

function wrap(text: string, width: number, indent = ''): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if ((indent + next).length > width && line) { out.push(indent + line); line = word; }
    else line = next;
  }
  if (line) out.push(indent + line);
  return out;
}

export function receiptLines(m: ReceiptModel, chars: number = PAPER.chars): RLine[] {
  const L: RLine[] = [];
  const text = (s: string, o: Partial<Extract<RLine, { t: 'text' }>> = {}) => L.push({ t: 'text', s, ...o });
  const kv = (k: string, v: string | null | undefined) => {
    if (!v) return;
    wrap(`${k}: ${v}`, chars).forEach((s, i) => text(i === 0 ? s : `  ${s.trim()}`));
  };

  text(SHOP_NAME, { bold: true, center: true });
  text('PRODUCTION ORDER', { center: true });
  L.push({ t: 'rule', ch: '=' });
  text(m.orderNo, { bold: true, big: true, center: true });
  const d = new Date(m.createdAt);
  text(`${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}  ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}`, { center: true });
  if (m.isDirect) text('** DIRECT ORDER **', { bold: true, center: true });
  L.push({ t: 'rule', ch: '-' });
  kv('Customer', m.customer);
  kv('Worker', m.worker);
  kv('Delivery', m.deliveryMode ? `${m.deliveryMode}${m.deliveryNote ? ` (${m.deliveryNote})` : ''}` : null);
  kv('Target', m.target);
  L.push({ t: 'rule', ch: '=' });
  text('ITEMS', { bold: true });
  // Slim and plain: the cut first (its total in brackets), and under it where it is cut from.
  //   1. H-480 PIX   (250 mm total)       <- only when there are several cuts
  //      25 mm x 9 pcs (225 mm total)
  //        from Cut Pcs of 230 mm
  const ascii = (t: string) => t.replace(/×/g, 'x');
  m.items.forEach((it, i) => {
    const head = `${i + 1}. ${it.name}${it.total ? `  (${it.total} total)` : ''}`;
    wrap(head, chars).forEach((s) => text(s, { bold: true }));
    if (it.parts.length > 0) {
      for (const p of it.parts) {
        text(`   ${ascii(p.text)}`);
        text(`     [ ${ascii(p.from)} ]`, { bold: true });
      }
    } else {
      const w = it.unit.toUpperCase() === 'RIB' ? 'ribs' : 'mm';
      text(it.pieces && it.mm && it.pieces * it.mm === it.qty
        ? `   ${num(it.mm)} ${w} x ${num(it.pieces)} pcs (${num(it.qty)} ${w} total)`
        : `   ${num(it.qty)} ${it.unit.toLowerCase()}`);
    }
    if (it.direct) text('   (direct - no stock)');
    if (i < m.items.length - 1) text('');
  });
  if (m.notes) {
    L.push({ t: 'rule', ch: '-' });
    wrap(`Notes: ${m.notes}`, chars).forEach((s) => text(s));
  }
  L.push({ t: 'rule', ch: '=' });
  text(`Printed ${new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })}`, { center: true });
  // Blank space at the very end for a name and a signature to be written by hand — deliberately no title.
  for (let i = 0; i < SIGN_LINES; i++) text('');
  return L;
}

/** Load a plain model for an order, including which lots (Cut Pcs / Full Sleeve) each item uses. */
export async function loadReceiptModel(db: SupabaseClient, order: ProductionOrder): Promise<ReceiptModel> {
  const items = order.items ?? [];
  const ids = items.map((i) => i.id);
  const byItem: Record<string, AllocPart[]> = (ids.length > 0 && !order.is_direct) ? await loadItemParts(db, ids) : {};
  return {
    orderNo: order.order_no,
    createdAt: order.created_at,
    isDirect: !!order.is_direct,
    customer: order.customer_name,
    worker: order.assigned_to,
    deliveryMode: order.delivery_mode,
    deliveryNote: order.delivery_note,
    target: order.time_tag,
    notes: order.notes,
    items: items.map((i) => {
      const parts = byItem[i.id] ?? [];
      return {
        name: i.display_name,
        qty: Number(i.quantity),
        unit: i.unit_code,
        direct: !!order.is_direct,
        pieces: i.pieces ?? null,
        mm: i.length_mm ?? null,
        total: parts.length > 1 ? totalLine(i) : undefined,
        parts: parts.map((p) => ({ text: partLine(p, i.unit_code), from: fromTag(p, i.unit_code) })),
      };
    }),
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Receipt as HTML (used for the preview and the print iframe). */
export function receiptHtml(m: ReceiptModel, standalone = false): string {
  const body = receiptLines(m)
    .map((l) => {
      if (l.t === 'rule') return `<div class="r">${l.ch.repeat(PAPER.chars)}</div>`;
      const cls = [l.bold ? 'b' : '', l.big ? 'big' : '', l.center ? 'c' : ''].join(' ');
      return `<div class="${cls}">${l.s ? esc(l.s).replace(/ /g, '&nbsp;') : '&nbsp;'}</div>`;
    })
    .join('');
  const css = `
    .rc{font-family:'Courier New',Courier,monospace;font-size:${PAPER.fontPt + 1}pt;line-height:1.25;color:#000;width:${PAPER.chars}ch}
    .rc .b{font-weight:700}.rc .c{text-align:center}.rc .big{font-size:${PAPER.fontPt + 5}pt}.rc .r{overflow:hidden;white-space:nowrap}`;
  if (!standalone) return `<style>${css}</style><div class="rc">${body}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.orderNo)}</title><style>
    @page{size:${PAPER.widthMm}mm auto;margin:${PAPER.marginMm}mm}
    html,body{margin:0;padding:0;background:#fff}${css}.rc{padding-bottom:2mm}</style></head><body><div class="rc">${body}</div></body></html>`;
}

export function printReceipt(m: ReceiptModel) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument!;
  doc.open(); doc.write(receiptHtml(m, true)); doc.close();
  iframe.onload = () => {
    iframe.contentWindow!.focus();
    iframe.contentWindow!.print();
    setTimeout(() => iframe.remove(), 1500);
  };
  // some browsers don't fire onload for document.write
  setTimeout(() => { try { iframe.contentWindow!.focus(); iframe.contentWindow!.print(); } catch { /* ignore */ } }, 400);
}

export async function downloadReceiptPdf(m: ReceiptModel) {
  const { jsPDF } = await import('jspdf');
  const lines = receiptLines(m);
  const lineMm = PAPER.fontPt * 0.3528 * 1.25;
  const heightMm = Math.ceil(PAPER.marginMm * 2 + lines.length * lineMm * 1.15 + 6);
  const pdf = new jsPDF({ unit: 'mm', format: [PAPER.widthMm, heightMm] });
  pdf.setFont('courier', 'normal');
  let y = PAPER.marginMm + lineMm;
  const cx = PAPER.widthMm / 2;
  for (const l of lines) {
    if (l.t === 'rule') {
      pdf.setFont('courier', 'normal'); pdf.setFontSize(PAPER.fontPt);
      pdf.text(l.ch.repeat(PAPER.chars), PAPER.marginMm, y);
      y += lineMm;
      continue;
    }
    pdf.setFont('courier', l.bold ? 'bold' : 'normal');
    pdf.setFontSize(l.big ? PAPER.fontPt + 4 : PAPER.fontPt);
    if (l.center) pdf.text(l.s, cx, y, { align: 'center' });
    else pdf.text(l.s, PAPER.marginMm, y);
    y += l.big ? lineMm * 1.5 : lineMm;
  }
  pdf.save(`${m.orderNo}.pdf`);
}
