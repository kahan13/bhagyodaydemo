import type { LotGroup } from '@/lib/types';
import { fmtMmPcs, fmtRollSize } from '@/lib/format';

/** "50 mm × 4 pcs" — how long each piece is, then how many pieces. */
export const groupText = (g: LotGroup, w = 'mm'): string =>
  g.width_mm ? rubberGroupText(g) : fmtMmPcs(g.piece_qty, g.pieces, w);

/** Open Roll: "50 mm × 10 m × 1 cut piece" / "100 mm × 50 m × 2 rolls" / "50 mm × 40 m × 1 partial roll" */
const rubberGroupText = (g: LotGroup): string => {
  const n = Number(g.pieces);
  const word = g.piece_kind === 'CUT_PIECE' ? (n === 1 ? 'cut piece' : 'cut pieces')
    : g.piece_kind === 'PARTIAL_ROLL' ? (n === 1 ? 'partial roll' : 'partial rolls') : (n === 1 ? 'roll' : 'rolls');
  return `${fmtRollSize(g.width_mm, Number(g.piece_qty) / Number(g.width_mm))} × ${n} ${word}`;
};

/** Open Roll stock in words, never as an area: "2 rolls · 1 cut piece · 1 partial roll" */
export const rubberStockText = (groups?: LotGroup[] | null): string => {
  const by: Record<string, number> = {};
  for (const g of groups ?? []) by[g.piece_kind ?? 'ROLL'] = (by[g.piece_kind ?? 'ROLL'] ?? 0) + Number(g.pieces);
  const parts = ([['ROLL', 'roll', 'rolls'], ['CUT_PIECE', 'cut piece', 'cut pieces'], ['PARTIAL_ROLL', 'partial roll', 'partial rolls']] as const)
    .filter(([k]) => by[k]).map(([k, one, many]) => `${by[k]} ${by[k] === 1 ? one : many}`);
  return parts.length ? parts.join(' · ') : 'none';
};

/** One-line form for dropdown rows: "Cut 50 mm × 1 pcs · Full 50 mm × 4 pcs" (cut first). */
export const groupsInline = (groups: LotGroup[], w = 'mm'): string =>
  groups.some((g) => g.width_mm)
    ? [...groups].sort((x, y) => Number(y.width_mm) - Number(x.width_mm) || y.piece_qty - x.piece_qty).map((g) => groupText(g, w)).join(' · ')
    : [...groups]
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'CUT_PCS' ? -1 : 1))
    .map((g) => `${g.status === 'CUT_PCS' ? 'Cut' : 'Full'} ${groupText(g, w)}`)
    .join(' · ');

export const groupLabel = (g: LotGroup): string => g.width_mm ? 'Roll' : (g.status === 'FULL_SLEEVE' ? 'Full Sleeve' : 'Cut Pcs');

/**
 * Each classification of a timing belt's stock on its own line:
 *   ● Cut Pcs      50 mm × 1 pcs
 *   ● Full Sleeve  50 mm × 4 pcs
 * (cut pieces first — they are used first)
 */
export default function LotBreakdown({ groups, className = '', unit = 'mm' }: { groups?: LotGroup[]; className?: string; unit?: string }) {
  if (!groups || groups.length === 0) return null;
  // Open Roll / Rubber: no Full Sleeve / Cut Pcs — just the rolls and leftover pieces, each "width × length"
  if (groups.some((g) => g.width_mm)) {
    return (
      <div className={`space-y-0.5 ${className}`}>
        {[...groups].sort((a, b) => Number(b.width_mm) - Number(a.width_mm) || b.piece_qty - a.piece_qty).map((g) => (
          <div key={`${g.width_mm}-${g.piece_qty}-${g.piece_kind}`} className="flex items-center gap-1.5 text-[13px] leading-tight">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand" />
            <span className="num font-medium">{groupText(g, unit)}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className={`space-y-0.5 ${className}`}>
      {[...groups].sort((a, b) => (a.status === b.status ? 0 : a.status === 'CUT_PCS' ? -1 : 1)).map((g) => (
        <div key={`${g.status}-${g.piece_qty}`} className="flex items-center gap-1.5 text-[13px] leading-tight">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${g.status === 'FULL_SLEEVE' ? 'bg-ok' : 'bg-warn'}`} />
          <span className="text-ink-2 w-[68px] shrink-0">{groupLabel(g)}</span>
          <span className="num font-medium">{groupText(g, unit)}</span>
        </div>
      ))}
    </div>
  );
}
