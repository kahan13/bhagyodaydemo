import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { supabaseService } from '@/lib/supabase-server';
import * as XLSX from 'xlsx';

export const dynamic = 'force-dynamic';

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};

const toBool = (v: unknown): boolean => {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  return s === 'yes' || s === '1' || s === 'true' || s === 'y';
};

const toCode = (name: string) =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

const toStr = (v: unknown): string =>
  v === null || v === undefined ? '' : String(v).trim();

/**
 * Normalise a CUT PCS / FULL SLEEVE cell value to DB status strings.
 * Accepts: "CUT PCS", "Cut Pcs", "cut pcs", "CUT_PCS", "CUT"
 *          "FULL SLEEVE", "Full Sleeve", "FULL_SLEEVE", "FULL", "SLEEVE"
 * Returns: 'CUT_PCS' | 'FULL_SLEEVE'
 */
const normaliseLotStatus = (raw: unknown): 'CUT_PCS' | 'FULL_SLEEVE' => {
  const s = toStr(raw).toUpperCase().replace(/[\s_]+/g, '');
  if (s.startsWith('CUT')) return 'CUT_PCS';
  return 'FULL_SLEEVE';
};

type ProductType = 'TIMING_BELT' | 'V_BELT' | 'CONVEYOR_BELT';

// V-Belt is the only type that groups by "profile" instead of "family" —
// Timing Belt and Conveyor Belt sheets both use a family-style grouping
// column (Timing Belt: FAMILY, Conveyor Belt: PRODUCT FAMILY).
const familyKeyFor = (productType: ProductType): 'family' | 'profile' =>
  productType === 'V_BELT' ? 'profile' : 'family';

