/**
 * Parser pour <ENTITY> dans <GAME DISPLAY NAME>.
 * Engine : <engine-id>
 * Généré par Claude le <YYYY-MM-DD> à partir de :
 *   - <sample1>
 *   - <sample2>
 *   - <sample3>
 *   - <sample4>
 *   - <sample5>
 *
 * Validation : <X> / <Y> fichiers parsés (<pourcent>%)
 *
 * Cas connus non gérés :
 *   - (à remplir au fur et à mesure)
 *
 * Assumptions :
 *   - (lister les invariants identifiés à l'étape 2 de llm-parser-gen.md)
 *
 * Fragilité : (pourquoi ce parser peut casser à la prochaine version du jeu)
 *
 * Usage :
 *   pnpm tsx parse-<entity>.ts <fichier>             # parse un seul fichier
 *   pnpm tsx parse-<entity>.ts --self-test           # validation 95%
 *   pnpm tsx parse-<entity>.ts --batch <dir>         # batch
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ──────────────────────────────────────────────────────────────────────────────
// Configuration (à adapter au jeu)
// ──────────────────────────────────────────────────────────────────────────────

const DECOMPILED_DIR = 'extracted/raw/scripts'; // typique pour GDScript/Lua/JS
const SUCCESS_RATE_TARGET = 0.95;
const FILE_GLOB_EXT = '.gd'; // ou '.lua', '.js', '.json' selon l'engine

// ──────────────────────────────────────────────────────────────────────────────
// Schéma de sortie
// ──────────────────────────────────────────────────────────────────────────────

export interface EntityRecord {
  id: string;
  name: string;
  description: string | null;
  // …ajouter les champs identifiés à l'étape 2
  raw_source_file: string;
}

export class ParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParserError';
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Parsing
// ──────────────────────────────────────────────────────────────────────────────

const RE_CLASS_DECL = /^class_name\s+(?<id>\w+)/m;
const RE_NAME_FIELD = /^var\s+name\s*=\s*"(?<name>[^"]+)"/m;
const RE_DESC_FIELD = /^var\s+description\s*=\s*"(?<desc>[^"]+)"/m;

export function parseEntity(content: string, sourceFile: string): EntityRecord {
  const classMatch = content.match(RE_CLASS_DECL);
  if (!classMatch || !classMatch.groups) {
    throw new ParserError(`no class declaration in ${sourceFile}`);
  }
  const entityId = classMatch.groups.id;

  const nameMatch = content.match(RE_NAME_FIELD);
  if (!nameMatch || !nameMatch.groups) {
    throw new ParserError(`no Name field in ${sourceFile}`);
  }
  const name = nameMatch.groups.name;

  const descMatch = content.match(RE_DESC_FIELD);
  const description = descMatch?.groups?.desc ?? null;

  return {
    id: entityId,
    name,
    description,
    raw_source_file: sourceFile,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Batch / self-test
// ──────────────────────────────────────────────────────────────────────────────

function listFilesRecursive(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    let contents;
    try {
      contents = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of contents) {
      const full = path.join(d, dirent.name);
      if (dirent.isDirectory()) stack.push(full);
      else if (dirent.isFile() && full.endsWith(ext)) out.push(full);
    }
  }
  return out.sort();
}

export function parseBatch(dir: string): { records: EntityRecord[]; errors: { file: string; message: string }[] } {
  const files = listFilesRecursive(dir, FILE_GLOB_EXT);
  const records: EntityRecord[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf8');
      records.push(parseEntity(content, file));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ file, message: msg });
    }
  }
  return { records, errors };
}

function selfTest(): number {
  const { records, errors } = parseBatch(DECOMPILED_DIR);
  const total = records.length + errors.length;
  if (total === 0) {
    console.error(`⚠ No files found in ${DECOMPILED_DIR}`);
    return 2;
  }
  const rate = records.length / total;
  console.log(`Parsed ${records.length} / ${total} files (${(rate * 100).toFixed(1)}%)`);
  if (errors.length > 0) {
    console.log(`Failures (${errors.length}) — showing first 10 :`);
    for (const e of errors.slice(0, 10)) {
      console.log(`  - ${e.file}: ${e.message}`);
    }
  }
  if (rate < SUCCESS_RATE_TARGET) {
    console.log(`✗ Below target ${(SUCCESS_RATE_TARGET * 100).toFixed(0)}% — review failures and improve parser`);
    return 1;
  }
  console.log(`✓ Above target ${(SUCCESS_RATE_TARGET * 100).toFixed(0)}%`);
  return 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────────

function main(argv: string[]): number {
  if (argv.includes('--self-test')) {
    return selfTest();
  }
  const batchIdx = argv.indexOf('--batch');
  if (batchIdx !== -1) {
    const dir = argv[batchIdx + 1];
    if (!dir) {
      console.error('--batch requires a directory argument');
      return 1;
    }
    const result = parseBatch(dir);
    console.log(JSON.stringify(result, null, 2));
    return result.errors.length > 0 ? 1 : 0;
  }
  const positional = argv.slice(2).find((a) => !a.startsWith('--'));
  if (positional) {
    if (!existsSync(positional)) {
      console.error(`File not found: ${positional}`);
      return 1;
    }
    try {
      const record = parseEntity(readFileSync(positional, 'utf8'), positional);
      console.log(JSON.stringify(record, null, 2));
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`ParserError: ${msg}`);
      return 1;
    }
  }
  console.error('Usage: pnpm tsx parse-<entity>.ts <file> | --batch <dir> | --self-test');
  return 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exit(main(process.argv));
}
