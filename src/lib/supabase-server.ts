import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

// Server only. In Next 15 cookies() is async, so both helpers are too.

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** Runs under the signed-in user's row level security policies. */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(URL, ANON, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Server component render: middleware refreshes the session instead.
        }
      },
    },
  });
}

/**
 * Service role. Bypasses row level security, so it stays on the server and is
 * used only for maintenance work such as backups.
 */
export async function supabaseService() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  return createServerClient(URL, key, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}
