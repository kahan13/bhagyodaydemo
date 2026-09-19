import { NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase-server';
import { requirePermission } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  await requirePermission('settings.edit');
  const { key, value } = await req.json();
  if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });

  const svc = await supabaseService();
  const { error } = await svc
    .from('app_settings')
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
