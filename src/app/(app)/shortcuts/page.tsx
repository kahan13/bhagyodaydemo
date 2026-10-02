import ShortcutsList from '@/components/shell/ShortcutsList';

export const metadata = { title: 'Keyboard shortcuts' };

export default function ShortcutsPage() {
  return (
    <div className="p-4 lg:p-6 max-w-[960px] mx-auto space-y-4">
      <div>
        <h1 className="text-[19px] font-semibold">Keyboard shortcuts</h1>
        <p className="text-[15px] text-ink-3 mt-1">
          Work without the mouse. Shortcuts are ignored while you type in a box. Press <kbd className="px-1 rounded border border-line bg-subtle font-mono text-[13px]">?</kbd> on any page to see this list.
        </p>
      </div>
      <ShortcutsList />
    </div>
  );
}
