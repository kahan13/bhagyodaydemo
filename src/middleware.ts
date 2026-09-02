import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

const PUBLIC_PATHS = ['/login', '/manifest.webmanifest', '/sw.js', '/icons', '/offline'];

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Without credentials there is no way to know who is signed in. Let the
  // request through rather than bouncing it between pages - the page itself
  // will report the missing configuration.
  if (!url || !anon) return NextResponse.next();

  // Supabase may hand us refreshed auth cookies while we check the session.
  // They are collected here so they can be attached to whichever response we
  // end up returning. Dropping them on a redirect is what causes a sign-in
  // loop: the browser keeps replaying the old token and never settles.
  const pending: { name: string; value: string; options: CookieOptions }[] = [];

  const supabase = createServerClient(url, anon, {
    cookies: {
      get: (name: string) => request.cookies.get(name)?.value,
      set: (name: string, value: string, options: CookieOptions) => {
        pending.push({ name, value, options });
      },
      remove: (name: string, options: CookieOptions) => {
        pending.push({ name, value: '', options });
      },
    },
  });

  const { data } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'));

  const withCookies = (response: NextResponse) => {
    for (const c of pending) response.cookies.set({ name: c.name, value: c.value, ...c.options });
    return response;
  };

  if (!data.user && !isPublic) {
    const target = request.nextUrl.clone();
    target.pathname = '/login';
    target.search = path === '/' ? '' : `?next=${encodeURIComponent(path)}`;
    return withCookies(NextResponse.redirect(target));
  }

  if (data.user && path === '/login') {
    const target = request.nextUrl.clone();
    target.pathname = '/';
    target.search = '';
    return withCookies(NextResponse.redirect(target));
  }

  return withCookies(NextResponse.next({ request: { headers: request.headers } }));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$).*)'],
};
