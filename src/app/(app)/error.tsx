'use client';

import { useEffect, useRef } from 'react';

/** A page failed to draw (usually a dropped connection): retry quietly a few times, then offer a button. */
export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const tries = useRef(0);
  useEffect(() => {
    if (tries.current >= 3) return;
    const t = setTimeout(() => { tries.current += 1; reset(); }, 2500);
    return () => clearTimeout(t);
  }, [reset]);

  return (
    <div className="p-8 text-center">
      <p className="text-[16px] font-semibold text-ink">Couldn&apos;t load this page — trying again…</p>
      <p className="text-[14px] text-ink-3 mt-1">Check the internet connection if this stays.</p>
      <button type="button" className="btn btn-secondary mt-4" onClick={() => reset()}>Try again</button>
    </div>
  );
}
