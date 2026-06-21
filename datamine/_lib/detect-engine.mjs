/**
 * datamine/_lib/detect-engine.mjs
 * Détecte l'engine d'un jeu à partir d'un zip ou d'un dossier d'install,
 * en appliquant la matrice datamine/_lib/engine-fingerprints.json.
 *
 * Usage :
 *   node datamine/_lib/detect-engine.mjs <path>
 *   node datamine/_lib/detect-engine.mjs <path> --json
 *   node datamine/_lib/detect-engine.mjs <path> --max-depth=4
 *
 * Si <path> est un .zip → on lit le listing sans décompresser (via `unzip -l`).
 * Si <path> est un dossier → glob récursif.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FINGERPRINTS_PATH = path.join(__dirname, 'engine-fingerprints.json');
const DEFAULT_MAX_DEPTH = 5;

function loadFingerprints() {
  const raw = readFileSync(FINGERPRINTS_PATH, 'utf8');
  return JSON.parse(raw);
}

/**
 * Convertit un pattern glob simple en RegExp.
 * Supporte `**`, `*`, `?` et les classes `[abc]`. Pas d'extensions ksh-like.
 * Match insensitive sur le case (Windows-friendly).
 */
function globToRegex(pattern) {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      regex += '.*';
      i += 2;
      if (pattern[i] === '/') i += 1;
    } else if (c === '*') {
      regex += '[^/\\\\]*';
      i += 1;
    } else if (c === '?') {
      regex += '[^/\\\\]';
      i += 1;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i);
      if (end === -1) {
        regex += '\\[';
        i += 1;
      } else {
        regex += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else if ('.+()|^$\\{}'.includes(c)) {
      regex += '\\' + c;
      i += 1;
    } else if (c === '/') {
      regex += '[\\\\/]';
      i += 1;
    } else {
      regex += c;
      i += 1;
    }
  }
  return new RegExp('^' + regex + '$', 'i');
}

/**
 * Liste les fichiers d'un zip via `unzip -l`.
 * Retourne des chemins POSIX (avec '/').
 */