export async function POST(req: Request) {
  await requirePermission('settings.import');
  const svc = await supabaseService();

  const fd = await req.formData();
  const file = fd.get('file') as File | null;
  const sheetName = fd.get('sheet') as string;
  const productType = fd.get('productType') as ProductType;
  const mapping: Record<string, string> = JSON.parse(fd.get('mapping') as string);
  const labels: Record<string, string> = JSON.parse(fd.get('labels') as string);

  if (!file) return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });

  // Parse Excel
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[sheetName ?? wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });

  if (!rows.length) return NextResponse.json({ error: 'Sheet is empty.' }, { status: 400 });

  const cell = (row: Record<string, unknown>, sfKey: string): unknown =>
    mapping[sfKey] ? row[mapping[sfKey]] : undefined;

  const familyKey = familyKeyFor(productType);

  // Lots only ever apply to Timing Belt — V-Belt and Conveyor Belt sheets have
  // no cut-pcs/full-sleeve concept, so this is gated by product type as well
  // as by whether the columns were mapped (belt-and-braces: the import
  // screen already hides these fields for non-Timing-Belt types).
  const hasLotColumns = productType === 'TIMING_BELT' && !!(mapping['lot_status'] && mapping['lot_qty']);

  // ── 1. Collect unique brands and families ──────────────────────────────────
  const brandNames = new Set<string>();
  const familyNames = new Set<string>();

  for (const row of rows) {
    const brand = toStr(cell(row, 'brand'));
    const family = toStr(cell(row, familyKey));
    if (brand) brandNames.add(brand);
    if (family) familyNames.add(family);
  }

  // Upsert brands
  const brandMap = new Map<string, string>();
  for (const name of brandNames) {
    const code = toCode(name);
    const { data } = await svc
      .from('brands')
      .upsert(
        {
          code,
          name,
          has_timing_belts: productType === 'TIMING_BELT',
          has_v_belts: productType === 'V_BELT',
          is_active: true,
        },
        { onConflict: 'code', ignoreDuplicates: false }
      )
      .select('id,code')
      .single();
    if (data) brandMap.set(name, data.id);
  }

  // Upsert families / profiles
  const familyMap = new Map<string, string>();
  for (const name of familyNames) {
    const code = toCode(name);
    const { data } = await svc
      .from('product_families')
      .upsert({ product_type: productType, code, name }, { onConflict: 'product_type,code' })
      .select('id,code')
      .single();
    if (data) familyMap.set(name, data.id);
  }

  // Ensure default unit
  const defaultUnit = 'PCS';
  await svc
    .from('units')
    .upsert({ code: defaultUnit, name: 'Pieces', decimals: 0 }, { onConflict: 'code', ignoreDuplicates: true });

  // ── 2. Process rows ────────────────────────────────────────────────────────
  let inserted = 0;
  let updated = 0;
  let lotsCreated = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    const skuCode    = toStr(cell(row, 'sku_code'));
    const exactSize  = toStr(cell(row, 'exact_size'));
    const brandName  = toStr(cell(row, 'brand'));
    const familyName = toStr(cell(row, familyKey));

    if (!skuCode)   { errors.push(`Row ${rowNum}: SKU code is empty.`);                               continue; }
    if (!exactSize) { errors.push(`Row ${rowNum}: Size is empty (${skuCode}).`);                      continue; }
    if (!brandName || !brandMap.has(brandName)) { errors.push(`Row ${rowNum}: Brand missing or unresolved (${skuCode}).`);  continue; }
    if (!familyName || !familyMap.has(familyName)) { errors.push(`Row ${rowNum}: Family/Profile missing or unresolved (${skuCode}).`); continue; }

    const brandId  = brandMap.get(brandName)!;
    const familyId = familyMap.get(familyName)!;

    const unitRaw  = toStr(cell(row, 'unit')).toUpperCase();
    const unitCode = ['PCS', 'MTR', 'ROLL', 'SET'].includes(unitRaw) ? unitRaw : defaultUnit;

    // Opening stock: prefer explicit opening_stock column; fall back to lot_qty if lot columns mapped
    const lotQtyRaw     = hasLotColumns ? toNum(cell(row, 'lot_qty')) : null;
    const openingStock  = toNum(cell(row, 'opening_stock')) ?? lotQtyRaw ?? 0;
    const rollLengthMm  = productType === 'TIMING_BELT' ? toNum(cell(row, 'roll_length_mm')) : null;

    const isActiveRaw = cell(row, 'is_active');
    const isActive    = isActiveRaw === '' || isActiveRaw === undefined ? true : toBool(isActiveRaw);

    const displayNameRaw = toStr(cell(row, 'display_name'));
    const displayName    = displayNameRaw || `${exactSize} ${brandName}`;

    const colourRaw = toStr(cell(row, 'colour'));

    const hier_l1   = familyName;
    const hier_l2   = exactSize;
    const hier_l3   = brandName;
    const searchText = `${skuCode} ${exactSize} ${brandName} ${familyName} ${displayName}`.toLowerCase();

    const skuRow = {
      sku_code:           skuCode,
      product_type:       productType,
      family_id:          familyId,
      brand_id:           brandId,
      exact_size:         exactSize,
      display_name:       displayName,
      hier_l1,
      hier_l2,
      hier_l3,
      search_text:        searchText,
      unit_code:          unitCode,
      opening_stock:      openingStock,
      current_stock:      openingStock,
      roll_length_mm:     rollLengthMm,
      colour:             colourRaw || null,
      min_stock_level:    toNum(cell(row, 'min_stock_level'))    ?? 0,
      supplier_moq:       toNum(cell(row, 'supplier_moq'))       ?? 0,
      reorder_quantity:   toNum(cell(row, 'reorder_quantity'))   ?? 0,
      rack_location:      toStr(cell(row, 'rack_location'))      || null,
      is_active:          isActive,
      // Timing belt fields
      belt_form:          toStr(cell(row, 'belt_form'))          || null,
      pitch_mm:           toNum(cell(row, 'pitch_mm')),
      pitch_length_mm:    toNum(cell(row, 'pitch_length_mm')),
      width_mm:           toNum(cell(row, 'width_mm')),
      teeth:              toNum(cell(row, 'teeth')),
      standard:           toStr(cell(row, 'standard'))           || null,
      // V-belt fields
      construction:       toStr(cell(row, 'construction'))       || null,
      nominal_length:     toNum(cell(row, 'nominal_length')),
      length_designation: toStr(cell(row, 'length_designation')) || null,
    };

    // Upsert SKU
    let skuId: string;
    const { data: existing } = await svc
      .from('skus')
      .select('id')
      .eq('sku_code', skuCode)
      .maybeSingle();

    if (existing) {
      const { error } = await svc
        .from('skus')
        .update({ ...skuRow, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) { errors.push(`Row ${rowNum}: ${error.message} (${skuCode})`); continue; }
      skuId = existing.id;
      updated++;
    } else {
      const { data: ins, error } = await svc
        .from('skus')
        .insert(skuRow)
        .select('id')
        .single();
      if (error || !ins) { errors.push(`Row ${rowNum}: ${error?.message ?? 'insert failed'} (${skuCode})`); continue; }
      skuId = ins.id;
      inserted++;
    }

    // ── Create opening lot if lot columns are mapped and qty > 0 (Timing Belt only) ──
    if (hasLotColumns && lotQtyRaw && lotQtyRaw > 0) {
      const lotStatus = normaliseLotStatus(cell(row, 'lot_status'));

      const { error: lotErr } = await svc.rpc('create_opening_lot', {
        p_sku_id:      skuId,
        p_qty:         lotQtyRaw,
        p_status:      lotStatus,
        p_roll_length: rollLengthMm ?? null,
        p_notes:       'Imported from sheet',
      });

      if (lotErr) {
        // Non-fatal: SKU is already saved; just note the lot failure
        errors.push(`Row ${rowNum}: SKU saved but lot creation failed — ${lotErr.message} (${skuCode})`);
      } else {
        lotsCreated++;
      }
    }
  }

  // ── 3. Save hierarchy labels ──────────────────────────────────────────────
  const l1Key   = familyKey;
  const l1Label = labels[l1Key]        || mapping[l1Key]        || (familyKey === 'family' ? 'Family' : 'Profile');
  const l2Label = labels['exact_size'] || mapping['exact_size'] || 'Size';
  const l3Label = labels['brand']      || mapping['brand']      || 'Brand';

  const { data: existingLabelRow } = await svc
    .from('app_settings')
    .select('value')
    .eq('key', 'hierarchy_labels')
    .maybeSingle();

  const existingLabels = (existingLabelRow?.value as Record<string, [string, string, string]>) ?? {};
  await svc.from('app_settings').upsert(
    {
      key: 'hierarchy_labels',
      value: { ...existingLabels, [productType]: [l1Label, l2Label, l3Label] },
    },
    { onConflict: 'key' }
  );

  // ── 4. Log import batch ───────────────────────────────────────────────────
  try {
    await svc.from('import_batches').insert({
      file_name: file.name,
      mode: 'REPLACE',
      counts: { inserted, updated, lots: lotsCreated, errors: errors.length, rows: rows.length },
    });
  } catch { /* non-critical */ }

  return NextResponse.json({ inserted, updated, lots: lotsCreated, errors });
}
