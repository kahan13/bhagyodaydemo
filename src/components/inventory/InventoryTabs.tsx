import Link from 'next/link';

/**
 * The three views of Inventory, as links so each has its own address:
 *   Book           what the ledger says (drops when an outward is recorded)
 *   Physical       what is physically on the shelf (drops as soon as a production order is made)
 *   Needs reordering  products below their minimum stock level, with a tick-off for "PO raised"
 */
export type InventoryView = 'book' | 'physical' | 'reorder';

const ITEMS: { id: InventoryView; label: string; href: string; kt: string }[] = [
  { id: 'book',     label: 'Book inventory',     href: '/inventory',               kt: 'I' },
  { id: 'physical', label: 'Physical inventory', href: '/inventory?view=physical', kt: 'Y' },
  { id: 'reorder',  label: 'Needs reordering',   href: '/inventory?view=reorder',  kt: 'R' },
];

export default function InventoryTabs({ current }: { current: InventoryView }) {
  return (
    <nav aria-label="Inventory views" className="inline-flex rounded-lg border border-line bg-subtle p-0.5">
      {ITEMS.map((it) => (
        <Link
          key={it.id}
          href={it.href}
          data-kt={it.kt}
          data-kt-label={it.label}
          aria-current={current === it.id ? 'page' : undefined}
          className={`px-3 py-1 rounded-md text-[14px] font-medium transition-colors whitespace-nowrap ${
            current === it.id ? 'bg-surface shadow-sm text-ink' : 'text-ink-3 hover:text-ink'
          }`}
        >{it.label}</Link>
      ))}
    </nav>
  );
}
