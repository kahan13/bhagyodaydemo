import { NextResponse } from 'next/server';
import { supabaseService } from '@/lib/supabase-server';
import { requirePermission } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const COMPANY_FIELDS = ['name', 'address', 'phone', 'email', 'gstin'] as const;

/**
 * Settings that can be changed from the app. Anything else is refused, so this endpoint can never be used
 * to overwrite system rows (such as the data source).
 */
function clean(key: string, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (key === 'company') {
    if (!value || typeof value !== 'object') return { ok: false, error: 'Company details are missing.' };
    const v = value as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const f of COMPANY_FIELDS) out[f] = String(v[f] ?? '').trim().slice(0, f === 'address' ? 300 : 120);
    if (!out.name) return { ok: false, error: 'Enter the company name.' };
    if (out.email && !/^\S+@\S+\.\S+$/.test(out.email)) return { ok: false, error: 'That email address does not look right.' };
    return { ok: true, value: out };
  }
  if (key === 'default_whatsapp_number') {
    const n = String(value ?? '').trim();
    if (n && !/^\+?[0-9][0-9 ()-]{5,19}$/.test(n)) return { ok: false, error: 'Enter the WhatsApp number with digits only, e.g. +91 98765 43210.' };
    return { ok: true, value: n };
  }
  if (key === 'allow_negative_stock') {
    return { ok: true, value: { enabled: Boolean((value as { enabled?: unknown } | null)?.enabled) } };
  }
  return { ok: false, error: 'That setting cannot be changed here.' };
}

export async function POST(req: Request) {
  await requirePermission('settings.edit');
  let body: { key?: string; value?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Send a JSON body.' }, { status: 400 }); }
  const key = String(body.key ?? '');
  if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });

  const checked = clean(key, body.value);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  const svc = await supabaseService();
  const { error } = await svc
    .from('app_settings')
    .upsert({ key, value: checked.value, updated_at: new Date().toISOString() }, { onConflict: 'key' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, value: checked.value });
}
