import type { LotGroup } from '@/lib/types';
import { fmtQty, fmtMmPcs } from '@/lib/format';
import { lotUnitWordOfUnit } from '@/lib/lotUnit';
import type { RollGroup } from '@/components/inventory/RollEntry';

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
export function planOutward(groups: LotGroup[], amount: number, w = 'mm') {
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
        ? `whole ${NAME[p.status]} ${fmtQty(p.qty)} ${w} used up`
        : `${fmtQty(take)} ${w} from ${NAME[p.status]} ${fmtQty(p.qty)} ${w} → leaves ${fmtQty(rest)} ${w} Cut Pcs`,
    });
    if (rest > 0) left.push({ status: 'CUT_PCS', each: rest, count: 1 });
  }

  // collapse identical take lines: "whole Full Sleeve 460 mm used up" (twice → n = 2)
  const lines = new Map<string, { text: string; status: string; n: number }>();
  for (const t of takes) {
    const l = lines.get(t.text);
    if (l) l.n += 1; else lines.set(t.text, { text: t.text, status: t.status, n: 1 });
  }
  return { before: merge(before), take: [...lines.values()], takes: takes.map((t) => t.qty), after: merge(left) };
}

const total = (r: Row[]) => r.reduce((s, x) => s + x.each * x.count, 0);
const rowText = (r: Row[], w = 'mm') =>
  r.length === 0 ? 'nothing'
    : r.map((x) => `${fmtMmPcs(x.each, x.count, w)}${x.status === 'CUT_PCS' ? ' cut' : ''}`).join(' + ');

/** One plain line: now → taken → left, e.g. "460 mm × 3 pcs  →  take 460 + 10  →  450 mm × 1 pcs cut + 460 mm × 1 pcs = 910 mm". */
export default function OutwardPlan({ groups, amount, unit = 'mm' }: { groups?: LotGroup[]; amount: number; unit?: string }) {
  if (!groups || groups.length === 0 || !(amount > 0)) return null;
  const stock = groups.reduce((s, g) => s + Number(g.piece_qty) * Number(g.pieces), 0);
  if (amount > stock) return null;
  const w = lotUnitWordOfUnit(unit);
  const p = planOutward(groups, amount, w);
  return (
    <div className="rounded-lg border border-line bg-subtle px-3 py-2 text-[15px] text-ink num leading-relaxed">
      <span>{rowText(p.before, w)}</span>
      <span className="mx-2">→</span>
      <span>take {p.takes.map((q) => fmtQty(q)).join(' + ')}</span>
      <span className="mx-2">→</span>
      <span>{rowText(p.after, w)} = <strong>{fmtQty(total(p.after), unit)}</strong></span>
    </div>
  );
}


/* ── MM × PCS rows, each taken from Full Sleeve or Cut Pcs ───────────────────────────────────
 * Same best-fit rule as record_outward_with_lots(): an exact-length piece first, otherwise the
 * smallest piece that is long enough. What is left of a sleeve becomes a Cut Pcs piece.
 * (The database has the final say; this only shows the person what will happen.)
 */
export function planRowsOutward(groups: LotGroup[] | undefined, rows: RollGroup[], w = 'mm') {
  const pool: Piece[] = [];
  for (const g of groups ?? []) for (let i = 0; i < Number(g.pieces); i++) pool.push({ status: g.status, qty: Number(g.piece_qty) });
  const before = merge(pool.map((p) => ({ status: p.status, each: p.qty, count: 1 })));
  const problems: string[] = [];
  const taken: string[] = [];

  for (const r of rows) {
    const src = r.cut ? 'CUT_PCS' : 'FULL_SLEEVE';
    let missing = 0;
    for (let i = 0; i < r.rolls; i++) {
      let best = -1;
      pool.forEach((p, k) => {
        if (p.status !== src || p.qty < r.roll_length) return;
        if (best < 0) { best = k; return; }
        const b = pool[best];
        const exactP = p.qty === r.roll_length, exactB = b.qty === r.roll_length;
        if ((exactP && !exactB) || (exactP === exactB && p.qty < b.qty)) best = k;
      });
      if (best < 0) { missing += 1; continue; }
      const piece = pool[best];
      const rest = piece.qty - r.roll_length;
      if (rest <= 0) pool.splice(best, 1);
      else { piece.qty = rest; piece.status = 'CUT_PCS'; }
    }
    if (missing > 0) {
      problems.push(`${NAME[src]}: no piece of ${fmtQty(r.roll_length)} ${w} or longer left for ${missing} of the ${r.rolls} pcs`
        + ` — try ${src === 'CUT_PCS' ? 'Full Sleeve' : 'Cut Pcs'} or fewer pieces.`);
    } else {
      taken.push(`${fmtMmPcs(r.roll_length, r.rolls, w)} from ${NAME[src]}`);
    }
  }
  const after = merge(pool.map((p) => ({ status: p.status, each: p.qty, count: 1 })));
  return { before, after, problems, taken };
}

/** Preview for a timing-belt outward: what stock looks like now → what is taken → what is left. */
export function OutwardRowsPlan({ groups, rows, unit = 'mm' }: { groups?: LotGroup[]; rows: RollGroup[]; unit?: string }) {
  if (!groups || groups.length === 0 || rows.length === 0) return null;
  const w = lotUnitWordOfUnit(unit);
  const p = planRowsOutward(groups, rows, w);
  if (p.problems.length > 0) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[14px] text-danger space-y-0.5">
        {p.problems.map((t, i) => <p key={i}>{t}</p>)}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-line bg-subtle px-3 py-2 text-[15px] text-ink num leading-relaxed">
      <span>{rowText(p.before, w)}</span>
      <span className="mx-2">→</span>
      <span>take {p.taken.join(' + ')}</span>
      <span className="mx-2">→</span>
      <span>{rowText(p.after, w)} = <strong>{fmtQty(total(p.after), unit)}</strong></span>
    </div>
  );
}
