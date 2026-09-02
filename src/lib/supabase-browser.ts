import { createBrowserClient } from '@supabase/ssr';

/**
 * The browser client. Client components must import from here, never from
 * lib/supabase.ts - that one pulls in next/headers, which cannot be bundled
 * for the browser.
 *
 * This only ever sees the anon key. Row level security decides what it is
 * allowed to read, and every write goes through an API route.
 */
export function supabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
