import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { supabaseService } from '@/lib/supabase-server';
import type { ProductType } from '@/lib/types';
import {
  INVENTORY_FIELDS, TYPE_META, cleanText, parseLotType, toNumber,
  type Identity, type LotType,
} from '@/lib/sheet-config';
import {
  importErrorResponse, PREVIEW_LIMIT, cellOf, ensureBrandsAndFamilies, historyCount, insertSkus, isIdentityError,
  loadAllSkus, loadSheets, newSkuRow, parseSheetCfgs, rawIdentityOf, readMsl, rowHasData, buildIdentity,
  uniqueSkuCode, unmappedRequired, type ExistingSku,
} from '@/lib/sheet-import-server';

export const dynamic = 'force-dynamic';

const MAX_PIECES_PER_ROW = 500;

/**
 * INVENTORY import — loads what is physically in stock and attaches it to SKUs.
 * One request can carry SEVERAL sheets of one workbook (field `sheets`).
 *
 * Each sheet row is matched to a SKU by its identity (family + section/colour +
 * size + make …), never by SKU code. A row whose product isn't in Product Master
 * yet auto-creates that SKU (tagged "created from inventory import").
 *
 * Nothing is dropped silently:
 *   - a blank Make / Section / Size creates the product as UNSPECIFIED and flags it
 *   - QTY 0 or blank creates / matches the product with no stock
 *   - Cut Pcs / Full Sleeve unreadable  -> loaded as Full Sleeve and flagged
 *   - UOM in MM missing / QTY not whole -> product kept, stock for that row NOT loaded, listed
 *
 *  Timing belts : every physical piece becomes its own lot (stock in mm = sum of lots).
 *  V / Conveyor : plain stock in pieces.
 *  MSL          : read per product (blank = leave as is); timing belts count pieces.
 */
