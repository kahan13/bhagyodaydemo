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

export const PAPER = { widthMm: 80, marginMm: 4, chars: 42, fontPt: 8 } as const;
export const SHOP_NAME = 'BHAGYODAY BELTS';

export interface ReceiptPart { label: string; qty: number; note?: string }
export interface ReceiptItem { name: string; qty: number; unit: string; parts: ReceiptPart[]; direct: boolean; pieces?: number | null; mm?: number | null }
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
  m.items.forEach((it, i) => {
    wrap(`${i + 1}. ${it.name}`, chars).forEach((s) => text(s, { bold: true }));
    text(it.pieces && it.mm && it.pieces * it.mm === it.qty
      ? `   Qty: ${num(it.pieces)} x ${num(it.mm)} = ${num(it.qty)} ${it.unit}`
      : `   Qty: ${num(it.qty)} ${it.unit}`);
    if (it.direct) text('   (direct - no stock)');
    for (const p of it.parts) {
      text(`   > ${p.label}: ${num(p.qty)} ${it.unit}${p.note ? ` ${p.note}` : ''}`);
    }
    if (i < m.items.length - 1) text('');
  });
  if (m.notes) {
    L.push({ t: 'rule', ch: '-' });
    wrap(`Notes: ${m.notes}`, chars).forEach((s) => text(s));
  }
  L.push({ t: 'rule', ch: '=' });
  text(`Printed ${new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })}`, { center: true });
  return L;
}

/** Load a plain model for an order, including which lots (Cut Pcs / Full Sleeve) each item uses. */
export async function loadReceiptModel(db: SupabaseClient, order: ProductionOrder): Promise<ReceiptModel> {
  const items = order.items ?? [];
  const byItem: Record<string, ReceiptPart[]> = {};
  const ids = items.map((i) => i.id);
  if (ids.length > 0 && !order.is_direct) {
    const { data } = await db
      .from('lot_allocations')
      .select('item_id,allocated_qty,lot_status,piece_qty,sku_lots(status,current_qty)')
      .in('item_id', ids);
    for (const r of (data ?? []) as any[]) {
      const status: string = r.lot_status ?? r.sku_lots?.status ?? 'CUT_PCS';
      const piece = Number(r.piece_qty ?? r.sku_lots?.current_qty ?? 0);
      const qty = Number(r.allocated_qty);
      (byItem[r.item_id] ??= []).push({
        label: status === 'FULL_SLEEVE' ? 'Full Sleeve' : 'Cut Pcs',
        qty,
        note: status === 'FULL_SLEEVE' && piece > qty ? `(of ${num(piece)} sleeve)` : undefined,
      });
    }
    for (const k of Object.keys(byItem)) {
      byItem[k].sort((a, b) => (a.label === b.label ? 0 : a.label === 'Cut Pcs' ? -1 : 1));
    }
  }
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
    items: items.map((i) => ({
      name: i.display_name,
      qty: Number(i.quantity),
      unit: i.unit_code,
      parts: byItem[i.id] ?? [],
      direct: !!order.is_direct,
      pieces: i.pieces ?? null,
      mm: i.length_mm ?? null,
    })),
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
    html,body{margin:0;padding:0;background:#fff}${css}</style></head><body><div class="rc">${body}</div></body></html>`;
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
