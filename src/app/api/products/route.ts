import { supabaseService } from '@/lib/supabase-server';
import { NextResponse } from 'next/server';

export async function GET() {
  const { data: products, error } = await supabaseService
    .from('products')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ products: products || [] });
}

export async function POST(req: Request) {
  const body = await req.json();

  if (Array.isArray(body)) {
    const { data, error } = await supabaseService
      .from('products')
      .upsert(body, { onConflict: 'sku' })
      .select();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ count: data?.length });
  }

  const { data, error } = await supabaseService
    .from('products')
    .insert([body])
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ product: data });
}

export async function PUT(req: Request) {
  const { id, ...updates } = await req.json();
  const { data, error } = await supabaseService
    .from('products')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ product: data });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { error } = await supabaseService.from('products').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
