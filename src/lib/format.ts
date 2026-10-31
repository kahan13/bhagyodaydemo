/**
 * Display helpers. Free of server imports so client components can use them.
 * Timestamps always render in IST regardless of device timezone, so a movement
 * recorded on the shop floor reads identically on every screen.
 */

const IST = 'Asia/Kolkata';

export function fmtQty(value: number | string | null | undefined, unit?: string | null): string {
  const n = Number(value ?? 0);
  if ((unit ?? '').toUpperCase() === 'MM2') return fmtArea(n);
  const text = Number.isInteger(n) ? String(n) : n.toFixed(2);
  if (!unit) return text;
  const u = unit.toUpperCase();
  return `${text} ${u === 'MTR' ? 'm' : u === 'RIB' ? 'ribs' : unit.toLowerCase()}`;
}

/** Open Roll stock is an area kept in square millimetres: shown as sq m ("0.0625 sq m"). */
export function fmtArea(mm2: number | string | null | undefined): string {
  const sqm = Number(mm2 ?? 0) / 1_000_000;
  return `${+sqm.toFixed(4)} sq m`;
}

/** Strip a trailing ".00" (also used by the helpers below). */
const trim = (n: number, d = 3): string => (Number.isInteger(n) ? String(n) : String(+n.toFixed(d)));

/** A length kept in mm, shown in metres: 2500 → "2.5 m". */
export const fmtLenM = (mm: number | string | null | undefined): string => `${trim(Number(mm ?? 0) / 1000)} m`;
/** A width kept in mm: 25 → "25 mm". */
export const fmtWidMm = (mm: number | string | null | undefined): string => `${trim(Number(mm ?? 0), 2)} mm`;
/** The size of one roll or piece, width first as on the stock sheet: "25 mm × 10 m". */
export const fmtRollSize = (widthMm: number | string | null | undefined, lenMm: number | string | null | undefined): string =>
  `${fmtWidMm(widthMm)} × ${fmtLenM(lenMm)}`;
/** What a customer takes: length first — "2.5 m × 25 mm × 4 pcs". */
export const fmtLenWidPcs = (
  lenMm: number | string | null | undefined, widthMm: number | string | null | undefined, pcs: number | string | null | undefined,
): string => `${fmtLenM(lenMm)} × ${fmtWidMm(widthMm)} × ${trim(Number(pcs ?? 0))} pcs`;
/** Rolls on a purchase order or at inward: "25 mm × 10 m × 3 rolls". */
export const fmtRolls = (
  widthMm: number | string | null | undefined, lenMm: number | string | null | undefined, rolls: number | string | null | undefined,
): string => {
  const n = Number(rolls ?? 0);
  return `${fmtRollSize(widthMm, lenMm)} × ${trim(n)} roll${n === 1 ? '' : 's'}`;
};

/**
 * A minimum-stock (MSL) or reorder figure. Timing belts are stocked in mm but their MSL counts
 * PIECES, so it is shown as "2 pcs"; every other type keeps its own unit.
 */
export function fmtMsl(value: number | string | null | undefined, unit: string | null | undefined, productType?: string | null): string {
  if (productType === 'TIMING_BELT' || productType === 'POLY_V_BELT') return `${Number(value ?? 0)} pcs`;
  if (productType === 'OPEN_ROLL') { const n = Number(value ?? 0); return `${n} roll${n === 1 ? '' : 's'}`; }
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
  line: { quantity: number | string; unit_code?: string | null; pieces?: number | null; length_mm?: number | null; width_mm?: number | null },
): string {
  const q = Number(line.quantity ?? 0);
  const p = Number(line.pieces ?? 0), l = Number(line.length_mm ?? 0), w = Number(line.width_mm ?? 0);
  if (w > 0 && p > 0 && l > 0 && p * l * w === q) return fmtLenWidPcs(l, w, p);
  if (p > 0 && l > 0 && p * l === q) return fmtMmPcs(l, p, (line.unit_code ?? '').toUpperCase() === 'RIB' ? 'ribs' : 'mm');
  return fmtQty(q, line.unit_code);
}
