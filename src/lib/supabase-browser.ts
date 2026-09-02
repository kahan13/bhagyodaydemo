import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser client. Client components import from here only — the server module
 * pulls in next/headers, which cannot be bundled for the browser.
 *
 * The instance is cached so every component shares one connection and one
 * auth listener instead of opening a new client on each render.
 */
let client: ReturnType<typeof createBrowserClient> | null = null;

export function supabaseBrowser() {
  if (!client) {
    client = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
  }
  return client;
}