function listZipEntries(zipPath) {
  const result = spawnSync('unzip', ['-l', zipPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`unzip -l a échoué (status ${result.status}). Stderr : ${result.stderr}`);
  }
  const lines = result.stdout.split(/\r?\n/);
  const entries = [];
  // Format unzip -l :
  //   Length      Date    Time    Name
  //   ---------  ---------- -----   ----
  //     <size>   YYYY-MM-DD HH:MM   <path>
  //   ---------                     -------
  let inBody = false;
  for (const line of lines) {
    if (/^-{3,}\s+-{3,}/.test(line)) {
      inBody = !inBody;
      continue;
    }
    if (!inBody) continue;
    const match = line.match(/^\s*\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
    if (match) {
      const name = match[1];
      if (!name.endsWith('/')) entries.push(name);
    }
  }
  return entries;
}

/**
 * Liste récursivement les fichiers d'un dossier (chemins relatifs POSIX).
 * Limite la profondeur pour éviter d'exploser sur des installs avec beaucoup d'assets.
 */
function listDirEntries(dirPath, maxDepth) {
  const entries = [];
  const stack = [{ dir: dirPath, depth: 0 }];
  while (stack.length > 0) {
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
  return entries;
}

function listEntries(targetPath, maxDepth) {
  if (!existsSync(targetPath)) {
    throw new Error(`Chemin introuvable : ${targetPath}`);
  }
  const stat = statSync(targetPath);
  if (stat.isFile()) {
    if (!targetPath.toLowerCase().endsWith('.zip')) {
      throw new Error(`Le chemin pointe vers un fichier non-zip : ${targetPath}. Fournir un .zip ou un dossier.`);
    }
    return listZipEntries(targetPath);
  }
  if (stat.isDirectory()) {
    return listDirEntries(targetPath, maxDepth);
  }
  throw new Error(`Chemin ni fichier ni dossier : ${targetPath}`);
}

/**
 * Score un engine donné contre la liste d'entrées.
 * Retourne { score, primaryHits, secondaryHits, exclusionHits, matchedPaths }.
 */
function scoreEngine(engine, entries, scoring) {
  const primaryRegexes = (engine.primary ?? []).map(globToRegex);
  const secondaryRegexes = (engine.secondary ?? []).map(globToRegex);
  const exclusionRegexes = (engine.exclusions ?? []).map(globToRegex);

  const primaryHits = new Set();
  const secondaryHits = new Set();
  const exclusionHits = new Set();
  const matchedPaths = { primary: [], secondary: [], exclusions: [] };

  for (const entry of entries) {
    for (let i = 0; i < primaryRegexes.length; i += 1) {
      if (primaryRegexes[i].test(entry) && !primaryHits.has(i)) {
        primaryHits.add(i);
        matchedPaths.primary.push({ pattern: engine.primary[i], path: entry });
      }
    }
    for (let i = 0; i < secondaryRegexes.length; i += 1) {
      if (secondaryRegexes[i].test(entry) && !secondaryHits.has(i)) {
        secondaryHits.add(i);
        matchedPaths.secondary.push({ pattern: engine.secondary[i], path: entry });
      }
    }
    for (let i = 0; i < exclusionRegexes.length; i += 1) {
      if (exclusionRegexes[i].test(entry) && !exclusionHits.has(i)) {
        exclusionHits.add(i);
        matchedPaths.exclusions.push({ pattern: engine.exclusions[i], path: entry });
      }
    }
  }

  // Validation primary : selon engine.primary_any
  // - true : au moins 1 primary doit matcher
  // - false (défaut) : TOUS les primary doivent matcher
  const primaryOk = engine.primary_any
    ? primaryHits.size > 0
    : primaryHits.size === primaryRegexes.length && primaryRegexes.length > 0;

  // Validation secondary : au moins min_secondary doivent matcher
  const minSecondary = engine.min_secondary ?? 0;
  const secondaryOk = secondaryHits.size >= minSecondary;

  // Si pas de primary du tout (cas "native" avec primary `**/*.exe` purement indicatif),
  // on n'élimine pas l'engine — on s'appuie sur les exclusions
  const eligible = (primaryRegexes.length === 0 || primaryOk) && secondaryOk;

  let score = 0;
  if (eligible) {
    score += primaryHits.size * scoring.primary_match;
    score += secondaryHits.size * scoring.secondary_match;
    score += exclusionHits.size * scoring.exclusion_match;
  }

  return {
    engineId: engine.id,
    name: engine.name,
    score,
    eligible,
    primaryHits: primaryHits.size,
    primaryTotal: primaryRegexes.length,
    secondaryHits: secondaryHits.size,
    secondaryTotal: secondaryRegexes.length,
    exclusionHits: exclusionHits.size,
    matchedPaths,
  };
}

/**
 * Détermine le niveau de confiance à partir des scores.
 *  - high : score top1 ≥ min_score_high_confidence ET top1/top2 ≥ ratio
 *  - medium : score top1 ≥ min_score_high_confidence MAIS ambiguïté
 *  - low : score top1 < min_score_high_confidence
 *  - none : aucun engine éligible (score ≤ 0)
 */
function classifyConfidence(rankedScores, scoring) {
  if (rankedScores.length === 0 || rankedScores[0].score <= 0) {
    return 'none';
  }
  const top = rankedScores[0];
  const next = rankedScores[1];
  if (top.score < scoring.min_score_high_confidence) return 'low';
  if (!next || next.score <= 0) return 'high';
  const ratio = top.score / next.score;
  if (ratio >= scoring.high_vs_next_ratio) return 'high';
  return 'medium';
}

function parseArgs(argv) {
  const args = { path: null, json: false, maxDepth: DEFAULT_MAX_DEPTH };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') args.json = true;
    else if (arg.startsWith('--max-depth=')) args.maxDepth = parseInt(arg.slice('--max-depth='.length), 10);
    else if (!args.path && !arg.startsWith('--')) args.path = arg;
  }
  return args;
}

export function detectEngine(targetPath, maxDepth = DEFAULT_MAX_DEPTH) {
  const fingerprints = loadFingerprints();
  const entries = listEntries(targetPath, maxDepth);

  const scored = fingerprints.engines
    .map((engine) => scoreEngine(engine, entries, fingerprints.scoring))
    .sort((a, b) => b.score - a.score);

  const confidence = classifyConfidence(scored, fingerprints.scoring);
  const top = scored[0] ?? null;

  return {
    detected_engine: confidence === 'none' ? 'unknown' : top.engineId,
    confidence,
    score: top?.score ?? 0,
    fingerprints_version: fingerprints.version,
    detected_at: new Date().toISOString(),
    target_path: targetPath,
    entries_count: entries.length,
    alternatives: scored.slice(0, 5).map((s) => ({
      id: s.engineId,
      name: s.name,
      score: s.score,
      primary_hits: `${s.primaryHits}/${s.primaryTotal}`,
      secondary_hits: `${s.secondaryHits}/${s.secondaryTotal}`,
      exclusion_hits: s.exclusionHits,
      eligible: s.eligible,
    })),
    top_matches: top?.matchedPaths ?? null,
  };
}

function printHumanReport(result) {
  console.log(`Détection d'engine — ${result.target_path}`);
  console.log(`  Fichiers analysés  : ${result.entries_count}`);
  console.log(`  Engine détecté     : ${result.detected_engine}`);
  console.log(`  Confiance          : ${result.confidence}`);
  console.log(`  Score              : ${result.score}`);
  console.log('');
  console.log('Top 5 candidats :');
  for (const alt of result.alternatives) {
    const tick = alt.id === result.detected_engine ? '✓' : ' ';
    console.log(`  ${tick} ${alt.id.padEnd(20)} score=${String(alt.score).padStart(3)} primary=${alt.primary_hits} secondary=${alt.secondary_hits} excl=${alt.exclusion_hits}`);
  }
  if (result.confidence === 'none') {
    console.log('');
    console.log('⚠ Aucun engine identifié — basculer en mode shallow extraction (38.9).');
  } else if (result.confidence === 'low' || result.confidence === 'medium') {
    console.log('');
    console.log('⚠ Confiance basse/moyenne — demander confirmation avant de poursuivre.');
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.path) {
    console.error('Usage : node datamine/_lib/detect-engine.mjs <path> [--json] [--max-depth=N]');
    process.exit(1);
  }
  if (Number.isNaN(args.maxDepth) || args.maxDepth < 1) {
    console.error(`--max-depth invalide : doit être un entier ≥ 1`);
    process.exit(1);
  }
  try {
    const result = detectEngine(args.path, args.maxDepth);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHumanReport(result);
    }
    process.exit(result.confidence === 'none' ? 2 : 0);
  } catch (err) {
    console.error(`Erreur : ${err.message}`);
    process.exit(99);
  }
}

// Exécution directe (pas import) — robust sur Windows et Unix
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
