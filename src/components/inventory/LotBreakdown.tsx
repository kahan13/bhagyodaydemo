import type { LotGroup } from '@/lib/types';
import { fmtMmPcs } from '@/lib/format';

/** "50 mm × 4 pcs" — how long each piece is, then how many pieces. */
export const groupText = (g: LotGroup, w = 'mm'): string => fmtMmPcs(g.piece_qty, g.pieces, w);

/** One-line form for dropdown rows: "Cut 50 mm × 1 pcs · Full 50 mm × 4 pcs" (cut first). */
export const groupsInline = (groups: LotGroup[], w = 'mm'): string =>
  [...groups]
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'CUT_PCS' ? -1 : 1))
    .map((g) => `${g.status === 'CUT_PCS' ? 'Cut' : 'Full'} ${groupText(g, w)}`)
    .join(' · ');

export const groupLabel = (g: LotGroup): string => (g.status === 'FULL_SLEEVE' ? 'Full Sleeve' : 'Cut Pcs');

/**
 * Each classification of a timing belt's stock on its own line:
 *   ● Cut Pcs      50 mm × 1 pcs
 *   ● Full Sleeve  50 mm × 4 pcs
 * (cut pieces first — they are used first)
 */
export default function LotBreakdown({ groups, className = '', unit = 'mm' }: { groups?: LotGroup[]; className?: string; unit?: string }) {
  if (!groups || groups.length === 0) return null;
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
