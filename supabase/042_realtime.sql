-- 042 · Live updates between PCs
-- Lets the app hear about changes made on another computer (workshop -> office) and refresh by itself.
-- Safe to run more than once; tables that do not exist are skipped.
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array array[
    'production_orders', 'production_order_items', 'lot_allocations', 'sku_lots', 'skus',
    'inventory_movements', 'purchase_orders', 'purchase_order_items', 'purchase_order_receipts',
    'prod_pending_adjustments'
  ] loop
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = t)
       and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t)
    then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
