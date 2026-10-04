import type { LotGroup } from '@/lib/types';
import { fmtQty } from '@/lib/format';

type Piece = { status: 'CUT_PCS' | 'FULL_SLEEVE'; qty: number };
type Row = { status: 'CUT_PCS' | 'FULL_SLEEVE'; each: number; count: number };

const NAME = { CUT_PCS: 'Cut Pcs', FULL_SLEEVE: 'Full Sleeve' } as const;
const tone = (s: string) => (s === 'CUT_PCS' ? 'text-[#d96a00]' : 'text-[#008a3e]');

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
  return { before: merge(before), take: [...lines.values()], after: merge(left) };
}

const total = (r: Row[]) => r.reduce((s, x) => s + x.each * x.count, 0);

function RowsView({ rows }: { rows: Row[] }) {
  if (rows.length === 0) return <p className="text-[14px] text-ink-2">nothing left</p>;
  return (
    <>
      {rows.map((r) => (
        <p key={r.status + r.each} className={`num text-[15px] font-semibold ${tone(r.status)}`}>
          {r.count} × {fmtQty(r.each)} mm {NAME[r.status]}
        </p>
      ))}
    </>
  );
}

export default function OutwardPlan({ groups, amount, unit = 'mm' }: { groups?: LotGroup[]; amount: number; unit?: string }) {
  if (!groups || groups.length === 0 || !(amount > 0)) return null;
  const stock = groups.reduce((s, g) => s + Number(g.piece_qty) * Number(g.pieces), 0);
  if (amount > stock) return null;
  const p = planOutward(groups, amount);
  return (
    <div className="rounded-lg border-2 border-[#c9d3ff] bg-white p-3 space-y-3 text-[15px]">
      <p className="text-[13px] font-bold text-[#1646d6] uppercase tracking-wide">How this outward is taken</p>
      <div className="grid sm:grid-cols-3 gap-3">
        <div>
          <p className="text-[13px] font-semibold text-ink-2 mb-0.5">Now in stock</p>
          <RowsView rows={p.before} />
          <p className="num text-[14px] font-bold text-[#6a1fd1] mt-0.5">Total {fmtQty(total(p.before), unit)}</p>
        </div>
        <div>
          <p className="text-[13px] font-semibold text-ink-2 mb-0.5">This outward uses</p>
          {p.take.map((t) => (
            <p key={t.text} className="num text-[15px] font-semibold text-[#d6141f]">
              {t.n > 1 ? `${t.n} × ` : ''}{t.text}
            </p>
          ))}
          <p className="num text-[14px] font-bold text-[#d6141f] mt-0.5">Total −{fmtQty(amount, unit)}</p>
        </div>
        <div>
          <p className="text-[13px] font-semibold text-ink-2 mb-0.5">Remaining after</p>
          <RowsView rows={p.after} />
          <p className="num text-[14px] font-bold text-[#6a1fd1] mt-0.5">Total {fmtQty(total(p.after), unit)}</p>
        </div>
      </div>
    </div>
  );
}
