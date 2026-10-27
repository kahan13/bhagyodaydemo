/**
 * Display helpers. Free of server imports so client components can use them.
 * Timestamps always render in IST regardless of device timezone, so a movement
 * recorded on the shop floor reads identically on every screen.
 */

const IST = 'Asia/Kolkata';

export function fmtQty(value: number | string | null | undefined, unit?: string | null): string {
  const n = Number(value ?? 0);
  const text = Number.isInteger(n) ? String(n) : n.toFixed(2);
  if (!unit) return text;
  const u = unit.toUpperCase();
  return `${text} ${u === 'MTR' ? 'm' : u === 'RIB' ? 'ribs' : unit.toLowerCase()}`;
}

/**
 * A minimum-stock (MSL) or reorder figure. Timing belts are stocked in mm but their MSL counts
 * PIECES, so it is shown as "2 pcs"; every other type keeps its own unit.
 */
export function fmtMsl(value: number | string | null | undefined, unit: string | null | undefined, productType?: string | null): string {
  if (productType === 'TIMING_BELT' || productType === 'POLY_V_BELT') return `${Number(value ?? 0)} pcs`;
  return fmtQty(value, unit);
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: IST, day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    timeZone: IST, day: '2-digit', month: 'short', year: 'numeric',
  });
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** "3 min ago" for recent activity, absolute time once it stops being useful. */
export function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} d ago`;
  return fmtDate(iso);
}

export const CHANNEL_LABEL: Record<string, string> = {
  WEB: 'Desktop',
  MOBILE_PWA: 'Phone',
  MOBILE_VOICE: 'Voice',
  IMPORT: 'Import',
  SYSTEM: 'System',
};

/** Three roles. (The codes on the left are what the database stores; people only see the names.) */
export const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Admin',
  MANAGER: 'Accounts',
  VIEWER: 'Workshop',
};

export const TYPE_LABEL: Record<string, string> = {
  INWARD: 'In',
  OUTWARD: 'Out',
  ADJUSTMENT: 'Adjust',
};

export function initials(name: string): string {
  return name.split(' ').filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

/** Strip a trailing ".00" so 470 shows as "470" and 470.5 as "470.5". */
const plain = (n: number): string => (Number.isInteger(n) ? String(n) : String(+n.toFixed(2)));

/**
 * Timing belts are always written MM first, then PCS — "470 mm × 2 pcs".
 * This is the ONE place that wording lives; every screen, message and receipt calls it.
 */
export function fmtMmPcs(
  mm: number | string | null | undefined, pcs: number | string | null | undefined, unitWord = 'mm',
): string {
  return `${plain(Number(mm ?? 0))} ${unitWord} × ${plain(Number(pcs ?? 0))} pcs`;
}

/**
 * A production-order / PO line quantity in plain words:
 *   timing belt typed as MM × PCS → "470 mm × 2 pcs"   (older lines: just the total, "940 mm")
 *   anything else                 → "5 pcs", "12 m"
 */
export function fmtLineQty(
  line: { quantity: number | string; unit_code?: string | null; pieces?: number | null; length_mm?: number | null },
): string {
  const q = Number(line.quantity ?? 0);
  const p = Number(line.pieces ?? 0), l = Number(line.length_mm ?? 0);
  if (p > 0 && l > 0 && p * l === q) return fmtMmPcs(l, p, (line.unit_code ?? '').toUpperCase() === 'RIB' ? 'ribs' : 'mm');
  return fmtQty(q, line.unit_code);
}
