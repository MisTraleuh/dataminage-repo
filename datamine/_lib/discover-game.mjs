/**
 * datamine/_lib/discover-game.mjs
 * Investigation "tout savoir sur ce zip avant de l'extraire".
 *
 * À partir d'un chemin de zip ou d'un dossier, retourne un JSON contenant :
 *   - zip_format : méthodes de compression utilisées + extracteur recommandé
 *   - engine_guess : engine probable + score de confiance + alternatives
 *   - game_signals : fichiers signature (release_info.json, *.pck, *.dll Mono/IL2CPP, etc.)
 *   - game_version : si trouvable depuis un fichier metadata
 *   - game_name_hint : nom déduit du dossier racine ou du nom du zip
 *   - localization_present : oui/non
 *   - estimated_pipeline_time : minutes estimées
 *
 * Usage :
 *   node discover-game.mjs <zip-or-dir>
 *   node discover-game.mjs <zip-or-dir> --json
 *
 * À utiliser en Phase 0 du skill /datamine, AVANT d'extraire quoi que ce soit.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { detectEngine } from './detect-engine.mjs';
import { probe as probeZip } from './extract-zip.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────────────────────────────
// Signatures de fichiers — drapeaux distinctifs pour comprendre le jeu
// ──────────────────────────────────────────────────────────────────────────────

const SIGNAL_FILES = [
  // Godot
  { pattern: /\.pck$/i, signal: 'godot-pck', importance: 'critical' },
  { pattern: /release_info\.json$/i, signal: 'godot-release-info', importance: 'critical' },
  { pattern: /Godot_v\d+/i, signal: 'godot-binary', importance: 'high' },
  { pattern: /GodotSharp\.dll$/i, signal: 'godot-csharp-runtime', importance: 'critical' },
  { pattern: /coreclr\.dll$/i, signal: 'dotnet-runtime', importance: 'high' },
  // Unity
  { pattern: /UnityPlayer\.dll$/i, signal: 'unity-runtime', importance: 'critical' },
  { pattern: /Assembly-CSharp\.dll$/i, signal: 'unity-mono-assembly', importance: 'critical' },
  { pattern: /global-metadata\.dat$/i, signal: 'unity-il2cpp-metadata', importance: 'critical' },
  { pattern: /GameAssembly\.dll$/i, signal: 'unity-il2cpp-assembly', importance: 'critical' },
  { pattern: /globalgamemanagers$/i, signal: 'unity-globalgamemanagers', importance: 'high' },
  { pattern: /_Data\/Resources\/unity default resources$/i, signal: 'unity-resources', importance: 'medium' },
  // Unreal
  { pattern: /\.pak$/i, signal: 'unreal-pak', importance: 'critical' },
  { pattern: /\.utoc$/i, signal: 'unreal-iostore', importance: 'critical' },
  { pattern: /\.uasset$/i, signal: 'unreal-uasset', importance: 'medium' },
  { pattern: /-Win64-Shipping\.exe$/i, signal: 'unreal-exe', importance: 'high' },
  // GameMaker
  { pattern: /data\.win$/i, signal: 'gamemaker-data', importance: 'critical' },
  { pattern: /game\.unx$/i, signal: 'gamemaker-data-linux', importance: 'critical' },
  { pattern: /audiogroup.*\.dat$/i, signal: 'gamemaker-audiogroup', importance: 'medium' },
  // LÖVE / Lua
  { pattern: /\.love$/i, signal: 'love2d-archive', importance: 'critical' },
  { pattern: /^main\.lua$/i, signal: 'love2d-main', importance: 'high' },
  { pattern: /love\.dll$/i, signal: 'love2d-binary', importance: 'high' },
  // Electron
  { pattern: /resources\/app\.asar$/i, signal: 'electron-asar', importance: 'critical' },
  { pattern: /electron\.exe$/i, signal: 'electron-binary', importance: 'high' },
  // Crack/Repack indicators (utile pour détecter les zips AnkerGames-style et exclure les fichiers parasites)
  { pattern: /OnlineFix64\.dll$/i, signal: 'crack-onlinefix', importance: 'low' },
  { pattern: /AnkerGames/i, signal: 'repack-ankergames', importance: 'low' },
  { pattern: /Read Me\.txt$/i, signal: 'repack-readme', importance: 'low' },
  // Localization hints
  { pattern: /\/(loc|locale|locales|i18n|lang|translations?)\//i, signal: 'localization-dir', importance: 'medium' },
  // Version files
  { pattern: /version\.(txt|json)$/i, signal: 'version-file', importance: 'medium' },
  { pattern: /build\.json$/i, signal: 'build-file', importance: 'medium' },
  { pattern: /steam_appid\.txt$/i, signal: 'steam-appid', importance: 'low' },
];

const COMMON_ENTITY_DIRS = ['cards', 'relics', 'items', 'monsters', 'enemies', 'characters', 'jokers', 'cats', 'weapons', 'powers', 'potions'];

// ──────────────────────────────────────────────────────────────────────────────
// Listing helpers
// ──────────────────────────────────────────────────────────────────────────────

function listFromZip(zipPath) {
  const result = probeZip(zipPath);
  return {
    source: 'zip',
    entries: result.probe.entries.map((e) => e.name),
    zipFormat: {
      total_entries: result.probe.totalEntries,
      zip_size: result.probe.zipSize,
      methods_used: result.probe.methodCounts,
      extractors_available: result.available.map((a) => a.id),
      extractor_recommended: result.picker?.id ?? null,
      can_extract: !!result.picker,
      missing_extractor_for_methods: result.picker
        ? null
        : Object.keys(result.probe.methodCounts).map((m) => parseInt(m, 10)).filter((m) => !result.available.some((a) => a.supports.has(m))),
    },
  };
}

function listFromDir(dirPath, maxDepth = 6) {
  const entries = [];
  const stack = [{ dir: dirPath, depth: 0 }];
  while (stack.length > 0 && entries.length < 100000) {
    const { dir, depth } = stack.pop();
    let dirContents;
    try {
      dirContents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirContents) {
      const full = path.join(dir, dirent.name);
      const rel = path.relative(dirPath, full).replace(/\\/g, '/');
      if (dirent.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (dirent.isFile()) {
        entries.push(rel);
      }
    }
  }
  return { source: 'dir', entries, zipFormat: null };
}

// ──────────────────────────────────────────────────────────────────────────────
// Analyse
// ──────────────────────────────────────────────────────────────────────────────

function detectSignals(entries) {
  const found = {};
  for (const sig of SIGNAL_FILES) {
    const matches = entries.filter((e) => sig.pattern.test(e));
    if (matches.length > 0) {
      found[sig.signal] = {
        importance: sig.importance,
        count: matches.length,
        examples: matches.slice(0, 3),
      };
    }
  }
  return found;
}

function inferGameNameHint(zipOrDir, entries) {
  // 1. Top-level dir : "Slay the Spire 2/SlayTheSpire2.pck" → "Slay the Spire 2"
  const topDirs = new Set();
  for (const e of entries.slice(0, 200)) {
    const parts = e.split('/');
    if (parts.length > 1) topDirs.add(parts[0]);
  }
  // Filtrer les dirs parasites de repack (controller_config, .DepotDownloader)
  const filtered = [...topDirs].filter((d) =>
    !d.startsWith('.') &&
    !['controller_config', 'redist', 'crashreports', '__MACOSX'].includes(d)
  );
  if (filtered.length === 1) return filtered[0];

  // 2. Nom du zip : "Slay-the-Spire-2-AnkerGames.zip" → "Slay-the-Spire-2"
  const basename = path.basename(zipOrDir, path.extname(zipOrDir));
  // Strip suffix marketing : -AnkerGames, -Repack, -GOG, -Steam, etc.
  const cleaned = basename.replace(/[-_](AnkerGames|Repack|GOG|Steam|FitGirl|RG|Multi\d+|v\d+\.\d+.*)$/i, '');
  return cleaned;
}

function suggestGameSlug(nameHint) {
  return nameHint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, 'g$1'); // slug doit commencer par lettre
}

function inferGameVersion(zipOrDir, entries, isZip) {
  // Chercher un release_info.json, version.txt, ou similar — DANS le zip si zip
  const versionFiles = entries.filter((e) =>
    /(?:^|\/)release_info\.json$|(?:^|\/)version\.(?:txt|json)$|(?:^|\/)build\.json$/i.test(e)
  );
  if (versionFiles.length === 0) return null;

  // Pour les zips, on ne lit pas ici (trop coûteux) — on signale juste la présence
  if (isZip) {
    return { source: 'present_but_not_read', files: versionFiles.slice(0, 3) };
  }

  // Pour les dirs, on lit
  for (const f of versionFiles.slice(0, 3)) {
    const fullPath = path.join(zipOrDir, f);
    try {
      const content = readFileSync(fullPath, 'utf8');
      try {
        const parsed = JSON.parse(content);
        return {
          source: 'parsed',
          file: f,
          version: parsed.version ?? parsed.build ?? parsed.tag_name ?? null,
          raw: parsed,
        };
      } catch {
        // texte simple
        return { source: 'text', file: f, raw: content.slice(0, 200) };
      }
    } catch {
      // skip
    }
  }
  return null;
}

function detectEntityHints(entries) {
  const hints = {};
  for (const dir of COMMON_ENTITY_DIRS) {
    const re = new RegExp(`(^|/)(${dir})/[^/]+\\.(png|jpg|webp)$`, 'i');
    const matches = entries.filter((e) => re.test(e));
    if (matches.length >= 5) {
      hints[dir] = { count: matches.length, examples: matches.slice(0, 3) };
    }
  }
  return hints;
}

function estimatePipelineMinutes(engine, zipFormat, entryCount) {
  let mins = 0;
  if (zipFormat) mins += 2; // décompression
  switch (engine) {
    case 'godot4-csharp':
      mins += 2 + 1; // PCK extract + DLL decompil (rapide)
      break;
    case 'godot4-gdscript':
    case 'godot3':
      mins += 2;
      break;
    case 'unity-mono':
      mins += 5; // AssetRipper plus lent
      break;
    case 'unity-il2cpp':
      mins += 8; // 3 outils chaînés
      break;
    case 'ue4':
    case 'ue5':
      mins += 5;
      break;
    case 'gms2':
    case 'gms1':
      mins += 3;
      break;
    case 'lua-love2d':
    case 'electron':
      mins += 1;
      break;
    default:
      mins += 5;
  }
  if (entryCount > 10000) mins += 2;
  return mins;
}

function makePlan(engine, zipFormat, signals, hasPublicSource) {
  const plan = [];
  if (zipFormat && zipFormat.zip_format && !zipFormat.zip_format.can_extract) {
    plan.push({
      step: 'install-extractor',
      reason: `Méthodes ${zipFormat.zip_format.missing_extractor_for_methods?.join(',')} non supportées par les extracteurs disponibles`,
      action: 'Installer un extracteur compatible (cf toolchains.md)',
    });
  }
  if (hasPublicSource) {
    plan.push({
      step: 'phase-0-public-source',
      action: 'Demander confirmation : source publique ou pipeline complet ?',
    });
  }
  plan.push({ step: 'phase-1-bootstrap', action: 'init-workspace + extract-zip (sélectif si > 500 MB)' });
  plan.push({ step: 'phase-2-fingerprinting', action: `Confirmer engine = ${engine}` });
  plan.push({ step: 'phase-3-tooling', action: 'check-tools + install-tool si manquant' });
  if (engine !== 'unknown' && engine !== 'native' && engine !== 'electron' && engine !== 'lua-love2d') {
    plan.push({ step: 'phase-4-extract-assets', action: 'Plan A → B → C selon validation' });
    plan.push({ step: 'phase-5-decompile', action: 'Si applicable selon engine' });
  }
  plan.push({ step: 'phase-6-inventory', action: 'Lister les modèles, demander entités à seed' });
  plan.push({ step: 'phase-7-parsing', action: 'Parsers existants OU LLM-assisted' });
  plan.push({ step: 'phase-8-9-bundle', action: 'Build + validate the portable output bundle (out/data + out/assets + manifest.json)' });
  plan.push({ step: 'phase-10-report', action: 'Update manifest, suggérer commit' });
  return plan;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────

export function discoverGame(targetPath) {
  if (!existsSync(targetPath)) {
    throw new Error(`Path introuvable : ${targetPath}`);
  }
  const stat = statSync(targetPath);
  const isZip = stat.isFile() && targetPath.toLowerCase().endsWith('.zip');

  // 1. Listing
  const listing = isZip ? listFromZip(targetPath) : listFromDir(targetPath);

  // 2. Engine fingerprinting (réutilise detect-engine.mjs)
  const engineDetection = detectEngine(targetPath, 6);

  // 3. Signaux
  const signals = detectSignals(listing.entries);

  // 4. Nom du jeu / slug
  const gameNameHint = inferGameNameHint(targetPath, listing.entries);
  const suggestedSlug = suggestGameSlug(gameNameHint);

  // 5. Version (uniquement si dir, pas zip — sinon coûteux)
  const gameVersion = inferGameVersion(targetPath, listing.entries, isZip);

  // 6. Entités candidates (basé sur les dossiers d'images)
  const entityHints = detectEntityHints(listing.entries);

  // 7. Localization
  const hasLocalization = Object.keys(signals).includes('localization-dir');

  // 8. Estimation
  const estimatedMinutes = estimatePipelineMinutes(engineDetection.detected_engine, listing, listing.entries.length);

  // 9. Plan suggéré
  const plan = makePlan(engineDetection.detected_engine, { zip_format: listing.zipFormat }, signals, false);

  return {
    target: targetPath,
    source_type: isZip ? 'zip' : 'dir',
    discovered_at: new Date().toISOString(),
    game_name_hint: gameNameHint,
    suggested_slug: suggestedSlug,
    suggested_slug_underscored: suggestedSlug.replace(/-/g, '_'), // handy for schema/table names in optional DB export
    engine_guess: {
      id: engineDetection.detected_engine,
      confidence: engineDetection.confidence,
      score: engineDetection.score,
      top_alternatives: engineDetection.alternatives.slice(0, 3),
    },
    zip_format: listing.zipFormat,
    file_signals: signals,
    game_version: gameVersion,
    has_localization: hasLocalization,
    entity_hints: entityHints,
    total_entries: listing.entries.length,
    estimated_pipeline_minutes: estimatedMinutes,
    suggested_plan: plan,
  };
}

function printHumanReport(d) {
  console.log('═'.repeat(70));
  console.log(` Investigation : ${d.target}`);
  console.log('═'.repeat(70));
  console.log(` Source type            : ${d.source_type}`);
  console.log(` Game name (deviné)     : ${d.game_name_hint}`);
  console.log(` Slug suggéré           : ${d.suggested_slug}`);
  console.log(` slug (underscored)     : ${d.suggested_slug_underscored}`);
  console.log(` Engine                 : ${d.engine_guess.id} (confidence ${d.engine_guess.confidence}, score ${d.engine_guess.score})`);
  console.log(` Total entries          : ${d.total_entries}`);
  console.log(` Localization présente  : ${d.has_localization ? 'oui' : 'non'}`);
  console.log(` Estimation pipeline    : ~${d.estimated_pipeline_minutes} min`);
  console.log('');

  if (d.zip_format) {
    console.log(` Format zip :`);
    console.log(`   Méthodes utilisées : ${Object.keys(d.zip_format.methods_used).map((m) => m).join(', ')}`);
    console.log(`   Extracteur reco    : ${d.zip_format.extractor_recommended ?? '⚠ AUCUN — installer un extracteur compatible'}`);
    console.log(`   Peut extraire      : ${d.zip_format.can_extract ? 'oui' : 'NON — bloquant'}`);
    if (!d.zip_format.can_extract && d.zip_format.missing_extractor_for_methods) {
      console.log(`   Méthodes non couvertes : ${d.zip_format.missing_extractor_for_methods.join(', ')}`);
    }
    console.log('');
  }

  if (Object.keys(d.file_signals).length > 0) {
    console.log(` File signals (top 10 par importance) :`);
    const sorted = Object.entries(d.file_signals).sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[a[1].importance] ?? 4) - (order[b[1].importance] ?? 4);
    });
    for (const [signal, info] of sorted.slice(0, 10)) {
      console.log(`   [${info.importance.padEnd(8)}] ${signal.padEnd(28)} ${info.count} match(es) — ex: ${info.examples[0]}`);
    }
    console.log('');
  }

  if (d.game_version) {
    console.log(` Game version :`);
    if (d.game_version.source === 'present_but_not_read') {
      console.log(`   Fichier(s) version présent(s) (lire après extraction) : ${d.game_version.files.join(', ')}`);
    } else if (d.game_version.version) {
      console.log(`   Version : ${d.game_version.version} (depuis ${d.game_version.file})`);
    } else {
      console.log(`   Fichier ${d.game_version.file} présent — contenu non parsé`);
    }
    console.log('');
  }

  if (Object.keys(d.entity_hints).length > 0) {
    console.log(` Entity hints (dossiers d'images détectés) :`);
    for (const [cat, info] of Object.entries(d.entity_hints)) {
      console.log(`   ${cat.padEnd(15)} : ${info.count} images (ex: ${info.examples[0]})`);
    }
    console.log('');
  }

  console.log(` Plan suggéré :`);
  for (const step of d.suggested_plan) {
    console.log(`   - ${step.step.padEnd(28)} ${step.action}`);
    if (step.reason) console.log(`     (raison : ${step.reason})`);
  }
  console.log('═'.repeat(70));
}

function parseArgs(argv) {
  const args = { target: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') args.json = true;
    else if (!args.target && !arg.startsWith('--')) args.target = arg;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.target) {
    console.error('Usage : node datamine/_lib/discover-game.mjs <zip-or-dir> [--json]');
    process.exit(1);
  }
  try {
    const result = discoverGame(args.target);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHumanReport(result);
    }
    // Exit code spécial si extraction impossible
    if (result.zip_format && !result.zip_format.can_extract) process.exit(2);
    if (result.engine_guess.id === 'unknown') process.exit(3);
    process.exit(0);
  } catch (err) {
    console.error(`Erreur : ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
