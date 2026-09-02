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
  return `${text} ${unit.toUpperCase() === 'MTR' ? 'm' : unit.toLowerCase()}`;
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

export const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  MANAGER: 'Manager',
  INVENTORY_OPERATOR: 'Operator',
  VIEWER: 'Viewer',
};

export const TYPE_LABEL: Record<string, string> = {
  INWARD: 'In',
  OUTWARD: 'Out',
  ADJUSTMENT: 'Adjust',
};

export function initials(name: string): string {
  return name.split(' ').filter(Boolean).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}
