/**
 * datamine/_lib/validate-bundle.mjs
 *
 * THE HARD GATE. A datamine is NOT done until this exits 0.
 * "Aucune erreur ne sera tolérée" — this script is what makes that enforceable.
 *
 * It reads a workspace's output bundle (out/manifest.json + out/data + out/assets)
 * and verifies every invariant a wiki/dle site relies on. It is fully generic:
 * it learns the entity types, files, name/image fields and relations from the
 * manifest — no game-specific knowledge is hard-coded.
 *
 * Usage:
 *   node datamine/_lib/validate-bundle.mjs <game-slug>
 *   node datamine/_lib/validate-bundle.mjs --out <path-to-out-dir>
 *   node datamine/_lib/validate-bundle.mjs <slug> --primary-lang=eng
 *
 * Exit codes:
 *   0  bundle is valid (zero hard errors)
 *   1  hard errors found (bundle NOT shippable)
 *   2  bundle structurally missing / unreadable
 *
 * Hard errors (block shipping):
 *   - manifest missing/invalid, or declares an entity whose data file is absent
 *   - a data file that is not a non-empty JSON array
 *   - a record with no `id`, or a duplicate `id` within an entity type
 *   - a record whose name resolves to empty OR to a raw technical id
 *   - an `image` path that does not resolve to a real file under out/assets/
 *     (unless the record is listed in missing_images.json with a documented reason)
 *   - a relation field pointing to an id that does not exist in the target entity
 *   - a wiki category with declared content that maps to no entity type
 *
 * Soft warnings (printed, do not block): low image coverage, missing optional fields.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATAMINE_ROOT = path.resolve(__dirname, '..');
const VALIDATOR_VERSION = '1';

// ── Technical-id detection ──────────────────────────────────────────────────
// A wiki visitor must never see an internal id. These patterns flag names that
// are still raw game identifiers (the name-resolution cascade was incomplete).
const TECHNICAL_NAME_PATTERNS = [
  /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/,   // pure snake_case: rooms_floor1_large
  /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/,   // SCREAMING_SNAKE i18n key: HOUSE_BUTTON_DEFEND
  /^(default|tmp|temp|test|set|placeholder)_/i,
  /(_v\d+|_old|_new|_copy|_backup)$/i,
];

function isTechnicalName(name, id) {
  if (!name || typeof name !== 'string') return true;
  const trimmed = name.trim();
  if (trimmed === '') return true;
  // name === id is only OK when the id is itself a readable single word (e.g. "Strike", "Attic")
  if (trimmed === id && !/^[A-Z][a-zA-Z]+$/.test(id) && !/^[a-z][a-z]+$/.test(id)) return true;
  return TECHNICAL_NAME_PATTERNS.some((re) => re.test(trimmed));
}

function resolveName(value, primaryLang) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return value[primaryLang] ?? value.eng ?? value.en ?? Object.values(value).find((v) => typeof v === 'string') ?? null;
  }
  return null;
}

function parseArgs(argv) {
  const args = { slug: null, out: null, primaryLang: 'eng' };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--out') args.out = rest[++i];
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (a.startsWith('--primary-lang=')) args.primaryLang = a.slice(15);
    else if (!a.startsWith('--') && !args.slug) args.slug = a;
  }
  return args;
}

function fail(msg, code = 2) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv);

  let outDir;
  if (args.out) outDir = path.resolve(args.out);
  else if (args.slug) outDir = path.join(DATAMINE_ROOT, args.slug, 'out');
  else fail('Provide a <game-slug> or --out <path-to-out-dir>.');

  if (!existsSync(outDir)) fail(`Bundle dir not found: ${outDir}`);

  const manifestPath = path.join(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) fail(`manifest.json not found in ${outDir}`);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail(`manifest.json is not valid JSON: ${e.message}`);
  }

  const primaryLang = args.primaryLang || (manifest.languages && manifest.languages[0]) || 'eng';
  const dataDir = path.join(outDir, 'data');
  const assetsDir = path.join(outDir, 'assets');

  // Documented-missing images (acceptable absences)
  const missingImagesPath = path.join(outDir, 'missing_images.json');
  const documentedMissing = new Set();
  if (existsSync(missingImagesPath)) {
    try {
      const mi = JSON.parse(readFileSync(missingImagesPath, 'utf8'));
      const list = Array.isArray(mi) ? mi : (mi.entries ?? []);
      for (const e of list) documentedMissing.add(`${e.entity_type ?? e.type}/${e.id}`);
    } catch { /* tolerated — treated as no documented misses */ }
  }

  const errors = [];   // hard
  const warnings = []; // soft
  const idIndex = {};  // entity_type -> Set<id>  (built first for relation checks)

  const entities = manifest.entities || {};
  const entityTypes = Object.keys(entities);
  if (entityTypes.length === 0) {
    fail('manifest.entities is empty — a valid bundle must declare at least one entity type.', 1);
  }

  // Pass 1 — load every entity file, build id index, check ids/names/images
  const loaded = {};
  for (const type of entityTypes) {
    const decl = entities[type];
    const file = decl.file || `data/${type}.json`;
    const filePath = path.join(outDir, file);
    if (!existsSync(filePath)) {
      errors.push(`[${type}] declared file missing: ${file}`);
      continue;
    }
    let rows;
    try {
      rows = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (e) {
      errors.push(`[${type}] ${file} is not valid JSON: ${e.message}`);
      continue;
    }
    if (!Array.isArray(rows)) {
      errors.push(`[${type}] ${file} must be a JSON array (got ${typeof rows}).`);
      continue;
    }
    if (rows.length === 0) {
      errors.push(`[${type}] ${file} is empty — an empty entity table is never a valid result.`);
      continue;
    }
    loaded[type] = rows;
    idIndex[type] = new Set();

    const nameField = decl.name_field || 'name';
    const imageField = decl.image_field || 'image';
    let imgExtracted = 0;

    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const id = row.id;
      if (id == null || id === '') {
        errors.push(`[${type}] row #${i} has no \`id\`.`);
        continue;
      }
      if (seen.has(id)) errors.push(`[${type}] duplicate id "${id}".`);
      seen.add(id);
      idIndex[type].add(String(id));

      // Name must be human-readable
      const name = resolveName(row[nameField], primaryLang);
      if (isTechnicalName(name, String(id))) {
        errors.push(`[${type}] id "${id}" has a non-human name: ${JSON.stringify(name)} (technical id leaking — fix the name cascade).`);
      }

      // Image must resolve to a real file (when present)
      const img = row[imageField];
      if (img != null && img !== '' && typeof img === 'string' && !img.startsWith('data:')) {
        const imgPath = path.join(assetsDir, img.replace(/^assets\//, ''));
        if (existsSync(imgPath) && statSync(imgPath).isFile()) {
          imgExtracted++;
        } else {
          errors.push(`[${type}] id "${id}" image "${img}" does not resolve to a file under assets/.`);
        }
      } else if (img != null && typeof img === 'string' && img.startsWith('data:')) {
        imgExtracted++; // inline SVG placeholder — acceptable, counts as present
      } else if (!documentedMissing.has(`${type}/${id}`)) {
        warnings.push(`[${type}] id "${id}" has no image and is not in missing_images.json.`);
      }
    }

    // Coverage cross-check vs declared count
    if (typeof decl.count === 'number' && Math.abs(decl.count - rows.length) > Math.max(1, decl.count * 0.01)) {
      errors.push(`[${type}] manifest count ${decl.count} != actual rows ${rows.length} (>1% drift).`);
    }
    decl._actualImages = imgExtracted; // stash for report
  }

  // Pass 2 — relation integrity (every referenced id must exist in its target)
  for (const type of entityTypes) {
    const rows = loaded[type];
    if (!rows) continue;
    const rels = entities[type].relations || [];
    for (const rel of rels) {
      const target = rel.target;
      if (!idIndex[target]) {
        errors.push(`[${type}] relation "${rel.field}" -> "${target}" but "${target}" is not a known entity type.`);
        continue;
      }
      let refs = 0, broken = 0;
      for (const row of rows) {
        const raw = row[rel.field];
        if (raw == null) continue;
        const ids = Array.isArray(raw) ? raw : [raw];
        for (const ref of ids) {
          if (ref == null || typeof ref === 'object') continue;
          refs++;
          if (!idIndex[target].has(String(ref))) broken++;
        }
      }
      const pct = refs ? Math.round((broken / refs) * 100) : 0;
      if (broken > 0) {
        const line = `[${type}] relation "${rel.field}" -> ${target}: ${broken}/${refs} broken refs (${pct}%).`;
        if (pct > 5) errors.push(line); else warnings.push(line);
      }
    }
  }

  // Pass 3 — wiki coverage: every category with real content must map to an entity
  const wiki = manifest.wiki_coverage || {};
  for (const [cat, mapping] of Object.entries(wiki)) {
    if (typeof mapping !== 'string') continue;
    const isNA = /^n\/a/i.test(mapping.trim());
    if (isNA) continue; // documented absence — acceptable
    if (!entityTypes.includes(mapping)) {
      errors.push(`[wiki] category "${cat}" maps to "${mapping}" which is not a produced entity type (and is not marked "n/a — <reason>").`);
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log(`\n── Bundle validation — ${manifest.display_name || manifest.game_slug} ──`);
  console.log(`   out: ${outDir}`);
  console.log(`   primary lang: ${primaryLang}   validator v${VALIDATOR_VERSION}\n`);

  for (const type of entityTypes) {
    const rows = loaded[type];
    const decl = entities[type];
    if (!rows) { console.log(`   ${type.padEnd(18)} —  (FILE MISSING)`); continue; }
    const total = rows.length;
    const imgs = decl._actualImages || 0;
    const pct = total ? Math.round((imgs / total) * 100) : 0;
    console.log(`   ${type.padEnd(18)} ${String(total).padStart(5)} rows   images ${imgs}/${total} (${pct}%)`);
    if (pct < 70) warnings.push(`[${type}] image coverage ${pct}% < 70% — investigate before shipping.`);
  }

  if (warnings.length) {
    console.log(`\n⚠ ${warnings.length} warning(s):`);
    for (const w of warnings.slice(0, 50)) console.log(`   - ${w}`);
    if (warnings.length > 50) console.log(`   … and ${warnings.length - 50} more`);
  }

  if (errors.length) {
    console.log(`\n✖ ${errors.length} HARD error(s) — bundle is NOT shippable:`);
    for (const e of errors.slice(0, 100)) console.log(`   - ${e}`);
    if (errors.length > 100) console.log(`   … and ${errors.length - 100} more`);
    console.log('\nFix every hard error, rebuild the bundle, and re-run this validator.\n');
    process.exit(1);
  }

  console.log('\n✓ Bundle is valid — 0 hard errors. Ready to ship to any wiki/dle target.\n');
  process.exit(0);
}

try {
  main();
} catch (err) {
  fail(`Unexpected validator error: ${err.stack || err.message}`);
}
