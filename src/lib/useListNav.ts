'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keyboard control for a search box + dropdown list.
 *   ↓ / ↑   move through the results (↓ also opens a closed list)
 *   Enter   picks the highlighted result
 *   Esc     closes the list
 * Put `data-nav-idx={i}` on each row (and `aria-selected` / a highlight class from `cursor`)
 * and attach `listRef` to the scrolling container so the highlighted row stays in view.
 *
 * `isDisabled(i)` lets a row (e.g. an already-added product) be skipped.
 */
export function useListNav<T extends HTMLElement = HTMLDivElement>({
  count, open, setOpen, onPick, isDisabled,
}: {
  count: number;
  open: boolean;
  setOpen: (v: boolean) => void;
  onPick: (index: number) => void;
  isDisabled?: (index: number) => boolean;
}) {
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<T>(null);

  // new results -> start at the top
  useEffect(() => { setCursor(0); }, [count]);

  // keep the highlighted row visible
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-nav-idx="${cursor}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open, count]);

  const step = useCallback((from: number, dir: 1 | -1) => {
    if (count === 0) return 0;
    let i = from;
    for (let n = 0; n < count; n++) {
      i = (i + dir + count) % count;
      if (!isDisabled?.(i)) return i;
    }
    return from;
  }, [count, isDisabled]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setCursor((c) => (isDisabled?.(c) && c === 0 ? step(c, 1) : step(c, 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setCursor((c) => step(c, -1));
    } else if (e.key === 'Enter') {
      if (open && count > 0 && !isDisabled?.(cursor)) {
        e.preventDefault();
        e.stopPropagation();
        onPick(cursor);
      }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    }
  }, [open, count, cursor, isDisabled, onPick, setOpen, step]);

  return { cursor, setCursor, onKeyDown, listRef };
}
