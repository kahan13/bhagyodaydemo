import type { LotGroup } from '@/lib/types';
import { fmtQty } from '@/lib/format';

type Piece = { status: 'CUT_PCS' | 'FULL_SLEEVE'; qty: number };
type Row = { status: 'CUT_PCS' | 'FULL_SLEEVE'; each: number; count: number };

const NAME = { CUT_PCS: 'Cut Pcs', FULL_SLEEVE: 'Full Sleeve' } as const;
const tone = (s: string) => (s === 'CUT_PCS' ? 'lot-cut' : 'lot-full');

function merge(rows: Row[]): Row[] {
  const m = new Map<string, Row>();
  for (const r of rows) {
    const k = `${r.status}-${r.each}`;
    const x = m.get(k);
    if (x) x.count += r.count; else m.set(k, { ...r });
  }
  return [...m.values()].sort((a, b) =>
    a.status === b.status ? a.each - b.each : a.status === 'CUT_PCS' ? -1 : 1);
}

/** Same rule the database uses: cut pieces first, then full sleeves; a used sleeve leaves a cut piece. */
export function planOutward(groups: LotGroup[], amount: number) {
  const pieces: Piece[] = [];
  const ordered = [...groups].sort((a, b) =>
    a.status === b.status ? Number(a.piece_qty) - Number(b.piece_qty) : a.status === 'CUT_PCS' ? -1 : 1);
  for (const g of ordered) for (let i = 0; i < Number(g.pieces); i++) pieces.push({ status: g.status, qty: Number(g.piece_qty) });

  let need = amount;
  const takes: { text: string; status: string; qty: number }[] = [];
  const left: Row[] = [];
  const before: Row[] = ordered.map((g) => ({ status: g.status, each: Number(g.piece_qty), count: Number(g.pieces) }));

  for (const p of pieces) {
    if (need <= 0) { left.push({ status: p.status, each: p.qty, count: 1 }); continue; }
    const take = Math.min(need, p.qty);
    need -= take;
    const rest = p.qty - take;
    takes.push({
      status: p.status, qty: take,
      text: rest === 0
        ? `whole ${NAME[p.status]} ${fmtQty(p.qty)} mm used up`
        : `${fmtQty(take)} mm from ${NAME[p.status]} ${fmtQty(p.qty)} mm → leaves ${fmtQty(rest)} mm Cut Pcs`,
    });
    if (rest > 0) left.push({ status: 'CUT_PCS', each: rest, count: 1 });
  }

  // collapse identical take lines: "2 × whole Full Sleeve 460 mm used up"
  const lines = new Map<string, { text: string; status: string; n: number }>();
  for (const t of takes) {
    const l = lines.get(t.text);
    if (l) l.n += 1; else lines.set(t.text, { text: t.text, status: t.status, n: 1 });
  }
  return { before: merge(before), take: [...lines.values()], takes: takes.map((t) => t.qty), after: merge(left) };
}

const total = (r: Row[]) => r.reduce((s, x) => s + x.each * x.count, 0);
const rowText = (r: Row[]) =>
  r.length === 0 ? 'nothing'
    : r.map((x) => `${x.count} × ${fmtQty(x.each)}${x.status === 'CUT_PCS' ? ' cut' : ''}`).join(' + ');

/** One plain line: now → taken → left, e.g. "3 × 460  →  take 460 + 10  →  1 × 450 cut + 1 × 460 = 910 mm". */
export default function OutwardPlan({ groups, amount, unit = 'mm' }: { groups?: LotGroup[]; amount: number; unit?: string }) {
  if (!groups || groups.length === 0 || !(amount > 0)) return null;
  const stock = groups.reduce((s, g) => s + Number(g.piece_qty) * Number(g.pieces), 0);
  if (amount > stock) return null;
  const p = planOutward(groups, amount);
  return (
    <div className="rounded-lg border border-line bg-subtle px-3 py-2 text-[15px] text-ink num leading-relaxed">
      <span>{rowText(p.before)}</span>
      <span className="mx-2">→</span>
      <span>take {p.takes.map((q) => fmtQty(q)).join(' + ')}</span>
      <span className="mx-2">→</span>
      <span>{rowText(p.after)} = <strong>{fmtQty(total(p.after), unit)}</strong></span>
    </div>
  );
}
