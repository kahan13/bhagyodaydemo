import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/auth';
import { supabaseService } from '@/lib/supabase-server';
import { MSL_FIELDS, type Identity } from '@/lib/sheet-config';
import {
  importErrorResponse, PREVIEW_LIMIT, cellOf, loadAllSkus, loadSheets, parseSheetCfgs, rawIdentityOf, readMsl, rowHasData,
  buildIdentity, isIdentityError, unmappedRequired,
} from '@/lib/sheet-import-server';

export const dynamic = 'force-dynamic';

/**
 * MSL import — sets ONLY the minimum stock level (MSL) of products that already exist.
 *
 * Rows are matched to products by identity (Family + Section + Size + Make …), exactly like the
 * Inventory import. It never creates a product, never touches stock, lots or anything else.
 * MSL counts pieces (timing belts: pieces of belt; V / conveyor: pieces).
 *
 * mslMode:
 *   FILL       only products whose MSL is not set (0) get one — existing MSLs are left alone
 *   OVERWRITE  the sheet's MSL replaces the existing one
 *
 * dryRun=true returns the preview/summary without touching the database.
 */
async function handle(req: Request) {
  await requirePermission('settings.import');
  const svc = await supabaseService();

  const fd = await req.formData();
  const file = fd.get('file') as File | null;
  const dryRun = fd.get('dryRun') === 'true';
  const overwrite = fd.get('mslMode') === 'OVERWRITE';
  if (!file) return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });

  const parsed = parseSheetCfgs(fd);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
  for (const c of parsed.cfgs) {
    const missing = unmappedRequired(MSL_FIELDS[c.type], c.mapping);
    if (missing.length) {
      return NextResponse.json({ error: `Sheet "${c.name}": map these required fields first: ${missing.join(', ')}.` }, { status: 400 });
    }
  }

  const sheets = await loadSheets(file, parsed.cfgs);
  if (!sheets.some((s) => s.rows.length)) return NextResponse.json({ error: 'The ticked sheets are empty.' }, { status: 400 });

  const all = await loadAllSkus(svc);
  const byKey = new Map(all.filter((s) => s.identity_key).map((s) => [s.identity_key as string, s]));

  type Status = 'UPDATE' | 'SAME' | 'KEEP' | 'NOT_FOUND' | 'NO_MSL';
  interface PreviewRow {
    sheet: string; rowNum: number; status: Status; skuCode: string;
    family: string; sectionOrColour: string; size: string; brand: string; was: string; msl: string; note: string;
  }
  interface Issue { sheet: string; row: number; kind: 'MISSING' | 'SKIPPED' | 'FILLED'; text: string }
  const preview: PreviewRow[] = [];
  const issues: Issue[] = [];
  const perSheet: { name: string; type: string; rows: number; update: number; same: number; keep: number; notFound: number; noMsl: number }[] = [];
  const want = new Map<string, { skuId: string; code: string; msl: number }>(); // identity key -> value to write
  let update = 0, same = 0, keep = 0, notFound = 0, noMsl = 0;

  for (const sh of sheets) {
    const st = { name: sh.name, type: sh.type, rows: 0, update: 0, same: 0, keep: 0, notFound: 0, noMsl: 0 };
    for (const row of sh.rows) {
      if (!rowHasData(sh.mapping, row)) continue;
      st.rows++;
      const rowNum = row.__row;
      const push = (p: PreviewRow) => { if (preview.length < PREVIEW_LIMIT) preview.push(p); };
      const issue = (kind: Issue['kind'], text: string) => issues.push({ sheet: sh.name, row: rowNum, kind, text });

      const built = buildIdentity(sh.type, rawIdentityOf(sh.mapping, row));
      const rawMsl = String(cellOf(sh.mapping, row, 'msl') ?? '').trim();
      const msl = readMsl(sh.mapping, row, sh.type);
      const base = (b: Identity | null) => ({
        sheet: sh.name, rowNum,
        family: b?.family ?? '', sectionOrColour: b ? (b.section ?? b.colour ?? '') : '', size: b?.sizeLabel ?? '', brand: b?.brand ?? '',
        msl: msl === null ? rawMsl : String(msl),
      });

      if (isIdentityError(built)) {
        noMsl++; st.noMsl++;
        issue('SKIPPED', built.error);
        push({ ...base(null), status: 'NOT_FOUND', skuCode: '—', was: '', note: built.error });
        continue;
      }
      if (msl === null) {
        noMsl++; st.noMsl++;
        const why = rawMsl === '' ? 'no MSL on this row' : `MSL "${rawMsl}" is not a number`;
        issue('SKIPPED', `${built.displayName}: ${why}`);
        push({ ...base(built), status: 'NO_MSL', skuCode: '—', was: '', note: `Skipped — ${why}` });
        continue;
      }
      const sku = byKey.get(built.key);
      if (!sku) {
        notFound++; st.notFound++;
        issue('SKIPPED', `${built.displayName} (${built.family}) is not in Product Master — import it under 1 · Products first`);
        push({ ...base(built), status: 'NOT_FOUND', skuCode: '—', was: '', note: 'Not in Product Master' });
        continue;
      }
      const current = Number(sku.min_stock_level ?? 0);
      const was = current > 0 ? String(current) : 'not set';
      const common = { ...base(built), skuCode: sku.sku_code, was };
      // The same product twice in the sheets: the highest MSL wins.
      const prev = want.get(built.key);
      const value = prev ? Math.max(prev.msl, msl) : msl;

      if (current === value && current > 0) {
        same++; st.same++;
        push({ ...common, status: 'SAME', note: 'Already this MSL' });
      } else if (current > 0 && !overwrite) {
        keep++; st.keep++;
        push({ ...common, status: 'KEEP', note: 'Has an MSL already — kept (switch to Overwrite to replace)' });
      } else {
        if (!prev) { update++; st.update++; }
        want.set(built.key, { skuId: sku.id, code: sku.sku_code, msl: value });
        push({ ...common, status: 'UPDATE', note: current > 0 ? `Changes ${current} → ${value}` : 'Will be set' });
      }
    }
    perSheet.push(st);
  }

  const summary = {
    rows: perSheet.reduce((a, s) => a + s.rows, 0),
    update, same, keep, notFound, noMsl,
    errors: notFound + noMsl,
    overwrite,
  };

  if (dryRun) {
    return NextResponse.json({ dryRun: true, blocked: null, summary, perSheet, preview, issues: issues.slice(0, 600), issueCount: issues.length });
  }
  if (!want.size) return NextResponse.json({ error: 'Nothing to update — see the preview for why.' }, { status: 400 });

  // One update per distinct MSL value (MSLs repeat a lot: 50, 2, 1 …), not one per product.
  const byValue = new Map<number, string[]>();
  for (const w of want.values()) byValue.set(w.msl, [...(byValue.get(w.msl) ?? []), w.skuId]);
  const errors: string[] = [];
  let updated = 0;
  for (const [value, ids] of byValue) {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { error } = await svc.from('skus').update({ min_stock_level: value, updated_at: new Date().toISOString() }).in('id', chunk);
      if (error) errors.push(`MSL ${value}: ${error.message}`);
      else updated += chunk.length;
    }
  }

  try {
    await svc.from('import_batches').insert({
      file_name: file.name, mode: 'REPLACE',
      counts: { kind: 'MSL', sheets: sheets.map((s) => s.name), overwrite, updated, kept: keep, notFound, noMsl },
    });
  } catch { /* non-critical */ }

  return NextResponse.json({
    dryRun: false, updated, kept: keep, same, notFound, noMsl, perSheet,
    errors: [...issues.filter((i) => i.kind === 'SKIPPED').map((i) => `${i.sheet} row ${i.row}: ${i.text}`), ...errors],
  });
}

export async function POST(req: Request) {
  try {
    return await handle(req);
  } catch (e) {
    return importErrorResponse(e);
  }
}
