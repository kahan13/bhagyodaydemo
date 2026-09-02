/**
 * Display formatting. Deliberately free of server imports so both the web app
 * and the mobile PWA client components can use it.
 *
 * All timestamps are rendered in IST regardless of the device timezone, so a
 * movement recorded on the shop floor reads the same on every screen.
 */

const IST = 'Asia/Kolkata';

export function fmtQty(value: number | string | null | undefined, unit?: string): string {
  const n = Number(value ?? 0);
  const text = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return unit ? `${text} ${unit.toLowerCase() === 'mtr' ? 'm' : unit.toLowerCase()}` : text;
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
    timeZone: IST, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/** Where a movement was recorded. Shown on every transaction row. */
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
  INVENTORY_OPERATOR: 'Inventory Operator',
  VIEWER: 'Viewer',
};
