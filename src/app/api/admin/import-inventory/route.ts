import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { supabaseService } from '@/lib/supabase-server';
import type { ProductType } from '@/lib/types';
import {
  INVENTORY_FIELDS, PRODUCT_TYPES, TYPE_META, cleanText, parseLotType, toNumber,
  type Identity, type LotType,
} from '@/lib/sheet-config';
import {
  PREVIEW_LIMIT, cellOf, ensureBrandsAndFamilies, historyCount, insertSkus, isIdentityError,
  loadAllSkus, newSkuRow, rawIdentityOf, readSheet, buildIdentity, uniqueSkuCode, unmappedRequired,
  type ExistingSku,
} from '@/lib/sheet-import-server';

export const dynamic = 'force-dynamic';

const MAX_PIECES_PER_ROW = 500;

/**
 * INVENTORY import — loads what is physically in stock and attaches it to SKUs.
 *
 * Each sheet row is matched to a SKU by its identity (family + section/colour +
 * size + make …), never by SKU code. A row whose product isn't in Product Master
 * yet auto-creates that SKU (tagged "created from inventory import").
 *
 *  Timing belts : every physical piece becomes its own lot.
 *                 FULL SLEEVE, 50 mm, QTY 4  ->  4 lots of 50 mm (Full Sleeve)
 *                 CUT PCS, 200 mm, QTY 1     ->  1 lot of 200 mm (Cut Pcs)
 *                 Stock is counted in mm and always equals the sum of its lots.
 *  V / Conveyor : plain stock in pieces.
 *
 * mode:
 *   OVERWRITE  wipe this type's existing stock/lots first, then load the sheet
 *              (refused with a clear message if movements/orders already exist)
 *   ADD        keep current stock; timing rows add NEW lots, others add pieces
 *
 * dryRun=true returns the preview/summary without touching the database.
 */
