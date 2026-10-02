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

// Unit codes are short and typically already clean (PCS, MTR, MM…) — same
// sanitiser as toCode but capped shorter, since `units.code` is a short code
// column, not a free-text name.
const toUnitCode = (v: unknown): string =>
  toStr(v).toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10);

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
type ImportMode = 'OVERWRITE' | 'APPEND';

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
  const importMode = ((fd.get('importMode') as string) || 'OVERWRITE') as ImportMode;
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

  // ── 1. Collect unique brands, families and units ────────────────────────────
  const brandNames = new Set<string>();
  const familyNames = new Set<string>();
  const unitCodes = new Set<string>();

  for (const row of rows) {
    const brand = toStr(cell(row, 'brand'));
    const family = toStr(cell(row, familyKey));
    const unit = toUnitCode(cell(row, 'unit'));
    if (brand) brandNames.add(brand);
    if (family) familyNames.add(family);
    if (unit) unitCodes.add(unit);
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

  // Ensure the default unit always exists, PLUS every unit code actually seen
  // in this sheet's Unit column (not just a fixed 4-code whitelist as
  // before) — this is what was missing and caused the FK error on save.
  const defaultUnit = 'PCS';
  const allUnitCodes = new Set<string>([defaultUnit, ...unitCodes]);
  for (const code of allUnitCodes) {
    await svc
      .from('units')
      .upsert({ code, name: code, decimals: 0 }, { onConflict: 'code', ignoreDuplicates: true });
  }

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

    const unitRaw  = toUnitCode(cell(row, 'unit'));
    const unitCode = unitRaw || defaultUnit;

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

    // Fields that always sync to the sheet, regardless of overwrite/append —
    // purely descriptive, never a quantity.
    const descriptiveRow = {
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

    // Look up any existing SKU by code, including its current stock so
    // append mode can add on top of it rather than guessing.
    const { data: existing } = await svc
      .from('skus')
      .select('id,current_stock')
      .eq('sku_code', skuCode)
      .maybeSingle();

    let skuId: string;
    let shouldCreateLot = false;

    if (existing) {
      // ── Existing SKU ──────────────────────────────────────────────────
      // Quantity handling depends on whether this SKU is lot-tracked, and
      // on overwrite vs. append — see the file-level note above the route
      // for the reasoning. The one rule that never bends: when lots exist
      // for a SKU, skus.current_stock is only ever changed by a lot
      // operation (create_opening_lot here, or inward/outward elsewhere),
      // never written directly from a sheet value — that's what keeps
      // SUM(sku_lots.current_qty) === skus.current_stock true.
      let stockFields: Record<string, number> = {};

      if (hasLotColumns) {
        // Lot-tracked existing SKU: never touch stock directly.
        // Overwrite  → sync descriptive fields only, no new lot.
        // Append     → sync descriptive fields AND add a new lot (a fresh
        //              inward/roll), which adjusts current_stock itself.
        shouldCreateLot = importMode === 'APPEND';
      } else if (importMode === 'OVERWRITE') {
        // Non-lot SKU, overwrite: reset stock to the sheet's value, same
        // as this screen has always done.
        stockFields = { opening_stock: openingStock, current_stock: openingStock };
      } else {
        // Non-lot SKU, append: add the sheet's quantity on top of whatever
        // is already there; opening_stock (the original baseline) is left
        // untouched.
        stockFields = { current_stock: (existing.current_stock ?? 0) + openingStock };
      }

      const { error } = await svc
        .from('skus')
        .update({ ...descriptiveRow, ...stockFields, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) { errors.push(`Row ${rowNum}: ${error.message} (${skuCode})`); continue; }
      skuId = existing.id;
      updated++;
    } else {
      // ── Brand-new SKU ─────────────────────────────────────────────────
      // Nothing to overwrite or append to — always a plain insert at the
      // sheet's opening quantity, and the first lot (if any) always gets
      // created, in either mode.
      const { data: ins, error } = await svc
        .from('skus')
        .insert({ ...descriptiveRow, opening_stock: openingStock, current_stock: openingStock })
        .select('id')
        .single();
      if (error || !ins) { errors.push(`Row ${rowNum}: ${error?.message ?? 'insert failed'} (${skuCode})`); continue; }
      skuId = ins.id;
      inserted++;
      shouldCreateLot = hasLotColumns;
    }

    // ── Create a lot (new roll) when this row calls for one ───────────────
    if (shouldCreateLot && lotQtyRaw && lotQtyRaw > 0) {
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
      // Keep the original literal here in case `mode` has a CHECK
      // constraint limited to the value this column has always used —
      // the real overwrite/append choice is recorded in `counts` instead,
      // which is free-form jsonb.
      mode: 'REPLACE',
      counts: { inserted, updated, lots: lotsCreated, errors: errors.length, rows: rows.length, importMode },
    });
  } catch { /* non-critical */ }

  return NextResponse.json({ inserted, updated, lots: lotsCreated, errors });
}
