'use client';

import { useEffect, useState } from 'react';

/**
 * Last line of defence. A dropped connection during a background refresh must never leave a dead
 * "Application error" page: show a calm message and try again by itself until the network is back.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [tries, setTries] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { setTries((n) => n + 1); return; }
      setTries((n) => n + 1);
      if (tries >= 3) window.location.reload(); else reset();
    }, 2500);
    return () => clearTimeout(t);
  }, [tries, reset]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f7f8fa', color: '#1b1d22' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
          <div>
            <p style={{ fontSize: 18, fontWeight: 600, margin: '0 0 6px' }}>Connection lost — reconnecting…</p>
            <p style={{ fontSize: 14, color: '#6b7280', margin: '0 0 16px' }}>Nothing is lost. This page will come back by itself.</p>
            <button onClick={() => window.location.reload()} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #d4d7de', background: '#fff', cursor: 'pointer', fontSize: 14 }}>
              Reload now
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