async function handle(req: Request) {
  await requirePermission('settings.import');
  const svc = await supabaseService();

  const fd = await req.formData();
  const file = fd.get('file') as File | null;
  const mode = ((fd.get('mode') as string) === 'OVERWRITE' ? 'OVERWRITE' : 'ADD') as 'OVERWRITE' | 'ADD';
  const dryRun = fd.get('dryRun') === 'true';
  if (!file) return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });

  const parsed = parseSheetCfgs(fd);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
  for (const c of parsed.cfgs) {
    const missing = unmappedRequired(INVENTORY_FIELDS[c.type], c.mapping);
    if (missing.length) {
      return NextResponse.json({ error: `Sheet "${c.name}": map these required fields first: ${missing.join(', ')}.` }, { status: 400 });
    }
  }

  const sheets = await loadSheets(file, parsed.cfgs);
  if (!sheets.some((s) => s.rows.length)) return NextResponse.json({ error: 'The ticked sheets are empty.' }, { status: 400 });
  const types = [...new Set(sheets.map((s) => s.type))] as ProductType[];

  let blocked: string | null = null;
  if (mode === 'OVERWRITE') {
    for (const t of types) {
      const n = await historyCount(svc, t);
      if (n > 0) {
        blocked = `Overwrite is blocked: ${n} movement / order record(s) already exist for ${TYPE_META[t].label.toLowerCase()}. ` +
          `Switch to "Add to current stock", or clear the data first.`;
        break;
      }
    }
  }

  const all = await loadAllSkus(svc);
  const existingByKey = new Map(all.filter((s) => s.identity_key).map((s) => [s.identity_key as string, s]));
  const takenCodes = new Set(all.map((s) => s.sku_code));

  interface Planned {
    sheet: string; rowNum: number; type: ProductType;
    id: Identity;
    sku: ExistingSku | null;       // null => will be created
    lot: LotType | null;
    uom: number | null;
    qty: number;                   // 0 = no stock to load
    location: string;
    remarks: string;
    msl: number | null;
  }

  const planned: Planned[] = [];
  const pendingNew = new Map<string, { id: Identity; code: string }>(); // identity key -> new SKU
  const mslByKey = new Map<string, number>();
  type PreviewRow = {
    sheet: string; rowNum: number; status: 'MATCH' | 'NEW_SKU' | 'FIX' | 'ERROR'; skuCode: string; family: string;
    sectionOrColour: string; size: string; brand: string; lot: string; load: string; msl: string; note: string;
  };
  interface Issue { sheet: string; row: number; kind: 'MISSING' | 'SKIPPED' | 'FILLED'; text: string }
  const preview: PreviewRow[] = [];
  const issues: Issue[] = [];
  const perSheet: { name: string; type: ProductType; rows: number; matched: number; newSkus: number; incomplete: number; skipped: number; load: number }[] = [];
  let lotsToCreate = 0, totalLoad = 0, matched = 0, incomplete = 0, skipped = 0, filledRows = 0, noStock = 0;

  for (const sh of sheets) {
    const meta = TYPE_META[sh.type];
    const stat = { name: sh.name, type: sh.type, rows: 0, matched: 0, newSkus: 0, incomplete: 0, skipped: 0, load: 0 };
    const seenInSheet = new Set<string>();

    for (const row of sh.rows) {
      if (!rowHasData(sh.mapping, row)) continue;
      stat.rows++;
      const rowNum = row.__row;
      const push = (p: PreviewRow) => { if (preview.length < PREVIEW_LIMIT) preview.push(p); };
      const issue = (kind: Issue['kind'], text: string) => issues.push({ sheet: sh.name, row: rowNum, kind, text });

      const filled = sh.filled.get(rowNum);
      if (filled?.length) { filledRows++; issue('FILLED', `${filled.join(', ')} was blank — copied from the row above`); }

      const built = buildIdentity(sh.type, rawIdentityOf(sh.mapping, row));
      if (isIdentityError(built)) {
        skipped++; stat.skipped++;
        issue('SKIPPED', built.error);
        push({ sheet: sh.name, rowNum, status: 'ERROR', skuCode: '—', family: '', sectionOrColour: '', size: '', brand: '', lot: '', load: '', msl: '', note: built.error });
        continue;
      }

      const notes: string[] = [];
      if (built.missing.length) {
        notes.push(`Missing: ${built.missing.join(', ')}`);
        issue('MISSING', `Missing ${built.missing.join(', ')} — product saved as UNSPECIFIED and flagged`);
      }

      // ── stock on this row ──
      let lot: LotType | null = null;
      let uom: number | null = null;
      let qty = toNumber(cellOf(sh.mapping, row, 'qty')) ?? 0;
      const rawQty = String(cellOf(sh.mapping, row, 'qty') ?? '').trim();
      if (rawQty !== '' && toNumber(rawQty) === null) {
        issue('SKIPPED', `QTY "${rawQty}" is not a number — product kept, no stock loaded from this row`);
        notes.push('QTY not a number — no stock loaded');
        qty = 0;
      }
      if (qty < 0) { issue('SKIPPED', 'QTY is negative — no stock loaded from this row'); notes.push('Negative QTY — no stock loaded'); qty = 0; }

      if (qty > 0 && meta.usesLots) {
        lot = parseLotType(cellOf(sh.mapping, row, 'lot_type'));
        if (!lot) {
          lot = 'FULL_SLEEVE';
          issue('MISSING', 'Cut Pcs / Full Sleeve is blank or unreadable — loaded as Full Sleeve');
          notes.push('Cut/Full missing → Full Sleeve');
        }
        uom = toNumber(cellOf(sh.mapping, row, 'uom_mm'));
        if (uom === null || uom <= 0) {
          issue('SKIPPED', 'UOM in MM is missing — product kept, no stock loaded from this row');
          notes.push('UOM in MM missing — no stock loaded'); qty = 0; lot = null; uom = null;
        } else if (!Number.isInteger(qty)) {
          issue('SKIPPED', 'QTY must be a whole number of pieces — product kept, no stock loaded from this row');
          notes.push('QTY not whole — no stock loaded'); qty = 0; lot = null; uom = null;
        } else if (qty > MAX_PIECES_PER_ROW) {
          issue('SKIPPED', `QTY ${qty} is above the ${MAX_PIECES_PER_ROW}-piece limit per row — no stock loaded`);
          notes.push('QTY too large — no stock loaded'); qty = 0; lot = null; uom = null;
        }
      }
      if (qty === 0) noStock++;

      const msl = readMsl(sh.mapping, row, sh.type);
      if (msl !== null) mslByKey.set(built.key, Math.max(mslByKey.get(built.key) ?? 0, msl));

      let sku = existingByKey.get(built.key) ?? null;
      if (!sku) {
        if (!pendingNew.has(built.key)) {
          const code = uniqueSkuCode(built, takenCodes);
          takenCodes.add(code);
          pendingNew.set(built.key, { id: built, code });
          stat.newSkus++;
          if (built.missing.length) { incomplete++; stat.incomplete++; }
        }
      } else if (!seenInSheet.has(built.key)) {
        matched++; stat.matched++;
      }
      seenInSheet.add(built.key);
      const newCode = sku ? null : pendingNew.get(built.key)!.code;

      planned.push({
        sheet: sh.name, rowNum, type: sh.type, id: built, sku, lot, uom, qty,
        location: cleanText(cellOf(sh.mapping, row, 'location')),
        remarks: cleanText(cellOf(sh.mapping, row, 'remarks')),
        msl,
      });

      const load = qty === 0 ? 0 : meta.usesLots ? qty * (uom as number) : qty;
      if (meta.usesLots) lotsToCreate += qty;
      totalLoad += load; stat.load += load;

      push({
        sheet: sh.name, rowNum,
        status: built.missing.length ? 'FIX' : sku ? 'MATCH' : 'NEW_SKU',
        skuCode: sku ? sku.sku_code : (newCode as string),
        family: built.family, sectionOrColour: built.section ?? built.colour ?? '',
        size: built.sizeLabel, brand: built.brand,
        lot: lot ? (lot === 'FULL_SLEEVE' ? 'Full Sleeve' : 'Cut Pcs') : '',
        load: qty === 0 ? 'no stock' : meta.usesLots ? `${qty} × ${uom} mm = ${load} mm` : `+${load} pcs`,
        msl: msl === null ? '' : String(msl),
        note: notes.join(' · ') || (sku ? 'Matched to existing SKU' : 'SKU not in Product Master — will be created'),
      });
    }
    perSheet.push(stat);
  }

  const summary = {
    rows: perSheet.reduce((a, s) => a + s.rows, 0),
    matched,
    newSkus: pendingNew.size,
    newSkuList: [...pendingNew.values()].slice(0, 30).map((p) => p.code),
    lotsToCreate,
    totalLoad,
    noStock,
    incomplete,
    skipped,
    filledRows,
    withMsl: mslByKey.size,
    unit: types.every((t) => TYPE_META[t].unit === 'MM') ? 'mm' : types.every((t) => TYPE_META[t].unit === 'PCS') ? 'pcs' : 'mm / pcs',
    errors: skipped,
    mode,
  };

  if (dryRun) {
    return NextResponse.json({ dryRun: true, blocked, summary, perSheet, preview, issues: issues.slice(0, 600), issueCount: issues.length });
  }
  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });
  if (!planned.length) return NextResponse.json({ error: 'No rows to import.' }, { status: 400 });

  // ── Real run ────────────────────────────────────────────────────────────────
  if (mode === 'OVERWRITE') {
    for (const t of types) {
      const { error } = await svc.rpc('wipe_inventory_type', { p_type: t });
      if (error) return NextResponse.json({ error: error.message }, { status: 409 });
    }
  }
  const errors: string[] = issues.filter((i) => i.kind === 'SKIPPED').map((i) => `${i.sheet} row ${i.row}: ${i.text}`);

  // 1. Create the SKUs that weren't in Product Master
  const createdCodes: string[] = [];
  const newIdByKey = new Map<string, string>();
  if (pendingNew.size) {
    try {
      const byType = new Map<ProductType, [string, { id: Identity; code: string }][]>();
      for (const e of pendingNew.entries()) byType.set(e[1].id.type, [...(byType.get(e[1].id.type) ?? []), e]);
      for (const [type, list] of byType) {
        const { brandId, familyId } = await ensureBrandsAndFamilies(svc, type, list.map(([, v]) => v.id));
        const rowsToInsert = list.map(([key, v]) =>
          newSkuRow(v.id, v.code, familyId.get(v.id.family)!, brandId.get(v.id.brand)!, 'INVENTORY_IMPORT', mslByKey.get(key) ?? null));
        const res = await insertSkus(svc, rowsToInsert);
        for (const [key, v] of list) {
          const id = res.idByCode.get(v.code);
          if (id) { newIdByKey.set(key, id); createdCodes.push(v.code); }
        }
        for (const e of res.errors) errors.push(`New SKU ${e.skuCode}: ${e.message}`);
      }
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // Resolve each planned row to a SKU id (skipping rows whose new SKU failed)
  interface Target { skuId: string; isNew: boolean; baseStock: number; basePhysical: number; added: number; location: string; remarks: string; setMsl: number | null }
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
        // Physical (production-available) stock moves together with book stock.
        basePhysical: mode === 'OVERWRITE' || !p.sku ? 0 : Number(p.sku.physical_prod_stock ?? 0),
        added: 0,
        location: '',
        remarks: '',
        // New SKUs got their MSL at insert; for existing ones only fill it in when it was never set.
        setMsl: p.sku && Number(p.sku.min_stock_level ?? 0) === 0 && mslByKey.has(key) ? (mslByKey.get(key) as number) : null,
      });
    }
    const t = targets.get(key)!;
    if (p.location) t.location = p.location;
    if (p.remarks) t.remarks = p.remarks;
  }

  // 2. Load the stock
  let lotsCreated = 0;
  for (const p of planned) {
    const t = targets.get(p.id.key);
    if (!t || p.qty <= 0) continue;

    if (TYPE_META[p.type].usesLots && p.lot && p.uom) {
      for (let n = 0; n < p.qty; n++) {
        const { error } = await svc.rpc('create_opening_lot', {
          p_sku_id: t.skuId,
          p_qty: p.uom,
          p_status: p.lot,
          p_roll_length: p.uom, // every lot carries its own length (UOM in MM from the sheet)
          p_notes: 'Imported from inventory sheet',
        });
        if (error) { errors.push(`${p.sheet} row ${p.rowNum}: lot ${n + 1}/${p.qty} failed — ${error.message}`); break; }
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
    const patch: Record<string, unknown> = {
      current_stock: current,
      physical_prod_stock: t.basePhysical + t.added,
      updated_at: new Date().toISOString(),
    };
    if (t.isNew || mode === 'OVERWRITE') patch.opening_stock = current;
    if (t.location) patch.rack_location = t.location;
    if (t.remarks) patch.remarks = t.remarks;
    if (t.setMsl !== null) patch.min_stock_level = t.setMsl;
    const { error } = await svc.from('skus').update(patch).eq('id', t.skuId);
    if (error) errors.push(`Stock update failed for SKU ${t.skuId}: ${error.message}`);
    else updatedSkus++;
  }

  try {
    await svc.from('import_batches').insert({
      file_name: file.name,
      mode: 'REPLACE',
      counts: { kind: 'INVENTORY', sheets: sheets.map((s) => s.name), importMode: mode, skusTouched: updatedSkus, newSkus: createdCodes.length, lots: lotsCreated, incomplete, errors: errors.length, rows: summary.rows },
    });
  } catch { /* non-critical */ }

  return NextResponse.json({
    dryRun: false,
    skusUpdated: updatedSkus,
    newSkus: createdCodes,
    lotsCreated,
    incomplete,
    totalLoad,
    unit: summary.unit,
    perSheet,
    errors,
  });
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (e) {
    return importErrorResponse(e);
  }
}
