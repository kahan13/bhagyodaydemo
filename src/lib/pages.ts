import type { PageAccess, PageKey, Session } from '@/lib/types';

/**
 * The pages of the daily menu, in menu order, and the address of each.
 * Admin and Accounts see all of them. A Workshop person sees the ones an Admin switched on
 * (Teams & Users → Page access), each either view-only or editable.
 * The Administration group (Product Master, Teams & Users, Import Data, Admin, Activity)
 * is Admin only and is not part of this list.
 */
export const PAGES: { key: PageKey; label: string; href: string; hint: string }[] = [
  { key: 'dashboard',              label: 'Dashboard',                    href: '/',                              hint: 'Stock, orders and recent activity at a glance' },
  { key: 'production_orders',      label: 'Production Order',             href: '/production-orders',             hint: 'Create production orders' },
  { key: 'production_in_progress', label: 'Production Order in Progress', href: '/production-orders/in-progress', hint: 'The inbox of orders to make; edit = mark In Progress / Completed' },
  { key: 'inventory',              label: 'Inventory',                    href: '/inventory',                     hint: 'Book, physical and reorder views; edit = record inward / outward' },
  { key: 'purchase_orders',        label: 'Purchase Orders',              href: '/purchase-orders',               hint: 'Orders to suppliers; edit = create, receive, record inward' },
  { key: 'transactions',           label: 'Transactions',                 href: '/transactions',                  hint: 'The stock ledger; edit = reverse a transaction' },
  { key: 'reports',                label: 'Reports',                      href: '/reports',                       hint: 'Reports; edit = download / export' },
];

export const pageHref = (key: PageKey): string => PAGES.find((p) => p.key === key)?.href ?? '/';

/** 'edit', 'view', or null when the person does not have the page at all. */
export function pageLevel(pages: PageAccess[] | undefined, key: PageKey): 'edit' | 'view' | null {
  const hit = pages?.find((p) => p.page === key);
  return hit ? (hit.can_edit ? 'edit' : 'view') : null;
}

/** Where to send someone who is not allowed on a page: their first page, or the "no pages" notice. */
export function firstPageHref(session: Pick<Session, 'pages'>): string {
  const first = PAGES.find((p) => pageLevel(session.pages, p.key));
  return first ? first.href : '/no-pages';
}
