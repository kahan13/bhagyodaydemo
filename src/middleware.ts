import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const PUBLIC = ['/login', '/no-access', '/manifest.webmanifest', '/sw.js', '/icons', '/offline'];

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Without credentials there is no way to know who is signed in. Let the
  // request through so the page can report the misconfiguration, rather than
  // bouncing the browser between routes.
  if (!url || !anon) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC.some((p) => path === p || path.startsWith(`${p}/`));

  // Redirect responses must carry any refreshed auth cookies, otherwise the
  // browser replays the stale token and never settles on a signed-in state.
  const carry = (target: URL) => {
    const redirect = NextResponse.redirect(target);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    return redirect;
  };

  if (!data.user && !isPublic) {
    const target = request.nextUrl.clone();
    target.pathname = '/login';
    target.search = path === '/' ? '' : `?next=${encodeURIComponent(path)}`;
    return carry(target);
  }

  if (data.user && path === '/login') {
    const target = request.nextUrl.clone();
    target.pathname = '/';
    target.search = '';
    return carry(target);
  }

  return response;
}

// Deliberately narrow: skipping static assets, images and the service worker
// means the auth check runs once per navigation instead of once per file.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest|sw.js|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico|woff2?)$).*)',
  ],
};
