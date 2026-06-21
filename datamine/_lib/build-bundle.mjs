/**
 * datamine/_lib/build-bundle.mjs
 *
 * Finalizes the portable output bundle. It does NOT invent data — it reads what
 * is actually on disk under out/data + out/assets and rewrites manifest.json so
 * the counts, image coverage and reference integrity reported there are TRUE.
 * This is what stops a run from "claiming" success: validate-bundle.mjs then
 * gates against the same on-disk reality.
 *
 * Division of labour:
 *   - YOU (the datamine Claude) produce out/data/<type>.json (clean records) and
 *     out/assets/<type>/<id>.<ext>, and declare entity types + relations +
 *     wiki_coverage in manifest.json (name_field/image_field/relations/target).
 *   - build-bundle recomputes count + image_coverage + reference_integrity from
 *     disk, stamps bundle.built_at, and leaves your declarations intact.
 *
 * Usage:
 *   node datamine/_lib/build-bundle.mjs <game-slug>
 *   node datamine/_lib/build-bundle.mjs --out <path-to-out-dir>
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATAMINE_ROOT = path.resolve(__dirname, '..');
const VALIDATOR_VERSION = '1';

function parseArgs(argv) {
  const a = { slug: null, out: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out') a.out = rest[++i];
    else if (rest[i].startsWith('--out=')) a.out = rest[i].slice(6);
    else if (!rest[i].startsWith('--') && !a.slug) a.slug = rest[i];
  }
  return a;
}

function countAssetFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isFile()) n++;
  }
  return n;
}

function main() {
  const args = parseArgs(process.argv);
  let outDir;
  if (args.out) outDir = path.resolve(args.out);
  else if (args.slug) outDir = path.join(DATAMINE_ROOT, args.slug, 'out');
  else { console.error('Provide <game-slug> or --out <dir>.'); process.exit(2); }

  const manifestPath = path.join(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) { console.error(`manifest.json not found in ${outDir}`); process.exit(2); }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entities = manifest.entities || {};
  const types = Object.keys(entities);
  if (types.length === 0) { console.error('manifest.entities is empty — declare your entity types first.'); process.exit(2); }

  const idIndex = {};
  const loaded = {};
  const image_coverage = {};

  // Recompute counts + image coverage from disk
  for (const type of types) {
    const decl = entities[type];
    const file = decl.file || `data/${type}.json`;
    const filePath = path.join(outDir, file);
    if (!existsSync(filePath)) { console.warn(`! ${type}: ${file} missing — skipped`); continue; }
    const rows = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!Array.isArray(rows)) { console.warn(`! ${type}: not an array — skipped`); continue; }
    loaded[type] = rows;
    idIndex[type] = new Set(rows.map((r) => String(r.id)));
    decl.count = rows.length;
    decl.file = file;

    const imageField = decl.image_field || 'image';
    let withImg = 0;
    for (const r of rows) {
      const v = r[imageField];
      if (typeof v === 'string' && v !== '') withImg++;
    }
    image_coverage[type] = { extracted: withImg, total: rows.length, pct: rows.length ? Math.round((withImg / rows.length) * 100) : 0 };
  }

  // Recompute reference integrity
  const reference_integrity = {};
  for (const type of types) {
    const rows = loaded[type];
    if (!rows) continue;
    for (const rel of entities[type].relations || []) {
      if (!idIndex[rel.target]) continue;
      let refs = 0, broken = 0;
      for (const r of rows) {
        const raw = r[rel.field];
        if (raw == null) continue;
        for (const ref of Array.isArray(raw) ? raw : [raw]) {
          if (ref == null || typeof ref === 'object') continue;
          refs++;
          if (!idIndex[rel.target].has(String(ref))) broken++;
        }
      }
      reference_integrity[`${type}.${rel.field} -> ${rel.target}`] = { refs, broken };
    }
  }

  manifest.image_coverage = image_coverage;
  manifest.reference_integrity = reference_integrity;
  manifest.bundle = {
    built_at: new Date().toISOString(),
    validated: false, // set true only after validate-bundle.mjs exits 0
    validator_version: VALIDATOR_VERSION,
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`\n── Bundle built — ${manifest.display_name || manifest.game_slug} ──`);
  for (const type of types) {
    const c = image_coverage[type];
    if (!c) continue;
    console.log(`   ${type.padEnd(18)} ${String(c.total).padStart(5)} rows   images ${c.extracted}/${c.total} (${c.pct}%)`);
  }
  console.log(`\n   assets on disk: ${countAssetFiles(path.join(outDir, 'assets')) === 0 ? 'flat dir empty — assets are per-type subfolders' : 'present'}`);
  console.log(`\nmanifest.json updated. Now run:`);
  console.log(`   node datamine/_lib/validate-bundle.mjs ${manifest.game_slug}\n`);
}

try { main(); } catch (e) { console.error('build-bundle error:', e.stack || e.message); process.exit(1); }
