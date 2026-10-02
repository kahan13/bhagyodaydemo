import { NextResponse } from 'next/server';
import { supabaseServer, supabaseService } from '@/lib/supabase-server';
import { requirePermission } from '@/lib/auth';
import type { ProductType } from '@/lib/types';
import { PRODUCT_TYPES, buildIdentity, isIdentityError, uniqueSkuCode } from '@/lib/sheet-config';
import { ensureBrandsAndFamilies, loadAllSkus, newSkuRow } from '@/lib/sheet-import-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  await requirePermission('products.view');
  const db = await supabaseServer();
  const { data, error } = await db
    .from('v_sku_status')
    .select('id,sku_code,product_type,display_name,exact_size,hier_l1,hier_l2,hier_l3,brand_code,brand_name,family_code,family_name,section,colour,length_mm,width_mm,thickness_mm,remarks,created_via,unit_code,current_stock,min_stock_level,rack_location,is_active,stock_status,roll_length_mm')
    .order('product_type').order('hier_l1').order('hier_l2').order('hier_l3');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * Add one product by hand. Takes the same identity fields as the Products import,
 * generates the SKU code automatically, and refuses a product that already exists
 * (so a manual add and a later sheet import can never create twins).
 */
export async function POST(req: Request) {
  await requirePermission('products.create');
  const body = await req.json();
  const type = body.product_type as ProductType;
  if (!PRODUCT_TYPES.includes(type)) return NextResponse.json({ error: 'Choose a product type.' }, { status: 400 });

  const built = buildIdentity(type, {
    family: body.family, section: body.section, size: body.size, colour: body.colour, brand: body.brand,
    length: body.length, width: body.width, thickness: body.thickness,
  });
  if (isIdentityError(built)) return NextResponse.json({ error: built.error }, { status: 400 });

  const svc = await supabaseService();
  const all = await loadAllSkus(svc);
  const twin = all.find((s) => s.product_type === type && s.identity_key === built.key);
  if (twin) {
    return NextResponse.json({ error: `This product already exists as ${twin.sku_code}.` }, { status: 409 });
  }

  const code = uniqueSkuCode(built, new Set(all.map((s) => s.sku_code)));
  try {
    const { brandId, familyId } = await ensureBrandsAndFamilies(svc, type, [built]);
    const row = {
      ...newSkuRow(built, code, familyId.get(built.family)!, brandId.get(built.brand)!, 'MANUAL'),
      min_stock_level: Number(body.min_stock_level) || 0,
      roll_length_mm: type === 'TIMING_BELT' ? (Number(body.roll_length_mm) || null) : null,
      rack_location: body.rack_location || null,
      remarks: body.remarks || null,
    };
    const { error } = await svc.from('skus').insert(row);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
  return NextResponse.json({ sku_code: code });
}

/** Edit the non-identity fields of a product. Only the fields you send are changed. */
export async function PATCH(req: Request) {
  await requirePermission('products.edit');
  const body = await req.json();
  const { id } = body;
  if (!id) return NextResponse.json({ error: 'Missing product id.' }, { status: 400 });

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ('display_name' in body) update.display_name = body.display_name || null;
  if ('min_stock_level' in body) update.min_stock_level = Number(body.min_stock_level) || 0;
  if ('roll_length_mm' in body) update.roll_length_mm = Number(body.roll_length_mm) || null;
  if ('rack_location' in body) update.rack_location = body.rack_location || null;
  if ('remarks' in body) update.remarks = body.remarks || null;
  if ('is_active' in body) update.is_active = !!body.is_active;
  if (update.display_name === null) delete update.display_name; // column is NOT NULL

  const svc = await supabaseService();
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
