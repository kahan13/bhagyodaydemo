import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { supabaseService } from '@/lib/supabase-server';
import { SKU_FIELDS, TYPE_META, toCode, type Identity } from '@/lib/sheet-config';
import type { ProductType } from '@/lib/types';
import {
  importErrorResponse, PREVIEW_LIMIT, ensureBrandsAndFamilies, historyCount, insertSkus, isIdentityError,
  loadAllSkus, loadBrandFamilyNames, loadSheets, newSkuRow, parseSheetCfgs, rawIdentityOf, readMsl, rowHasData,
  buildIdentity, uniqueSkuCode, unmappedRequired,
} from '@/lib/sheet-import-server';

export const dynamic = 'force-dynamic';

/**
 * PRODUCTS import — creates SKUs (the product master) from identity columns only.
 * One request can carry SEVERAL sheets of one workbook (field `sheets`), each with its
 * own product type and column mapping.
 *
 * A row with a blank Make / Section / Size / Family is NOT skipped: the product is created
 * with the value UNSPECIFIED and flagged (skus.missing_fields). The preview lists every such
 * row so it can be fixed in the sheet first. Only a row with no product details at all is skipped.
 *
 * mode:
 *   OVERWRITE  wipe each involved product type's products once, then import fresh
 *              (refused with a clear message if that type already has history)
 *   ADD        keep what exists, create only products that aren't there yet
 *
 * dryRun=true returns the preview/summary without touching the database.
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
    const missing = unmappedRequired(SKU_FIELDS[c.type], c.mapping);
    if (missing.length) {
      return NextResponse.json({ error: `Sheet "${c.name}": map these required fields first: ${missing.join(', ')}.` }, { status: 400 });
    }
  }

  const sheets = await loadSheets(file, parsed.cfgs);
  if (!sheets.some((s) => s.rows.length)) return NextResponse.json({ error: 'The ticked sheets are empty.' }, { status: 400 });

  const types = [...new Set(sheets.map((s) => s.type))] as ProductType[];

  // History check (only matters for Overwrite)
  let blocked: string | null = null;
  if (mode === 'OVERWRITE') {
    for (const t of types) {
      const n = await historyCount(svc, t);
      if (n > 0) {
        blocked = `Overwrite is blocked: ${n} movement / order record(s) already reference ${TYPE_META[t].label.toLowerCase()}. ` +
          `Use Admin → "Wipe all products" (only possible before any movements), or switch to "Add new only".`;
        break;
      }
    }
  }

  const all = await loadAllSkus(svc);
  // In overwrite, the involved types' SKUs will be gone — don't count them as existing or as taken codes.
  const surviving = mode === 'OVERWRITE' ? all.filter((s) => !types.includes(s.product_type as ProductType)) : all;
  const existingByKey = new Map(
    surviving.filter((s) => s.identity_key).map((s) => [s.identity_key as string, s]));
  const takenCodes = new Set(surviving.map((s) => s.sku_code));

  const brandCodes = new Set<string>();
  const familyCodes = new Set<string>();
  for (const t of types) {
    const r = await loadBrandFamilyNames(svc, t);
    r.brandCodes.forEach((c) => brandCodes.add(c));
    // Overwrite deletes these types' families too, so every family counts as new then.
    if (mode !== 'OVERWRITE') r.familyCodes.forEach((c) => familyCodes.add(`${t}:${c}`));
  }

  type PreviewRow = {
    sheet: string; rowNum: number; status: 'NEW' | 'FIX' | 'EXISTS' | 'DUPLICATE' | 'ERROR';
    skuCode: string; family: string; sectionOrColour: string; size: string; brand: string; msl: string; note: string;
  };
  interface Issue { sheet: string; row: number; kind: 'MISSING' | 'SKIPPED' | 'FILLED'; text: string }
  const preview: PreviewRow[] = [];
  const issues: Issue[] = [];
  const perSheet: { name: string; type: ProductType; rows: number; newSkus: number; existing: number; duplicates: number; incomplete: number; skipped: number }[] = [];
  const seen = new Map<string, string>(); // identity key -> assigned sku code (this run)
  const toCreate: { id: Identity; code: string; msl: number | null }[] = [];
  const createByKey = new Map<string, { id: Identity; code: string; msl: number | null }>();
  let existing = 0, duplicates = 0, incomplete = 0, skipped = 0, filledRows = 0;
  const newBrands = new Set<string>(), newFamilies = new Set<string>();

  for (const sh of sheets) {
    const stat = { name: sh.name, type: sh.type, rows: 0, newSkus: 0, existing: 0, duplicates: 0, incomplete: 0, skipped: 0 };
    for (const row of sh.rows) {
      if (!rowHasData(sh.mapping, row)) continue;
      stat.rows++;
      const rowNum = row.__row;
      const push = (p: PreviewRow) => { if (preview.length < PREVIEW_LIMIT) preview.push(p); };
      const filled = sh.filled.get(rowNum);
      if (filled?.length) {
        filledRows++;
        issues.push({ sheet: sh.name, row: rowNum, kind: 'FILLED', text: `${filled.join(', ')} was blank — copied from the row above` });
      }
      const msl = readMsl(sh.mapping, row, sh.type);
      const built = buildIdentity(sh.type, rawIdentityOf(sh.mapping, row));

      if (isIdentityError(built)) {
        skipped++; stat.skipped++;
        issues.push({ sheet: sh.name, row: rowNum, kind: 'SKIPPED', text: built.error });
        push({ sheet: sh.name, rowNum, status: 'ERROR', skuCode: '—', family: '', sectionOrColour: '', size: '', brand: '', msl: '', note: built.error });
        continue;
      }
      const fixNote = built.missing.length ? `Missing: ${built.missing.join(', ')}` : '';
      if (built.missing.length) {
        issues.push({ sheet: sh.name, row: rowNum, kind: 'MISSING', text: `Missing ${built.missing.join(', ')} — will be saved as ${'UNSPECIFIED'} and flagged` });
      }
      const secOrCol = built.section ?? built.colour ?? '';
      const base = {
        sheet: sh.name, rowNum, family: built.family, sectionOrColour: secOrCol, size: built.sizeLabel,
        brand: built.brand, msl: msl === null ? '' : String(msl),
      };

      if (seen.has(built.key)) {
        duplicates++; stat.duplicates++;
        const planned = createByKey.get(built.key);
        if (planned && planned.msl === null && msl !== null) planned.msl = msl;
        push({ ...base, status: 'DUPLICATE', skuCode: seen.get(built.key)!, note: 'Same product appears earlier — one SKU only' });
        continue;
      }
      const ex = existingByKey.get(built.key);
      if (ex) {
        seen.set(built.key, ex.sku_code);
        existing++; stat.existing++;
        push({ ...base, status: 'EXISTS', skuCode: ex.sku_code, note: 'Already in Product Master — kept as is' });
        continue;
      }
      const code = uniqueSkuCode(built, takenCodes);
      takenCodes.add(code);
      seen.set(built.key, code);
      const planned = { id: built, code, msl };
      toCreate.push(planned);
      createByKey.set(built.key, planned);
      stat.newSkus++;
      if (built.missing.length) { incomplete++; stat.incomplete++; }
      if (!brandCodes.has(toCode(built.brand))) newBrands.add(built.brand);
      if (!familyCodes.has(`${sh.type}:${toCode(built.family)}`)) newFamilies.add(built.family);
      push({ ...base, status: built.missing.length ? 'FIX' : 'NEW', skuCode: code, note: fixNote || 'Will be created' });
    }
    perSheet.push(stat);
  }

  const summary = {
    rows: perSheet.reduce((a, s) => a + s.rows, 0),
    newSkus: toCreate.length,
    existing,
    duplicates,
    incomplete,
    skipped,
    filledRows,
    errors: skipped,
    withMsl: toCreate.filter((t) => t.msl !== null).length,
    newBrands: [...newBrands],
    newFamilies: [...newFamilies],
    mode,
  };

  if (dryRun) {
    return NextResponse.json({ dryRun: true, blocked, summary, perSheet, preview, issues: issues.slice(0, 600), issueCount: issues.length });
  }

  if (blocked) return NextResponse.json({ error: blocked }, { status: 409 });

  // ── Real run ────────────────────────────────────────────────────────────────
  if (mode === 'OVERWRITE') {
    for (const t of types) {
      const { error } = await svc.rpc('wipe_catalog_type', { p_type: t });
      if (error) return NextResponse.json({ error: error.message }, { status: 409 });
    }
  }

  let created = 0;
  const failed: string[] = [];
  const byType = new Map<ProductType, { id: Identity; code: string; msl: number | null }[]>();
  for (const t of toCreate) byType.set(t.id.type, [...(byType.get(t.id.type) ?? []), t]);

  for (const [type, list] of byType) {
    try {
      const { brandId, familyId } = await ensureBrandsAndFamilies(svc, type, list.map((t) => t.id));
      const skuRows = list.map(({ id, code, msl }) =>
        newSkuRow(id, code, familyId.get(id.family)!, brandId.get(id.brand)!, 'SKU_IMPORT', msl));
      const res = await insertSkus(svc, skuRows);
      created += res.idByCode.size;
      for (const e of res.errors) failed.push(`${e.skuCode}: ${e.message}`);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  try {
    await svc.from('import_batches').insert({
      file_name: file.name,
      mode: 'REPLACE', // legacy column; the real choice is recorded in counts
      counts: { kind: 'SKU', sheets: sheets.map((s) => s.name), importMode: mode, created, existing, duplicates, incomplete, skipped, errors: skipped + failed.length, rows: summary.rows },
    });
  } catch { /* non-critical */ }

  return NextResponse.json({
    dryRun: false,
    created,
    existing,
    duplicates,
    incomplete,
    perSheet,
    errors: [...issues.filter((i) => i.kind === 'SKIPPED').map((i) => `${i.sheet} row ${i.row}: ${i.text}`), ...failed],
  });
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (e) {
    return importErrorResponse(e);
  }
}
