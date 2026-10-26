import { NextResponse } from 'next/server';
import { supabaseServer, supabaseService } from '@/lib/supabase-server';
import { requirePermission } from '@/lib/auth';
import type { ProductType } from '@/lib/types';
import { PRODUCT_TYPES, UNSPECIFIED, buildIdentity, isIdentityError, uniqueSkuCode } from '@/lib/sheet-config';
import { ensureBrandsAndFamilies, loadAllSkus, newSkuRow } from '@/lib/sheet-import-server';

export const dynamic = 'force-dynamic';

export async function GET() {
  await requirePermission('products.view');
  const db = await supabaseServer();
  const { data, error } = await db
    .from('v_sku_status')
    .select('id,sku_code,product_type,display_name,exact_size,hier_l1,hier_l2,hier_l3,brand_code,brand_name,family_code,family_name,section,colour,length_mm,width_mm,thickness_mm,remarks,created_via,unit_code,current_stock,min_stock_level,rack_location,is_active,stock_status,stock_pieces,missing_fields')
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

  // Optional existing inventory. Timing belts: MM × PCS rows, each Full Sleeve (cut:false) or Cut Pcs (cut:true).
  // Other products: a plain quantity.
  const opening = body.opening as { rows?: { rolls?: unknown; roll_length?: unknown; cut?: unknown }[]; qty?: unknown } | undefined;
  const openRows = type === 'TIMING_BELT' && Array.isArray(opening?.rows)
    ? opening!.rows!
        .map((r) => ({ rolls: Math.floor(Number(r.rolls)), roll_length: Number(r.roll_length), cut: r.cut === true }))
        .filter((r) => r.rolls > 0 && r.roll_length > 0)
    : [];
  const openQty = type !== 'TIMING_BELT' ? Math.max(0, Number(opening?.qty) || 0) : 0;
  const totalPieces = openRows.reduce((a, r) => a + r.rolls, 0);
  if (totalPieces > 500)
    return NextResponse.json({ error: 'That is more than 500 pieces in one go. Add the product, then use Import Data → 2 · Inventory for large loads.' }, { status: 400 });

  const code = uniqueSkuCode(built, new Set(all.map((s) => s.sku_code)));
  try {
    const { brandId, familyId } = await ensureBrandsAndFamilies(svc, type, [built]);
    const row = {
      ...newSkuRow(built, code, familyId.get(built.family)!, brandId.get(built.brand)!, 'MANUAL'),
      min_stock_level: Number(body.min_stock_level) || 0,
      rack_location: body.rack_location || null,
      remarks: body.remarks || null,
    };
    const { data: created, error } = await svc.from('skus').insert(row).select('id').single();
    if (error || !created) return NextResponse.json({ error: error?.message ?? 'Could not add the product.' }, { status: 400 });

    // Load the existing inventory the same way the inventory import does: one lot per piece,
    // then book and physical stock set to the same total.
    let added = 0;
    if (openRows.length > 0 || openQty > 0) {
      const undo = async (message: string) => {
        await svc.from('sku_lots').delete().eq('sku_id', created.id);
        await svc.from('skus').delete().eq('id', created.id);
        return NextResponse.json({ error: `${message} The product was not added — nothing was saved.` }, { status: 400 });
      };
      for (const r of openRows) {
        for (let n = 0; n < r.rolls; n++) {
          const { error: lotErr } = await svc.rpc('create_opening_lot', {
            p_sku_id: created.id,
            p_qty: r.roll_length,
            p_status: r.cut ? 'CUT_PCS' : 'FULL_SLEEVE',
            p_roll_length: r.roll_length,
            p_notes: 'Opening stock (added in Product Master)',
          });
          if (lotErr) return undo(`Existing inventory failed: ${lotErr.message}.`);
          added += r.roll_length;
        }
      }
      added += openQty;
      const { error: stockErr } = await svc.from('skus')
        .update({ current_stock: added, physical_prod_stock: added, opening_stock: added, updated_at: new Date().toISOString() })
        .eq('id', created.id);
      if (stockErr) return undo(`Existing inventory failed: ${stockErr.message}.`);
    }
    return NextResponse.json({ sku_code: code, opening_stock: added });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

/** Edit the non-identity fields of a product. Only the fields you send are changed. */
export async function PATCH(req: Request) {
  await requirePermission('products.edit');
  const body = await req.json();
  const { id } = body;
  if (!id) return NextResponse.json({ error: 'Missing product id.' }, { status: 400 });

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };

  // Fill in the identity parts an import left as UNSPECIFIED (Make, Section, Size, Family, …).
  // Only blank values are replaced; the SKU code never changes.
  if (body.fix && typeof body.fix === 'object') {
    const svc0 = await supabaseService();
    const { data: cur, error: curErr } = await svc0.from('v_sku_status')
      .select('id,sku_code,product_type,family_name,brand_name,section,colour,hier_l3,length_mm,width_mm,thickness_mm,missing_fields')
      .eq('id', id).single();
    if (curErr || !cur) return NextResponse.json({ error: 'Product not found.' }, { status: 404 });
    const type = cur.product_type as ProductType;
    const f = body.fix as Record<string, unknown>;
    const keep = (v: unknown) => (String(v ?? '').trim() === UNSPECIFIED ? '' : v);
    const pick = (fixed: unknown, current: unknown) => (String(fixed ?? '').trim() !== '' ? fixed : keep(current));

    const built = buildIdentity(type, {
      family: pick(f.family, cur.family_name),
      brand: pick(f.brand, cur.brand_name),
      section: pick(f.section, cur.section),
      colour: pick(f.colour, cur.colour),
      size: pick(f.size, cur.hier_l3),
      length: pick(f.length, cur.length_mm),
      width: pick(f.width, cur.width_mm),
      thickness: pick(f.thickness, cur.thickness_mm),
    });
    if (isIdentityError(built)) return NextResponse.json({ error: built.error }, { status: 400 });

    const all = await loadAllSkus(svc0);
    const twin = all.find((s) => s.id !== id && s.product_type === type && s.identity_key === built.key);
    if (twin) {
      return NextResponse.json({ error: `That makes this product identical to ${twin.sku_code}. Deactivate one of them instead.` }, { status: 409 });
    }
    const { brandId, familyId } = await ensureBrandsAndFamilies(svc0, type, [built]);
    const fresh = newSkuRow(built, cur.sku_code, familyId.get(built.family)!, brandId.get(built.brand)!, 'MANUAL');
    /* eslint-disable @typescript-eslint/no-unused-vars */
    const { sku_code, product_type, created_via, unit_code, opening_stock, current_stock, min_stock_level,
      supplier_moq, reorder_quantity, is_active, ...identityFields } = fresh;
    /* eslint-enable @typescript-eslint/no-unused-vars */
    Object.assign(update, identityFields);
    delete body.display_name; // the name follows the fixed identity
  }

  if ('display_name' in body) update.display_name = body.display_name || null;
  if ('min_stock_level' in body) update.min_stock_level = Number(body.min_stock_level) || 0;
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
