import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

// Server side only. Client components must use lib/supabase-browser.ts instead.

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Bound to the signed-in user's cookies, so every query runs under that
 * user's row level security policies. Cookie writes are ignored during a
 * server component render; middleware refreshes the session instead.
 */
export function supabaseServer() {
  const store = cookies();
  return createServerClient(URL, ANON, {
    cookies: {
      get: (name: string) => store.get(name)?.value,
      set: (name: string, value: string, options: CookieOptions) => {
        try {
          store.set({ name, value, ...options });
        } catch {
          /* server component render - middleware handles the refresh */
        }
      },
      remove: (name: string, options: CookieOptions) => {
        try {
          store.set({ name, value: '', ...options });
        } catch {
          /* as above */
        }
      },
    },
  });
}

/**
 * Service-role client. Bypasses row level security, so it is limited to
 * server-side maintenance work such as backups and admin-triggered imports.
 * Never import this from a client component.
 */
export function supabaseService() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createServerClient(URL, key, {
    cookies: { get: () => undefined, set: () => {}, remove: () => {} },
  });
}
