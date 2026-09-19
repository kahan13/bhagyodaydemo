import { supabaseService } from '@/lib/supabase-server';
import { NextResponse } from 'next/server';

export async function GET() {
  const { data } = await supabaseService
    .from('product_column_configs')
    .select('columns')
    .eq('id', 'default')
    .single();

  return NextResponse.json({ columns: data?.columns || null });
}

export async function POST(req: Request) {
  const { columns } = await req.json();

  const { data, error } = await supabaseService
    .from('product_column_configs')
    .upsert({ id: 'default', columns, updated_at: new Date().toISOString() })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ columns: data.columns });
}
