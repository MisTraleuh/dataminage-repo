/**
 * datamine/_lib/validate-extraction.mjs
 * Sanity checks post-phase pour fail-fast et bascule plan B/C dans le pipeline.
 *
 * Usage :
 *   node datamine/_lib/validate-extraction.mjs <game-slug> <engine-id> <phase>
 *   node datamine/_lib/validate-extraction.mjs <game-slug> <engine-id> <phase> --json
 *
 * <phase> : after_phase_4_extract | after_phase_5_decompile | after_phase_7_parse
 *
 * Exit codes :
 *   0 = toutes les règles passent
 *   1 = au moins une règle échoue
 *   2 = engine ou phase inconnu
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const RULES_PATH = path.join(__dirname, 'validation-rules.json');

function loadRules() {
  return JSON.parse(readFileSync(RULES_PATH, 'utf8'));
}

function workspacePath(gameSlug, relPath) {
  return path.join(REPO_ROOT, 'scripts', 'datamine', gameSlug, relPath);
}

/**
 * Glob simplifié supportant `**`, `*`, `?` et les classes `{a,b,c}`.
 */
function compileGlob(pattern) {
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
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        regex += '\\{';
        i += 1;
      } else {
        const alts = pattern.slice(i + 1, end).split(',').map((a) => a.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
        regex += '(?:' + alts.join('|') + ')';
        i = end + 1;
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
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

function listFilesRecursive(rootDir, maxFiles = 1_000_000) {
  if (!existsSync(rootDir)) return [];
  const out = [];
  const stack = [rootDir];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop();
    let dirContents;
    try {
      dirContents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirContents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(full);
      } else if (dirent.isFile()) {
        out.push(path.relative(rootDir, full).replace(/\\/g, '/'));
      }
    }
  }
  return out;
}

function totalSizeOfDir(dirPath) {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  const stack = [dirPath];
  while (stack.length > 0) {
    const d = stack.pop();
    let contents;
    try {
      contents = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of contents) {
      const full = path.join(d, dirent.name);
      if (dirent.isDirectory()) stack.push(full);
      else if (dirent.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          // skip
        }
      }
    }
  }
  return total;
}

function countSubdirs(dirPath) {
  if (!existsSync(dirPath)) return 0;
  try {
    return readdirSync(dirPath, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    return 0;
  }
}

function evaluateRule(rule, gameSlug) {
  const target = rule.path ? workspacePath(gameSlug, rule.path) : null;
  switch (rule.type) {
    case 'always_pass':
      return { ok: true, message: rule.description ?? 'always_pass' };
    case 'dir_exists':
      return existsSync(target) && statSync(target).isDirectory()
        ? { ok: true }
        : { ok: false, message: `directory missing: ${rule.path}` };
    case 'file_exists':
      return existsSync(target) && statSync(target).isFile()
        ? { ok: true }
        : { ok: false, message: `file missing: ${rule.path}` };
    case 'min_dir_count': {
      const count = countSubdirs(target);
      return count >= rule.min
        ? { ok: true, count }
        : { ok: false, message: `subdir count ${count} < ${rule.min} in ${rule.path}` };
    }
    case 'min_total_size_mb': {
      const size = totalSizeOfDir(target);
      const sizeMb = size / (1024 * 1024);
      return sizeMb >= rule.min
        ? { ok: true, size_mb: Math.round(sizeMb * 10) / 10 }
        : { ok: false, message: `total size ${sizeMb.toFixed(1)} MB < ${rule.min} MB in ${rule.path}` };
    }
    case 'min_file_count': {
      const files = listFilesRecursive(target);
      let matching = files;
      if (rule.glob) {
        const re = compileGlob(rule.glob);
        matching = files.filter((f) => re.test(f));
      }
      return matching.length >= rule.min
        ? { ok: true, count: matching.length }
        : { ok: false, message: `file count ${matching.length} < ${rule.min} in ${rule.path}${rule.glob ? ` (glob ${rule.glob})` : ''}` };
    }
    case 'file_exists_glob': {
      const files = listFilesRecursive(target);
      const re = compileGlob(rule.glob);
      const matchPrimary = files.some((f) => re.test(f));
      if (matchPrimary) return { ok: true };
      if (rule.or_glob) {
        const reAlt = compileGlob(rule.or_glob);
        if (files.some((f) => reAlt.test(f))) {
          return { ok: true, alt_glob_used: true };
        }
      }
      return { ok: false, message: `no file matching glob ${rule.glob} in ${rule.path}` };
    }
    default:
      return { ok: false, message: `unknown rule type: ${rule.type}` };
  }
}

export function validateExtraction(gameSlug, engineId, phase) {
  const rules = loadRules();
  const engineRules = rules.rules[engineId];
  if (!engineRules) {
    return { ok: false, error: `unknown engine: ${engineId}`, results: [] };
  }
  const phaseRules = engineRules[phase];
  if (!phaseRules) {
    return { ok: false, error: `unknown phase: ${phase} for engine ${engineId}`, results: [] };
  }

  const results = phaseRules.map((rule) => {
    const evalResult = evaluateRule(rule, gameSlug);
    return {
      rule,
      ...evalResult,
    };
  });
  const allOk = results.every((r) => r.ok);
  return {
    game_slug: gameSlug,
    engine: engineId,
    phase,
    ok: allOk,
    rules_total: results.length,
    rules_passed: results.filter((r) => r.ok).length,
    rules_failed: results.filter((r) => !r.ok).length,
    results,
  };
}

function parseArgs(argv) {
  const positional = [];
  const args = { json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') args.json = true;
    else if (!arg.startsWith('--')) positional.push(arg);
  }
  args.gameSlug = positional[0];
  args.engineId = positional[1];
  args.phase = positional[2];
  return args;
}

function printHumanReport(report) {
  console.log(`Validation — game: ${report.game_slug} | engine: ${report.engine} | phase: ${report.phase}`);
  console.log('');
  if (report.error) {
    console.error(`✗ Erreur : ${report.error}`);
    return;
  }
  for (const r of report.results) {
    const tick = r.ok ? '✓' : '✗';
    const ruleName = r.rule.description ?? r.rule.type;
    const detail = r.rule.path ? ` (${r.rule.path}${r.rule.glob ? ` glob=${r.rule.glob}` : ''})` : '';
    console.log(`  ${tick} ${ruleName}${detail}`);
    if (!r.ok) {
      console.log(`      ${r.message}`);
    }
  }
  console.log('');
  console.log(`Result : ${report.ok ? 'PASS' : 'FAIL'} (${report.rules_passed}/${report.rules_total})`);
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.gameSlug || !args.engineId || !args.phase) {
    console.error('Usage : node datamine/_lib/validate-extraction.mjs <game-slug> <engine-id> <phase> [--json]');
    console.error('Phases : after_phase_4_extract | after_phase_5_decompile | after_phase_7_parse');
    process.exit(2);
  }
  try {
    const report = validateExtraction(args.gameSlug, args.engineId, args.phase);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report);
    }
    if (report.error) process.exit(2);
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`Erreur : ${err.message}`);
    process.exit(99);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
