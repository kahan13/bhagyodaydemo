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
  o: { href: '/production-orders', label: 'Production Order' },
  w: { href: '/production-orders/in-progress', label: 'Production Order in Progress' },
  i: { href: '/inventory',         label: 'Inventory' },
  p: { href: '/purchase-orders',   label: 'Purchase Orders' },
  t: { href: '/transactions',      label: 'Transactions' },
  r: { href: '/reports',           label: 'Reports' },
  m: { href: '/products',          label: 'Product Master (Administration)' },
  u: { href: '/admin/team',        label: 'Teams & Users' },
  e: { href: '/admin/import',      label: 'Import Data' },
  a: { href: '/admin',             label: 'Admin (incl. Clear data)' },
  l: { href: '/admin/activity',    label: 'Activity log' },
  k: { href: '/shortcuts',         label: 'Keyboard shortcuts page' },
};

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Excel-style key tips  (press Alt+M, then the letters)',
    items: [
      { keys: ['Alt', 'M'], label: 'Open key tips — shows this page\'s own keys too' },
      { keys: ['D'], label: 'Dashboard' },
      { keys: ['P', 'R'], label: 'Production Order', then: true },
      { keys: ['P', 'I'], label: 'Production Order in Progress', then: true },
      { keys: ['I'], label: 'Inventory' },
      { keys: ['P', 'U'], label: 'Purchase Orders', then: true },
      { keys: ['T'], label: 'Transactions' },
      { keys: ['R'], label: 'Reports' },
      { keys: ['I', 'N'], label: 'Record Inward', then: true },
      { keys: ['O'], label: 'Record Outward' },
      { keys: ['O', 'R'], label: 'New order', then: true },
    ],
  },
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
      { keys: ['n'], label: 'Purchase Orders / Production Order: new order (cursor goes to the first box)' },
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
