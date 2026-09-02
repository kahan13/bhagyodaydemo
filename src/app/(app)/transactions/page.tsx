import { requirePermission } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase';
import TransactionsView from '@/components/transactions/TransactionsView';
import type { Movement } from '@/lib/types';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const IST_OFFSET = 5.5 * 60 * 60 * 1000;

/** Start/end of a named range, expressed in IST and returned as ISO instants. */
function resolveRange(range: string, from?: string, to?: string) {
  if (range === 'custom' && (from || to)) {
    return {
      start: from ? new Date(`${from}T00:00:00+05:30`).toISOString() : undefined,
      end: to ? new Date(`${to}T23:59:59.999+05:30`).toISOString() : undefined,
    };
  }

  const istNow = new Date(Date.now() + IST_OFFSET);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();
  const istMidnight = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd) - IST_OFFSET);

  const startOfToday = istMidnight(y, m, d);
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000 - 1);

  switch (range) {
    case 'today':
      return { start: startOfToday.toISOString(), end: endOfToday.toISOString() };
    case 'yesterday': {
      const s = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
      return { start: s.toISOString(), end: new Date(startOfToday.getTime() - 1).toISOString() };
    }
    case 'week': {
      const weekday = new Date(startOfToday.getTime() + IST_OFFSET).getUTCDay(); // 0 = Sunday
      const back = (weekday + 6) % 7;                                            // week starts Monday
      return {
        start: new Date(startOfToday.getTime() - back * 24 * 60 * 60 * 1000).toISOString(),
        end: endOfToday.toISOString(),
      };
    }
    case 'month':
      return { start: istMidnight(y, m, 1).toISOString(), end: endOfToday.toISOString() };
    case 'year':
      return { start: istMidnight(y, 0, 1).toISOString(), end: endOfToday.toISOString() };
    default:
      return { start: undefined, end: undefined };
  }
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const session = await requirePermission('transactions.view');
  const db = supabaseServer();

  const range = searchParams.range ?? 'month';
  const { start, end } = resolveRange(range, searchParams.from, searchParams.to);
  const page = Math.max(1, Number(searchParams.page ?? 1));

  let q = db
    .from('v_movements')
    .select(
      'id, txn_no, occurred_at, txn_type, txn_mode, quantity, unit_code, previous_stock, new_stock, reference, notes, channel, user_name, sku_code, display_name, product_type, exact_size, brand_name, family_code, is_reversed, reversal_of',
      { count: 'exact' },
    )
    .order('occurred_at', { ascending: false });

  if (start) q = q.gte('occurred_at', start);
  if (end) q = q.lte('occurred_at', end);
  if (searchParams.type) q = q.eq('txn_type', searchParams.type);
  if (searchParams.mode) q = q.eq('txn_mode', searchParams.mode);
  if (searchParams.product) q = q.eq('product_type', searchParams.product);
  if (searchParams.brand) q = q.eq('brand_name', searchParams.brand);
  if (searchParams.family) q = q.eq('family_code', searchParams.family);
  if (searchParams.user) q = q.eq('user_name', searchParams.user);
  if (searchParams.channel) q = q.eq('channel', searchParams.channel);
  if (searchParams.sku) q = q.ilike('display_name', `%${searchParams.sku}%`);

  const { data, count, error } = await q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  // filter choices come from the data, so they follow whatever master file was imported
  const [{ data: brands }, { data: families }, { data: users }] = await Promise.all([
    db.from('brands').select('name').eq('is_active', true).order('name'),
    db.from('product_families').select('code, product_type').eq('is_active', true).order('code'),
    db.from('app_users').select('full_name').eq('is_active', true).order('full_name'),
  ]);

  return (
    <TransactionsView
      rows={(data ?? []) as Movement[]}
      total={count ?? 0}
      page={page}
      pageSize={PAGE_SIZE}
      error={error?.message ?? null}
      canReverse={session.permissions.includes('transactions.reverse')}
      filters={{
        range,
        from: searchParams.from ?? '',
        to: searchParams.to ?? '',
        type: searchParams.type ?? '',
        mode: searchParams.mode ?? '',
        product: searchParams.product ?? '',
        brand: searchParams.brand ?? '',
        family: searchParams.family ?? '',
        user: searchParams.user ?? '',
        channel: searchParams.channel ?? '',
        sku: searchParams.sku ?? '',
      }}
      facets={{
        brands: (brands ?? []).map((b) => b.name),
        families: (families ?? []).map((f) => f.code),
        users: (users ?? []).map((u) => u.full_name),
      }}
    />
  );
}
