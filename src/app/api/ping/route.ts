/** Tiny "is the server reachable" check used before a background refresh. No data, no database. */
export const dynamic = 'force-dynamic';
export function GET() { return new Response('ok', { status: 200, headers: { 'cache-control': 'no-store' } }); }
export function HEAD() { return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } }); }
