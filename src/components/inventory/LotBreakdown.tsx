import type { LotGroup } from '@/lib/types';
import { fmtQty } from '@/lib/format';

/** "4 × 50 mm" — how many pieces, how long each. */
export const groupText = (g: LotGroup): string => `${g.pieces} × ${fmtQty(g.piece_qty)} mm`;

/** One-line form for dropdown rows: "Cut 1 × 50 mm · Full 4 × 50 mm" (cut first). */
export const groupsInline = (groups: LotGroup[]): string =>
  [...groups]
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'CUT_PCS' ? -1 : 1))
    .map((g) => `${g.status === 'CUT_PCS' ? 'Cut' : 'Full'} ${groupText(g)}`)
    .join(' · ');

export const groupLabel = (g: LotGroup): string => (g.status === 'FULL_SLEEVE' ? 'Full Sleeve' : 'Cut Pcs');

/**
 * Each classification of a timing belt's stock on its own line:
 *   ● Full Sleeve  4 × 50 mm
 *   ● Cut Pcs      1 × 50 mm
 */
export default function LotBreakdown({ groups, className = '' }: { groups?: LotGroup[]; className?: string }) {
  if (!groups || groups.length === 0) return null;
  return (
    <div className={`space-y-0.5 ${className}`}>
      {groups.map((g) => (
        <div key={`${g.status}-${g.piece_qty}`} className="flex items-center gap-1.5 text-[13px] leading-tight">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${g.status === 'FULL_SLEEVE' ? 'bg-ok' : 'bg-warn'}`} />
          <span className="text-ink-2 w-[68px] shrink-0">{groupLabel(g)}</span>
          <span className="num font-medium">{groupText(g)}</span>
        </div>
      ))}
    </div>
  );
}
