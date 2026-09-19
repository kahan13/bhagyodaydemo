import { requirePermission } from '@/lib/auth';
import { supabaseServer } from '@/lib/supabase-server';
import TransactionsView from '@/components/transactions/TransactionsView';
import type { Movement } from '@/lib/types';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;
const IST = 5.5 * 60 * 60 * 1000;

/** Named ranges resolved against IST, returned as ISO instants. */
function resolveRange(range: string, from?: string, to?: string) {
  if (range === 'custom' && (from || to)) {
    return {
      start: from ? new Date(`${from}T00:00:00+05:30`).toISOString() : undefined,
      end: to ? new Date(`${to}T23:59:59.999+05:30`).toISOString() : undefined,
    };
  }
  if (range === 'all') return { start: undefined, end: undefined };

  const ist = new Date(Date.now() + IST);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const midnight = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm, dd) - IST);

  const today = midnight(y, m, d);
  const endToday = new Date(today.getTime() + 86_400_000 - 1);

  switch (range) {
    case 'today':
      return { start: today.toISOString(), end: endToday.toISOString() };
    case 'yesterday':
      return {
        start: new Date(today.getTime() - 86_400_000).toISOString(),
        end: new Date(today.getTime() - 1).toISOString(),
      };
    case 'week': {
      const weekday = new Date(today.getTime() + IST).getUTCDay();
      const back = (weekday + 6) % 7; // week starts Monday
      return { start: new Date(today.getTime() - back * 86_400_000).toISOString(), end: endToday.toISOString() };
    }
    case 'year':
      return { start: midnight(y, 0, 1).toISOString(), end: endToday.toISOString() };
    case 'month':
    default:
      return { start: midnight(y, m, 1).toISOString(), end: endToday.toISOString() };
  }
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePermission('transactions.view');
  const sp = await searchParams;
  const db = await supabaseServer();

  const range = sp.range ?? 'month';
  const { start, end } = resolveRange(range, sp.from, sp.to);
  const page = Math.max(1, Number(sp.page ?? 1));

  let q = db
    .from('v_movements')
    .select(
      'id,txn_no,occurred_at,txn_type,txn_mode,quantity,unit_code,previous_stock,new_stock,' +
      'notes,channel,user_name,operated_by_name,invoice_no,sku_code,display_name,product_type,exact_size,' +
      'brand_name,family_code,is_reversed,reversal_of',
      { count: 'exact' },
    )
    .order('occurred_at', { ascending: false });

  if (start) q = q.gte('occurred_at', start);
  if (end) q = q.lte('occurred_at', end);
  if (sp.type) q = q.eq('txn_type', sp.type);
  if (sp.mode) q = q.eq('txn_mode', sp.mode);
  if (sp.product) q = q.eq('product_type', sp.product);
  if (sp.brand) q = q.eq('brand_name', sp.brand);
  if (sp.family) q = q.eq('family_code', sp.family);
  if (sp.user) q = q.eq('user_name', sp.user);
  if (sp.operated_by) q = q.eq('operated_by_name', sp.operated_by);
  if (sp.search) q = q.ilike('display_name', `%${sp.search}%`);

  const [{ data, count, error }, brands, families, users, operators] = await Promise.all([
    q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
    db.from('brands').select('name').eq('is_active', true).order('name'),
    db.from('product_families').select('code').eq('is_active', true).order('code'),
    db.from('app_users').select('full_name').eq('is_active', true).order('full_name'),
    db.from('v_movements').select('operated_by_name').not('operated_by_name', 'is', null).limit(500),
  ]);

  return (
    <TransactionsView
      rows={(data ?? []) as unknown as Movement[]}
      total={count ?? 0}
      page={page}
      pageSize={PAGE_SIZE}
      error={error?.message ?? null}
      canReverse={session.permissions.includes('transactions.reverse')}
      filters={{
        range,
        from: sp.from ?? '', to: sp.to ?? '', type: sp.type ?? '', mode: sp.mode ?? '',
        product: sp.product ?? '', brand: sp.brand ?? '', family: sp.family ?? '',
        user: sp.user ?? '', operated_by: sp.operated_by ?? '', search: sp.search ?? '',
      }}
      facets={{
        brands: (brands.data ?? []).map((b) => b.name as string),
        families: (families.data ?? []).map((f) => f.code as string),
        users: (users.data ?? []).map((u) => u.full_name as string),
        operators: [...new Set((operators.data ?? []).map((r) => (r as { operated_by_name: string }).operated_by_name).filter(Boolean))].sort(),
      }}
    />
  );
}