export async function POST(req: Request) {
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

  const meta = TYPE_META[type];
  const missing = unmappedRequired(INVENTORY_FIELDS[type], mapping);
  if (missing.length) {
    return NextResponse.json({ error: `Map these required fields first: ${missing.join(', ')}.` }, { status: 400 });
  }

  const rows = await readSheet(file, sheet);
  if (!rows.length) return NextResponse.json({ error: 'Sheet is empty.' }, { status: 400 });

  let blocked: string | null = null;
  if (mode === 'OVERWRITE') {
    const n = await historyCount(svc, type);
    if (n > 0) {
      blocked = `Overwrite is blocked: ${n} movement / order record(s) already exist for these ${meta.label.toLowerCase()}. ` +
        `Run the full reset script (015) for a clean slate, or switch to "Add to current stock".`;
    }
  }

  const all = await loadAllSkus(svc);
  const existingByKey = new Map(
    all.filter((s) => s.product_type === type && s.identity_key).map((s) => [s.identity_key as string, s]));
  const takenCodes = new Set(all.map((s) => s.sku_code));

  interface Planned {
    rowNum: number;
    id: Identity;
    sku: ExistingSku | null;       // null => will be created
    newCode: string | null;
    lot: LotType | null;
    uom: number | null;
    qty: number;
    location: string;
    remarks: string;
  }

  const planned: Planned[] = [];
  const errors: string[] = [];
  const pendingNew = new Map<string, { id: Identity; code: string }>(); // identity key -> new SKU
  type PreviewRow = {
    rowNum: number; status: 'MATCH' | 'NEW_SKU' | 'ERROR'; skuCode: string; family: string;
    sectionOrColour: string; size: string; brand: string; lot: string; load: string; note: string;
  };
  const preview: PreviewRow[] = [];
  let lotsToCreate = 0, totalLoad = 0, matched = 0;

  rows.forEach((row, i) => {
    const rowNum = i + 2;
    const allBlank = Object.values(mapping).every((col) => String(row[col] ?? '').trim() === '');
    if (allBlank) return;

    const push = (p: PreviewRow) => { if (preview.length < PREVIEW_LIMIT) preview.push(p); };
    const fail = (msg: string, extra: Partial<PreviewRow> = {}) => {
      errors.push(`Row ${rowNum}: ${msg}`);
      push({ rowNum, status: 'ERROR', skuCode: '—', family: '', sectionOrColour: '', size: '', brand: '', lot: '', load: '', note: msg, ...extra });
    };

    const built = buildIdentity(type, rawIdentityOf(mapping, row));
    if (isIdentityError(built)) { fail(built.error); return; }

    let lot: LotType | null = null;
    let uom: number | null = null;
    const qty = toNumber(cellOf(mapping, row, 'qty'));

    if (qty === null || qty <= 0) { fail('QTY must be a number greater than 0'); return; }

    if (meta.usesLots) {
      lot = parseLotType(cellOf(mapping, row, 'lot_type'));
      if (!lot) { fail('Cut Pcs / Full Sleeve must read CUT PCS or FULL SLEEVE'); return; }
      uom = toNumber(cellOf(mapping, row, 'uom_mm'));
      if (uom === null || uom <= 0) { fail('UOM in MM must be a number greater than 0'); return; }
      if (!Number.isInteger(qty)) { fail('QTY must be a whole number of pieces'); return; }
      if (qty > MAX_PIECES_PER_ROW) { fail(`QTY ${qty} is above the ${MAX_PIECES_PER_ROW}-piece limit per row`); return; }
    }

    let sku = existingByKey.get(built.key) ?? null;
    let newCode: string | null = null;
    if (!sku) {
      let pend = pendingNew.get(built.key);
      if (!pend) {
        const code = uniqueSkuCode(built, takenCodes);
        takenCodes.add(code);
        pend = { id: built, code };
        pendingNew.set(built.key, pend);
      }
      newCode = pend.code;
    } else {
      matched++;
    }

    planned.push({
      rowNum, id: built, sku, newCode, lot, uom, qty,
      location: cleanText(cellOf(mapping, row, 'location')),
      remarks: cleanText(cellOf(mapping, row, 'remarks')),
    });

    const pieces = meta.usesLots ? qty : 0;
    const load = meta.usesLots ? qty * (uom as number) : qty;
    if (meta.usesLots) lotsToCreate += pieces;
    totalLoad += load;

    push({
      rowNum,
      status: sku ? 'MATCH' : 'NEW_SKU',
      skuCode: sku ? sku.sku_code : (newCode as string),
      family: built.family,
      sectionOrColour: built.section ?? built.colour ?? '',
      size: built.sizeLabel,
      brand: built.brand,
      lot: lot ? (lot === 'FULL_SLEEVE' ? 'Full Sleeve' : 'Cut Pcs') : '',
      load: meta.usesLots
        ? `${qty} × ${uom} mm = ${load} mm`
        : `+${load} pcs`,
      note: sku ? 'Matched to existing SKU' : 'SKU not in Product Master — will be created',
    });
  });

  const summary = {
    rows: rows.length,
    matched,
    newSkus: pendingNew.size,
    newSkuList: [...pendingNew.values()].slice(0, 30).map((p) => p.code),
    lotsToCreate,
    totalLoad,
    unit: meta.unit === 'MM' ? 'mm' : 'pcs',
    errors: errors.length,
    mode,
  };

  if (dryRun) {
    return NextResponse.json({ dryRun: true, blocked, summary, preview, errors: errors.slice(0, 50) });
  }
  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });
  if (!planned.length) return NextResponse.json({ error: 'No valid rows to import.', errors }, { status: 400 });

  // ── Real run ────────────────────────────────────────────────────────────────
  if (mode === 'OVERWRITE') {
    const { error } = await svc.rpc('wipe_inventory_type', { p_type: type });
    if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  }

  // 1. Create the SKUs that weren't in Product Master
  const createdCodes: string[] = [];
  const newIdByKey = new Map<string, string>();
  if (pendingNew.size) {
    try {
      const list = [...pendingNew.entries()];
      const { brandId, familyId } = await ensureBrandsAndFamilies(svc, type, list.map(([, v]) => v.id));
      const rowsToInsert = list.map(([, v]) =>
        newSkuRow(v.id, v.code, familyId.get(v.id.family)!, brandId.get(v.id.brand)!, 'INVENTORY_IMPORT'));
      const res = await insertSkus(svc, rowsToInsert);
      for (const [key, v] of list) {
        const id = res.idByCode.get(v.code);
        if (id) { newIdByKey.set(key, id); createdCodes.push(v.code); }
      }
      for (const e of res.errors) errors.push(`New SKU ${e.skuCode}: ${e.message}`);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // Resolve each planned row to a SKU id (skipping rows whose new SKU failed)
  interface Target { skuId: string; isNew: boolean; baseStock: number; roll: number | null; fullLen: number | null; added: number; location: string; remarks: string }
  const targets = new Map<string, Target>(); // keyed by identity key
  for (const p of planned) {
    const key = p.id.key;
    if (!targets.has(key)) {
      const skuId = p.sku ? p.sku.id : newIdByKey.get(key);
      if (!skuId) continue;
      targets.set(key, {
        skuId,
        isNew: !p.sku,
        // After an overwrite wipe every stock figure is 0; in ADD mode build on what is there.
        baseStock: mode === 'OVERWRITE' || !p.sku ? 0 : Number(p.sku.current_stock ?? 0),
        roll: p.sku?.roll_length_mm ?? null,
        fullLen: null,
        added: 0,
        location: '',
        remarks: '',
      });
    }
    const t = targets.get(key)!;
    if (p.lot === 'FULL_SLEEVE' && p.uom && t.fullLen === null) t.fullLen = p.uom;
    if (p.location) t.location = p.location;
    if (p.remarks) t.remarks = p.remarks;
  }

  // 2. Load the stock
  let lotsCreated = 0;
  for (const p of planned) {
    const t = targets.get(p.id.key);
    if (!t) continue;

    if (meta.usesLots && p.lot && p.uom) {
      const roll = p.lot === 'FULL_SLEEVE'
        ? p.uom
        : Math.max(t.roll ?? t.fullLen ?? p.uom, p.uom); // a cut piece can't be longer than its roll
      for (let n = 0; n < p.qty; n++) {
        const { error } = await svc.rpc('create_opening_lot', {
          p_sku_id: t.skuId,
          p_qty: p.uom,
          p_status: p.lot,
          p_roll_length: roll,
          p_notes: 'Imported from inventory sheet',
        });
        if (error) { errors.push(`Row ${p.rowNum}: lot ${n + 1}/${p.qty} failed — ${error.message}`); break; }
        lotsCreated++;
        t.added += p.uom;
      }
    } else {
      t.added += p.qty;
    }
  }

  // 3. Update each SKU's stock to match (stock always == sum of its lots / the loaded qty)
  let updatedSkus = 0;
  for (const t of targets.values()) {
    const current = t.baseStock + t.added;
    const patch: Record<string, unknown> = { current_stock: current, updated_at: new Date().toISOString() };
    if (t.isNew || mode === 'OVERWRITE') patch.opening_stock = current;
    if (meta.usesLots && t.roll === null && t.fullLen !== null) patch.roll_length_mm = t.fullLen;
    if (t.location) patch.rack_location = t.location;
    if (t.remarks) patch.remarks = t.remarks;
    const { error } = await svc.from('skus').update(patch).eq('id', t.skuId);
    if (error) errors.push(`Stock update failed for SKU ${t.skuId}: ${error.message}`);
    else updatedSkus++;
  }

  try {
    await svc.from('import_batches').insert({
      file_name: file.name,
      mode: 'REPLACE',
      counts: { kind: 'INVENTORY', type, importMode: mode, skusTouched: updatedSkus, newSkus: createdCodes.length, lots: lotsCreated, errors: errors.length, rows: rows.length },
    });
  } catch { /* non-critical */ }

  return NextResponse.json({
    dryRun: false,
    skusUpdated: updatedSkus,
    newSkus: createdCodes,
    lotsCreated,
    totalLoad,
    unit: summary.unit,
    errors,
  });
}
