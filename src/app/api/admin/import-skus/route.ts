import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { supabaseService } from '@/lib/supabase-server';
import type { ProductType } from '@/lib/types';
import { PRODUCT_TYPES, SKU_FIELDS, toCode, type Identity } from '@/lib/sheet-config';
import {
  importErrorResponse, PREVIEW_LIMIT, ensureBrandsAndFamilies, historyCount, insertSkus, isIdentityError,
  loadAllSkus, loadBrandFamilyNames, newSkuRow, rawIdentityOf, readSheet,
  buildIdentity, uniqueSkuCode, unmappedRequired,
} from '@/lib/sheet-import-server';

export const dynamic = 'force-dynamic';

/**
 * PRODUCTS import — creates SKUs (the product master) from identity columns only.
 * Stock, cut pcs / full sleeve, UOM and location are NOT handled here; they belong
 * to the Inventory import.
 *
 * mode:
 *   OVERWRITE  wipe this product type's existing products, then import fresh
 *              (refused with a clear message if they already have history)
 *   ADD        keep what exists, create only products that aren't there yet
 *
 * dryRun=true returns the preview/summary without touching the database.
 */
async function handle(req: Request) {
  await requirePermission('settings.import');
  const svc = await supabaseService();

  const fd = await req.formData();
  const file = fd.get('file') as File | null;
  const sheet = (fd.get('sheet') as string) || null;
  const type = fd.get('productType') as ProductType;
  const mode = ((fd.get('mode') as string) === 'OVERWRITE' ? 'OVERWRITE' : 'ADD') as 'OVERWRITE' | 'ADD';
  const dryRun = fd.get('dryRun') === 'true';
  const mapping: Record<string, string> = JSON.parse((fd.get('mapping') as string) || '{}');

  if (!file) return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });
  if (!PRODUCT_TYPES.includes(type)) return NextResponse.json({ error: 'Unknown product type.' }, { status: 400 });

  const missing = unmappedRequired(SKU_FIELDS[type], mapping);
  if (missing.length) {
    return NextResponse.json({ error: `Map these required fields first: ${missing.join(', ')}.` }, { status: 400 });
  }

  const rows = await readSheet(file, sheet);
  if (!rows.length) return NextResponse.json({ error: 'Sheet is empty.' }, { status: 400 });

  // History check (only matters for Overwrite)
  let blocked: string | null = null;
  if (mode === 'OVERWRITE') {
    const n = await historyCount(svc, type);
    if (n > 0) {
      blocked = `Overwrite is blocked: ${n} movement / order record(s) already reference these ${type.replace('_', ' ').toLowerCase()} products. ` +
        `Run the full reset script (015) for a clean slate, or switch to "Add new only".`;
    }
  }

  const all = await loadAllSkus(svc);
  // In overwrite, this type's SKUs will be gone — don't count them as existing or as taken codes.
  const surviving = mode === 'OVERWRITE' ? all.filter((s) => s.product_type !== type) : all;
  const existingByKey = new Map(
    surviving.filter((s) => s.product_type === type && s.identity_key).map((s) => [s.identity_key as string, s]));
  const takenCodes = new Set(surviving.map((s) => s.sku_code));

  const { brandCodes, familyCodes: existingFamilyCodes } = await loadBrandFamilyNames(svc, type);
  // Overwrite deletes this type's families too, so every family counts as new then.
  const familyCodes = mode === 'OVERWRITE' ? new Set<string>() : existingFamilyCodes;

  type PreviewRow = {
    rowNum: number; status: 'NEW' | 'EXISTS' | 'DUPLICATE' | 'ERROR';
    skuCode: string; family: string; sectionOrColour: string; size: string; brand: string; note: string;
  };
  const preview: PreviewRow[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>(); // identity key -> assigned sku code (this run)
  const toCreate: { id: Identity; code: string }[] = [];
  let existing = 0, duplicates = 0;
  const newBrands = new Set<string>(), newFamilies = new Set<string>();

  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const built = buildIdentity(type, rawIdentityOf(mapping, row));

    // Skip fully empty rows silently
    const allBlank = Object.values(mapping).every((col) => String(row[col] ?? '').trim() === '');
    if (allBlank) return;

    const push = (p: PreviewRow) => { if (preview.length < PREVIEW_LIMIT) preview.push(p); };

    if (isIdentityError(built)) {
      errors.push(`Row ${rowNum}: ${built.error}`);
      push({ rowNum, status: 'ERROR', skuCode: '—', family: '', sectionOrColour: '', size: '', brand: '', note: built.error });
      return;
    }
    const secOrCol = built.section ?? built.colour ?? '';
    const base = { rowNum, family: built.family, sectionOrColour: secOrCol, size: built.sizeLabel, brand: built.brand };

    if (seen.has(built.key)) {
      duplicates++;
      push({ ...base, status: 'DUPLICATE', skuCode: seen.get(built.key)!, note: 'Same product appears earlier in the sheet — one SKU only' });
      return;
    }
    const ex = existingByKey.get(built.key);
    if (ex) {
      seen.set(built.key, ex.sku_code);
      existing++;
      push({ ...base, status: 'EXISTS', skuCode: ex.sku_code, note: 'Already in Product Master — kept as is' });
      return;
    }
    const code = uniqueSkuCode(built, takenCodes);
    takenCodes.add(code);
    seen.set(built.key, code);
    toCreate.push({ id: built, code });
    if (!brandCodes.has(toCode(built.brand))) newBrands.add(built.brand);
    if (!familyCodes.has(toCode(built.family))) newFamilies.add(built.family);
    push({ ...base, status: 'NEW', skuCode: code, note: 'Will be created' });
  });

  const summary = {
    rows: rows.length,
    newSkus: toCreate.length,
    existing,
    duplicates,
    errors: errors.length,
    newBrands: [...newBrands],
    newFamilies: [...newFamilies],
    mode,
  };

  if (dryRun) {
    return NextResponse.json({ dryRun: true, blocked, summary, preview, errors: errors.slice(0, 50) });
  }

  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });

  // ── Real run ────────────────────────────────────────────────────────────────
  if (mode === 'OVERWRITE') {
    const { error } = await svc.rpc('wipe_catalog_type', { p_type: type });
    if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  }

  let created = 0;
  const failed: string[] = [];
  if (toCreate.length) {
    try {
      const { brandId, familyId } = await ensureBrandsAndFamilies(svc, type, toCreate.map((t) => t.id));
      const skuRows = toCreate.map(({ id, code }) =>
        newSkuRow(id, code, familyId.get(id.family)!, brandId.get(id.brand)!, 'SKU_IMPORT'));
      const res = await insertSkus(svc, skuRows);
      created = res.idByCode.size;
      for (const e of res.errors) failed.push(`${e.skuCode}: ${e.message}`);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  try {
    await svc.from('import_batches').insert({
      file_name: file.name,
      mode: 'REPLACE', // legacy column; the real choice is recorded in counts
      counts: { kind: 'SKU', type, importMode: mode, created, existing, duplicates, errors: errors.length + failed.length, rows: rows.length },
    });
  } catch { /* non-critical */ }

  return NextResponse.json({
    dryRun: false,
    created,
    existing,
    duplicates,
    errors: [...errors, ...failed],
  });
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (e) {
    return importErrorResponse(e);
  }
}
