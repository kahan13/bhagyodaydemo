#!/usr/bin/env node
/**
 * promote.mjs — copy the verified changes from THIS (local) project into the CLIENT project.
 *
 *   node scripts/promote.mjs --client C:\bhagyoday-belts            (preview only, changes nothing)
 *   node scripts/promote.mjs --client C:\bhagyoday-belts --apply    (backs up, copies, lists the SQL to run)
 *
 * What it does
 *   1. Compares every project file by CONTENT (not by date) between local and client.
 *   2. Lists NEW and CHANGED files. A file that is only in the client is never touched or deleted.
 *   3. Never copies: node_modules, .next, .git, .env*, build output, local-only setup files.
 *   4. With --apply: first saves a copy of every client file it is about to overwrite
 *      (<client>\..\bhagyoday-promote-backup-<time>\), then copies, then prints exactly which
 *      supabase\*.sql files are new / changed — run those in the CLIENT'S Supabase SQL Editor, in order.
 *   5. Warns when a file looks edited in the client more recently than here (possible conflict).
 *
 * It does not touch git, the client's .env.local, or the client's Supabase.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

const LOCAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.resolve(opt('--client') ?? 'C:\\bhagyoday-belts');
const APPLY = flag('--apply');

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.vercel', 'out', 'build', 'coverage']);
const SKIP_FILES = [
  /^\.env(\..*)?$/i, /\.tsbuildinfo$/i, /^\.DS_Store$/i, /^npm-debug\.log/i,
  /^00_FULL_SETUP_fresh_project\.sql$/i,   // fresh-project installer — must NEVER be run on the client's database
  /^setup-local\.ps1$/i,
];

const say = (s = '') => console.log(s);
const die = (s) => { console.error('\nSTOP: ' + s + '\n'); process.exit(1); };

if (!fs.existsSync(path.join(LOCAL, 'package.json'))) die(`This script must live in the project's scripts folder (looked in ${LOCAL}).`);
if (!fs.existsSync(CLIENT) || !fs.existsSync(path.join(CLIENT, 'package.json'))) die(`Client folder not found or not a project: ${CLIENT}\nPass it with --client "C:\\path\\to\\client".`);
if (CLIENT === LOCAL) die('Local and client are the same folder.');

// Safety: the two projects must point at DIFFERENT Supabase projects.
const envUrl = (dir) => {
  try {
    const m = fs.readFileSync(path.join(dir, '.env.local'), 'utf8').match(/^\s*NEXT_PUBLIC_SUPABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
    return m ? m[1].trim().replace(/\/$/, '') : null;
  } catch { return null; }
};
const lu = envUrl(LOCAL), cu = envUrl(CLIENT);
if (lu && cu && lu === cu) die('Local and client .env.local point at the SAME Supabase project. Fix that first.');

function walk(root) {
  const out = new Map();
  (function rec(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) rec(path.join(dir, e.name)); continue; }
      if (SKIP_FILES.some((re) => re.test(e.name))) continue;
      const full = path.join(dir, e.name);
      out.set(path.relative(root, full).split(path.sep).join('/'), full);
    }
  })(root);
  return out;
}
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

const L = walk(LOCAL), C = walk(CLIENT);
const created = [], changed = [], conflicts = [];
for (const [rel, lf] of L) {
  const cf = C.get(rel);
  if (!cf) { created.push(rel); continue; }
  if (sha(lf) === sha(cf)) continue;
  changed.push(rel);
  // client edited AFTER the local copy was edited => someone may have changed it on the client side
  if (fs.statSync(cf).mtimeMs > fs.statSync(lf).mtimeMs + 2000) conflicts.push(rel);
}
created.sort(); changed.sort();

say(`Local : ${LOCAL}`);
say(`Client: ${CLIENT}`);
say(APPLY ? 'Mode  : APPLY (copies files)\n' : 'Mode  : PREVIEW (changes nothing — add --apply to copy)\n');

if (!created.length && !changed.length) { say('Nothing to promote — the client is already identical.'); process.exit(0); }

if (created.length) { say(`NEW in client (${created.length}):`); created.forEach((f) => say('  + ' + f)); say(); }
if (changed.length) { say(`CHANGED (${changed.length}):`); changed.forEach((f) => say('  ~ ' + f + (conflicts.includes(f) ? '   <-- client copy is NEWER, check before overwriting' : ''))); say(); }

const sql = [...created, ...changed].filter((f) => /^supabase\/(migrations\/)?\d{3}[a-z]?_[^/]*\.sql$/i.test(f)).sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
const pkg = [...created, ...changed].some((f) => f === 'package.json' || f === 'package-lock.json');

if (conflicts.length && APPLY && !flag('--force')) {
  die(`${conflicts.length} file(s) were edited in the client more recently than here (listed above).\n` +
      'Open those, copy anything you want to keep into the local project, then run again — or add --force to overwrite them anyway (a backup is still made).');
}

if (!APPLY) {
  say('SQL to run in the CLIENT\'s Supabase (after --apply), in this order:');
  if (sql.length) sql.forEach((f) => say('  ' + f)); else say('  (none)');
  say('\nLooks right? Run the same command with --apply.');
  process.exit(0);
}

// ── apply ──
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const backup = path.join(path.dirname(CLIENT), `bhagyoday-promote-backup-${stamp}`);
let copied = 0;
for (const rel of [...changed, ...created]) {
  const dest = path.join(CLIENT, ...rel.split('/'));
  if (fs.existsSync(dest)) {
    const b = path.join(backup, ...rel.split('/'));
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.copyFileSync(dest, b);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(L.get(rel), dest);
  copied++;
}
say(`Copied ${copied} file(s) to the client.`);
if (changed.length) say(`Backup of the ${changed.length} overwritten client file(s): ${backup}`);

say('\n=== NEXT STEPS ===');
let n = 1;
if (sql.length) {
  say(`${n++}. Client's Supabase → SQL Editor → run these, ONE AT A TIME, in this order (each is safe to re-run):`);
  sql.forEach((f) => say('     ' + f));
} else say(`${n++}. No new SQL — nothing to run in Supabase.`);
if (pkg) say(`${n++}. package.json changed → in the client folder run:  npm install`);
say(`${n++}. In the client folder:  npm run build     (must finish with no errors)`);
say(`${n++}. Then commit and push as usual:  git add -A ; git commit -m "..." ; git push`);
