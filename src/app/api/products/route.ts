import { NextResponse } from 'next/server';
import { supabaseServer, supabaseService } from '@/lib/supabase-server';
import { requirePermission } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  await requirePermission('products.view');
  const db = await supabaseServer();
  const { data, error } = await db
    .from('v_sku_status')
    .select('id,sku_code,product_type,display_name,exact_size,hier_l1,hier_l2,hier_l3,brand_code,brand_name,family_code,family_name,unit_code,opening_stock,current_stock,min_stock_level,supplier_moq,reorder_quantity,rack_location,is_active,stock_status')
    .order('product_type').order('hier_l1').order('hier_l2').order('hier_l3');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: Request) {
  await requirePermission('products.create');
  const body = await req.json();
  const svc = await supabaseService();

  // Resolve or create brand
  let { data: brand } = await svc.from('brands').select('id').eq('code', body.brand_code).maybeSingle();
  if (!brand) {
    const { data: nb } = await svc.from('brands').insert({
      code: body.brand_code,
      name: body.brand_name ?? body.brand_code,
      has_timing_belts: body.product_type === 'TIMING_BELT',
      has_v_belts: body.product_type === 'V_BELT',
    }).select('id').single();
    brand = nb;
  }

  // Resolve or create family
  let { data: family } = await svc.from('product_families').select('id').eq('product_type', body.product_type).eq('code', body.family_code).maybeSingle();
  if (!family) {
    const { data: nf } = await svc.from('product_families').insert({
      product_type: body.product_type,
      code: body.family_code,
      name: body.family_name ?? body.family_code,
    }).select('id').single();
    family = nf;
  }

  // Default unit
  let unitCode = body.unit_code ?? 'PCS';
  const { data: unit } = await svc.from('units').select('code').eq('code', unitCode).maybeSingle();
  if (!unit) {
    await svc.from('units').insert({ code: unitCode, name: unitCode, decimals: 0 });
  }

  const hier = body.product_type === 'TIMING_BELT'
    ? { hier_l1: body.family_code, hier_l2: body.exact_size, hier_l3: body.brand_name ?? body.brand_code }
    : { hier_l1: body.family_code, hier_l2: body.exact_size, hier_l3: body.brand_name ?? body.brand_code };

  const { data: sku, error } = await svc.from('skus').insert({
    sku_code: body.sku_code,
    product_type: body.product_type,
    family_id: family!.id,
    brand_id: brand!.id,
    exact_size: body.exact_size,
    display_name: body.display_name || `${body.exact_size} ${body.brand_name ?? body.brand_code}`,
    ...hier,
    search_text: `${body.exact_size} ${body.brand_name ?? body.brand_code} ${body.family_code} ${body.sku_code}`.toLowerCase(),
    unit_code: unitCode,
    opening_stock: body.opening_stock ?? 0,
    current_stock: body.opening_stock ?? 0,
    min_stock_level: body.min_stock_level ?? 0,
    supplier_moq: body.supplier_moq ?? 0,
    reorder_quantity: body.reorder_quantity ?? 0,
    rack_location: body.rack_location || null,
    belt_form: body.belt_form || null,
    pitch_mm: body.pitch_mm || null,
    pitch_length_mm: body.pitch_length_mm || null,
    width_mm: body.width_mm || null,
    teeth: body.teeth || null,
    standard: body.standard || null,
    construction: body.construction || null,
    nominal_length: body.nominal_length || null,
    length_designation: body.length_designation || null,
    is_active: body.is_active ?? true,
  }).select('sku_code').single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ sku_code: sku.sku_code });
}

export async function PATCH(req: Request) {
  await requirePermission('products.edit');
  const body = await req.json();
  const { id, ...fields } = body;
  const svc = await supabaseService();

  // If brand changed, resolve it
  if (fields.brand_code || fields.brand_name) {
    let { data: brand } = await svc.from('brands').select('id').eq('code', fields.brand_code).maybeSingle();
    if (!brand) {
      const { data: nb } = await svc.from('brands').insert({ code: fields.brand_code, name: fields.brand_name ?? fields.brand_code }).select('id').single();
      brand = nb;
    }
    fields.brand_id = brand!.id;
  }

  const update: Record<string, unknown> = {
    exact_size: fields.exact_size,
    display_name: fields.display_name,
    unit_code: fields.unit_code,
    min_stock_level: fields.min_stock_level,
    supplier_moq: fields.supplier_moq,
    reorder_quantity: fields.reorder_quantity,
    rack_location: fields.rack_location || null,
    is_active: fields.is_active,
    belt_form: fields.belt_form || null,
    pitch_mm: fields.pitch_mm || null,
    pitch_length_mm: fields.pitch_length_mm || null,
    width_mm: fields.width_mm || null,
    teeth: fields.teeth || null,
    standard: fields.standard || null,
    construction: fields.construction || null,
    nominal_length: fields.nominal_length || null,
    length_designation: fields.length_designation || null,
    updated_at: new Date().toISOString(),
  };
  if (fields.brand_id) update.brand_id = fields.brand_id;

  const { error } = await svc.from('skus').update(update).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  await requirePermission('products.edit');
  const { id } = await req.json();
  const svc = await supabaseService();
  const { error } = await svc.from('skus').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
