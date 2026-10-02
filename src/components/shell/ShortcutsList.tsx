import { SHORTCUT_GROUPS } from '@/lib/shortcuts';

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-block min-w-[22px] text-center text-[13px] px-1.5 py-0.5 rounded border border-line bg-subtle text-ink-2 font-mono">
      {children}
    </kbd>
  );
}

export default function ShortcutsList() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {SHORTCUT_GROUPS.map((g) => (
        <section key={g.title} className="card p-4">
          <h3 className="text-[14px] font-semibold text-ink-2 mb-2.5">{g.title}</h3>
          <ul className="space-y-1.5">
            {g.items.map((it, i) => (
              <li key={i} className="flex items-center justify-between gap-3 text-[15px]">
                <span className="text-ink-2">{it.label}</span>
                <span className="flex items-center gap-1 shrink-0">
                  {it.keys.map((k, j) => (
                    <span key={j} className="flex items-center gap-1">
                      {j > 0 && <span className="text-[12px] text-ink-3">{it.then ? 'then' : '+'}</span>}
                      <Kbd>{k}</Kbd>
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
