'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * The one dialog shell used everywhere.
 *
 *   ┌ header ─ title, close ┐   always visible
 *   │ body                  │   scrolls on its own when the content is taller than the window
 *   └ footer ─ buttons ─────┘   always visible, so Confirm / Create can never be pushed off screen
 *
 * The panel is never taller than the window (dynamic viewport height, so phones with a moving
 * address bar are fine), and the page behind it does not scroll while it is open.
 * Pass `onSubmit` to render the panel as a <form> (Enter submits; the footer's submit button works).
 */

let openCount = 0;

export default function Modal({
  title, icon, onClose, onSubmit, children, footer, width = 'max-w-[460px]', z = 70,
  onBackdrop, bodyClassName = 'p-5 space-y-4', align = 'center',
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  onClose: () => void;
  onSubmit?: (e: React.FormEvent) => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Tailwind max-width class, e.g. max-w-[700px] */
  width?: string;
  z?: 50 | 60 | 70 | 80 | 90;
  /** click on the dimmed area (omit to ignore it, so a stray click never loses typed work) */
  onBackdrop?: () => void;
  bodyClassName?: string;
  align?: 'center' | 'sheet';
}) {
  useEffect(() => {
    openCount += 1;
    if (openCount === 1) document.body.style.overflow = 'hidden';
    return () => {
      openCount -= 1;
      if (openCount <= 0) { openCount = 0; document.body.style.overflow = ''; }
    };
  }, []);

  const zClass = { 50: 'z-50', 60: 'z-[60]', 70: 'z-[70]', 80: 'z-[80]', 90: 'z-[90]' }[z];
  const panelCls =
    `modal-panel w-full ${width} flex flex-col bg-surface border border-line shadow-xl slide-up ` +
    (align === 'sheet' ? 'rounded-t-2xl sm:rounded-xl' : 'rounded-xl');

  const inner = (
    <>
      <div className="card-head border-b shrink-0">
        <h2 className="card-title flex items-center gap-2 min-w-0">{icon}{title}</h2>
        <button type="button" className="btn btn-ghost h-7 w-7 p-0 shrink-0" onClick={onClose} aria-label="Close">
          <X size={15} />
        </button>
      </div>
      <div className={`flex-1 min-h-0 overflow-y-auto overscroll-contain ${bodyClassName}`}>{children}</div>
      {footer && (
        <div className="shrink-0 flex flex-wrap justify-end gap-2 px-5 py-3.5 border-t border-line bg-subtle rounded-b-xl">
          {footer}
        </div>
      )}
    </>
  );

  return (
    <div
      className={`fixed inset-0 ${zClass} grid ${align === 'sheet' ? 'place-items-end sm:place-items-center' : 'place-items-center'} bg-ink/30 backdrop-blur-[2px] p-3 sm:p-4`}
      onMouseDown={(e) => { if (onBackdrop && e.target === e.currentTarget) onBackdrop(); }}
      role="dialog"
      aria-modal="true"
    >
      {onSubmit
        ? <form onSubmit={onSubmit} className={panelCls}>{inner}</form>
        : <div className={panelCls}>{inner}</div>}
    </div>
  );
}
