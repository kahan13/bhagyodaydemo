/**
 * Single source of truth for keyboard shortcuts — the help dialog (press ?) and
 * the Shortcuts page both read this list, and the shell binds from the same keys.
 *
 * Chosen so they never fight Windows or Chrome: no Ctrl/Alt/Win combinations
 * (Chrome owns Ctrl+T/W/N/L/D/…, Alt+Left/Home/D, Windows owns Win+…). Navigation uses
 * two plain keys in a row ("g" then a letter), like Gmail. They are ignored while you
 * are typing in a box, so they never interfere with data entry.
 */
export interface ShortcutGroup { title: string; items: { keys: string[]; label: string; then?: boolean }[] }

export const GO_KEYS: Record<string, { href: string; label: string }> = {
  d: { href: '/',                  label: 'Dashboard' },
  i: { href: '/inventory',         label: 'Inventory' },
  m: { href: '/products',          label: 'Product Master' },
  t: { href: '/transactions',      label: 'Transactions' },
  p: { href: '/purchase-orders',   label: 'Purchase Orders' },
  o: { href: '/production-orders', label: 'Production Orders' },
  r: { href: '/reports',           label: 'Reports' },
  u: { href: '/admin/team',        label: 'Teams & Users' },
  e: { href: '/admin/import',      label: 'Import Data' },
  a: { href: '/admin',             label: 'Admin (incl. Clear data)' },
  l: { href: '/admin/activity',    label: 'Activity log' },
  k: { href: '/shortcuts',         label: 'Keyboard shortcuts page' },
};

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Go to a page  (press g, then the letter)',
    items: Object.entries(GO_KEYS).map(([k, v]) => ({ keys: ['g', k], label: v.label, then: true })),
  },
  {
    title: 'Anywhere',
    items: [
      { keys: ['/'], label: 'Jump to the search box (or open search)' },
      { keys: ['Ctrl', 'K'], label: 'Open quick search' },
      { keys: ['?'], label: 'Show this shortcut list' },
      { keys: ['Esc'], label: 'Close the open window / dropdown' },
    ],
  },
  {
    title: 'Actions on a page',
    items: [
      { keys: ['i'], label: 'Dashboard: record Inward' },
      { keys: ['o'], label: 'Dashboard: record Outward' },
      { keys: ['n'], label: 'Purchase / Production Orders: new order' },
    ],
  },
  {
    title: 'Search lists and forms',
    items: [
      { keys: ['↓'], label: 'Open the result list / move down' },
      { keys: ['↑'], label: 'Move up' },
      { keys: ['Enter'], label: 'Pick the highlighted result / confirm the form' },
      { keys: ['Tab'], label: 'Next field' },
      { keys: ['Shift', 'Tab'], label: 'Previous field' },
    ],
  },
];
