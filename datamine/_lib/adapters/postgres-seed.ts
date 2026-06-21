/**
 * datamine/_lib/adapters/postgres-seed.ts
 * Helpers réutilisables pour les seeders TS des jeux. Capture les leçons
 * apprises pendant le seed STS2 (5 bugs SQL débuggés en série).
 *
 * Conventions encodées :
 *   - DDL inline (pas drizzle-kit) — workaround pour le repo qui n'arrive pas
 *     à charger drizzle-kit avec le pattern NodeNext + import './schema.js'
 *   - Array literal Postgres pour les colonnes TEXT[] (Drizzle développe les
 *     arrays JS en tuples SQL, ce qui casse l'INSERT)
 *   - JSON.stringify obligatoire pour TOUTE valeur dans une colonne JSONB
 *     (même les strings scalaires — sinon "Token "X" is invalid")
 *   - Date.toISOString()::TIMESTAMP pour passer les Dates JS à postgres-js
 *     via Drizzle template (sinon "string argument must be of type string
 *     or Buffer or ArrayBuffer. Received an instance of Date")
 *   - DDL parsable : auto-détection des colonnes TEXT[] et JSONB depuis le
 *     SQL CREATE TABLE → plus besoin de hard-coder textArrayColumns +
 *     jsonbColumns dans chaque mapping
 *
 * Usage typique (dans un seeder de jeu) :
 *
 *   import { runSeeder, FieldMapping } from '../adapters/postgres-seed.js';
 *
 *   const DDL = `
 *     CREATE SCHEMA IF NOT EXISTS "myschema";
 *     CREATE TABLE IF NOT EXISTS "myschema"."cards" (
 *       id TEXT PRIMARY KEY,
 *       name_i18n JSONB NOT NULL,
 *       cost INTEGER,
 *       keywords TEXT[],
 *       data_version TEXT NOT NULL,
 *       created_at TIMESTAMP NOT NULL DEFAULT NOW(),
 *       updated_at TIMESTAMP NOT NULL DEFAULT NOW()
 *     );
 *   `;
 *
 *   const ENTITIES: Record<string, FieldMapping> = {
 *     cards: {
 *       table: 'cards',
 *       i18nFields: { name: 'name_i18n' },
 *       scalarFields: ['cost', 'keywords'],
 *     }
 *   };
 *
 *   await runSeeder({ schema: 'myschema', ddl: DDL, entities: ENTITIES,
 *                     parsedDir: '../parsed', languages: ['eng', 'fra'],
 *                     dataVersion: 'v1.0' });
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface FieldMapping {
  /** Nom de la table (sans le schéma) */
  table: string;
  /** Champs traduits per-langue → JSONB i18n. sourceField → dbField (ex: name → name_i18n) */
  i18nFields: Record<string, string>;
  /** Champs scalaires non traduits, pris depuis la langue de référence (eng par défaut) */
  scalarFields: string[];
  /**
   * Colonnes typées TEXT[] — override l'auto-détection depuis le DDL.
   * Si non fourni, déduit depuis le DDL passé à runSeeder.
   */
  textArrayColumns?: string[];
  /**
   * Colonnes typées JSONB qui peuvent recevoir des scalaires (string/number) → toujours json-quote.
   * Si non fourni, déduit depuis le DDL.
   */
  jsonbColumns?: string[];
  /**
   * Hook spécial pour transformer le row (ex: regrouper des champs résiduels en un payload JSONB).
   */
  buildExtra?: (sourceEng: Record<string, unknown>, values: Record<string, unknown>) => void;
}

export interface RawEntity {
  id: string;
  [key: string]: unknown;
}

export interface RunSeederOptions {
  schema: string; // ex: 'slay_the_spire_2'
  ddl: string; // SQL CREATE TABLE …
  entities: Record<string, FieldMapping>;
  parsedDir: string; // chemin vers le dossier `parsed/{lang}/<entity>.json`
  languages: readonly string[]; // ex: ['eng', 'fra', ...]
  defaultLang?: string; // par défaut 'eng' — la langue dont sont prises les scalar values
  dataVersion: string; // ex: 'v0.103.2' — stocké dans data_version + datamine_runs
  manifest: {
    engine: string;
    source_type: string;
    source_path?: string;
    source_sha256?: string;
    plan_used?: string;
  };
  databaseUrl?: string; // sinon process.env.DATABASE_URL
  dryRun?: boolean;
  only?: string[]; // limiter à certaines entités
  batchSize?: number; // par défaut 200
  verbose?: boolean;
}

export interface SeedResult {
  schema: string;
  data_version: string;
  entities: Record<string, number>;
  total_rows: number;
  duration_ms: number;
  run_id?: string;
  dry_run: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// DDL parsing — auto-détection des types depuis le SQL
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse le SQL `CREATE TABLE` pour identifier les colonnes TEXT[] et JSONB.
 * Retourne un map { tableName → { textArrayCols, jsonbCols } }.
 */
export function parseColumnTypesFromDDL(ddl: string): Record<string, { textArray: Set<string>; jsonb: Set<string> }> {
  const result: Record<string, { textArray: Set<string>; jsonb: Set<string> }> = {};
  // Match toutes les déclarations CREATE TABLE ... ( ... )
  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"\.)?"?(\w+)"?\s*\(([\s\S]*?)\n\)/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRegex.exec(ddl)) !== null) {
    const tableName = m[1];
    const body = m[2];
    const textArray = new Set<string>();
    const jsonb = new Set<string>();
    // Parser les lignes de colonnes (séparées par virgules au top-level)
    // Approche simple : split par virgule + lignes ; ignorer les contraintes (PRIMARY KEY, etc.)
    const lines = body.split(/,\s*\n/).map((l) => l.trim());
    for (const line of lines) {
      const colMatch = line.match(/^"?(\w+)"?\s+(.+?)(?:\s+(NOT\s+NULL|DEFAULT|REFERENCES|PRIMARY|UNIQUE|CHECK)|$)/i);
      if (!colMatch) continue;
      const colName = colMatch[1];
      const colType = colMatch[2].toUpperCase().trim();
      if (/^TEXT\s*\[\s*\]/.test(colType) || /^VARCHAR\s*\(\d+\)\s*\[\s*\]/.test(colType)) {
        textArray.add(colName);
      } else if (colType === 'JSONB' || colType.startsWith('JSONB')) {
        jsonb.add(colName);
      }
    }
    if (textArray.size > 0 || jsonb.size > 0) {
      result[tableName] = { textArray, jsonb };
    }
  }
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// JSON loading
// ──────────────────────────────────────────────────────────────────────────────

function loadEntityForLang(parsedDir: string, entity: string, lang: string): RawEntity[] {
  const filePath = path.join(parsedDir, lang, `${entity}.json`);
  if (!existsSync(filePath)) {
    // Fallback : peut-être que c'est un JSON language-independent (ex: stories pour STS2)
    const altPath = path.join(parsedDir, `${entity}.json`);
    if (!existsSync(altPath)) return [];
    return JSON.parse(readFileSync(altPath, 'utf8')) as RawEntity[];
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as RawEntity[];
}

interface BuiltRow {
  id: string;
  values: Record<string, unknown>;
}

function buildRowsForEntity(
  entityName: string,
  mapping: FieldMapping,
  parsedDir: string,
  languages: readonly string[],
  defaultLang: string,
  dataVersion: string
): BuiltRow[] {
  const perLang = new Map<string, Map<string, RawEntity>>();
  for (const lang of languages) {
    const arr = loadEntityForLang(parsedDir, entityName, lang);
    perLang.set(lang, new Map(arr.map((e) => [e.id, e])));
  }
  const allIds = new Set<string>();
  for (const [, m] of perLang) {
    for (const id of m.keys()) allIds.add(id);
  }
  const sourceLang = perLang.get(defaultLang) ?? perLang.get(languages[0]);
  if (!sourceLang) return [];

  const rows: BuiltRow[] = [];
  for (const id of allIds) {
    const sourceEng = sourceLang.get(id);
    if (!sourceEng) continue;
    const values: Record<string, unknown> = { id };

    for (const [srcField, dbField] of Object.entries(mapping.i18nFields)) {
      const i18nMap: Record<string, unknown> = {};
      for (const lang of languages) {
        const e = perLang.get(lang)?.get(id);
        const v = e?.[srcField];
        if (v !== undefined && v !== null) i18nMap[lang] = v;
      }
      values[dbField] = Object.keys(i18nMap).length > 0 ? i18nMap : null;
    }
    for (const field of mapping.scalarFields) {
      values[field] = sourceEng[field] ?? null;
    }
    if (mapping.buildExtra) {
      mapping.buildExtra(sourceEng, values);
    }
    values.data_version = dataVersion;
    rows.push({ id, values });
  }
  return rows;
}

function columnsForEntity(mapping: FieldMapping): string[] {
  const cols = ['id'];
  cols.push(...Object.values(mapping.i18nFields));
  cols.push(...mapping.scalarFields);
  cols.push('data_version');
  // Dedup en gardant l'ordre
  return Array.from(new Set(cols));
}

// ──────────────────────────────────────────────────────────────────────────────
// Bulk upsert — la fonction qui a fait pleurer pendant STS2
// ──────────────────────────────────────────────────────────────────────────────

export async function bulkUpsert(
  db: ReturnType<typeof drizzle>,
  schema: string,
  table: string,
  rows: BuiltRow[],
  columns: string[],
  textArrayColumns: Set<string>,
  jsonbColumns: Set<string>,
  batchSize = 200
): Promise<number> {
  if (rows.length === 0) return 0;
  let inserted = 0;
  const updateSet = columns
    .filter((c) => c !== 'id' && c !== 'created_at')
    .map((c) => `"${c}" = EXCLUDED."${c}"`)
    .concat(['"updated_at" = NOW()'])
    .join(', ');
  const colsSql = columns.map((c) => `"${c}"`).join(', ');

  // Convention : toutes les colonnes terminant par _i18n sont JSONB (i18n maps)
  const isJsonbColumn = (col: string): boolean => col.endsWith('_i18n') || jsonbColumns.has(col);

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const tuples = batch.map((row) => {
      const vals = columns.map((col) => {
        const v = row.values[col];
        if (v === null || v === undefined) return sql`NULL`;

        // 1. Colonne explicitement TEXT[] : array literal Postgres '{...}'::TEXT[]
        if (textArrayColumns.has(col)) {
          if (!Array.isArray(v)) {
            // Valeur scalaire dans une colonne array → promote
            const escaped = '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
            return sql`${`{${escaped}}`}::TEXT[]`;
          }
          if (v.length === 0) return sql`ARRAY[]::TEXT[]`;
          const escaped = (v as unknown[]).map((s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',');
          return sql`${`{${escaped}}`}::TEXT[]`;
        }

        // 2. Colonne JSONB : json-stringify TOUT (string scalaire incluse)
        if (isJsonbColumn(col)) {
          return sql`${JSON.stringify(v)}::JSONB`;
        }

        // 3. Date JS : convertir en ISO string + cast TIMESTAMP
        if (v instanceof Date) {
          return sql`${v.toISOString()}::TIMESTAMP`;
        }

        // 4. Inférence : array ou object → JSONB (filet de sécurité si jsonbColumns oublié)
        if (Array.isArray(v) || typeof v === 'object') {
          return sql`${JSON.stringify(v)}::JSONB`;
        }

        // 5. Scalaire : passer tel quel
        return sql`${v}`;
      });
      return sql`(${sql.join(vals, sql`, `)})`;
    });

    const valuesJoined = sql.join(tuples, sql`, `);
    await db.execute(sql`
      INSERT INTO ${sql.raw(`"${schema}"."${table}"`)} (${sql.raw(colsSql)})
      VALUES ${valuesJoined}
      ON CONFLICT (id) DO UPDATE SET ${sql.raw(updateSet)}
    `);
    inserted += batch.length;
  }
  return inserted;
}

// ──────────────────────────────────────────────────────────────────────────────
// DDL execution — chunk en statements + idempotent
// ──────────────────────────────────────────────────────────────────────────────

export async function applyDDL(db: ReturnType<typeof drizzle>, ddl: string, verbose = false): Promise<number> {
  const statements = ddl
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.execute(sql.raw(stmt));
  }
  if (verbose) console.log(`[seed-runner] DDL OK — ${statements.length} statements`);
  return statements.length;
}

// ──────────────────────────────────────────────────────────────────────────────
// Datamine runs metadata
// ──────────────────────────────────────────────────────────────────────────────

async function logDatamineRun(
  db: ReturnType<typeof drizzle>,
  schema: string,
  manifest: RunSeederOptions['manifest'],
  dataVersion: string,
  counts: Record<string, number>,
  languages: readonly string[],
  startedAt: Date,
  finishedAt: Date,
  success: boolean
): Promise<string> {
  const runId = randomUUID();
  const langArrayLit = `{${languages.join(',')}}`;
  await db.execute(sql`
    INSERT INTO ${sql.raw(`"${schema}"."datamine_runs"`)}
      (id, data_version, source_type, source_path, source_sha256, engine, plan_used, counts, languages, started_at, finished_at, success)
    VALUES (${runId}, ${dataVersion}, ${manifest.source_type}, ${manifest.source_path ?? null},
            ${manifest.source_sha256 ?? null}, ${manifest.engine}, ${manifest.plan_used ?? null},
            ${JSON.stringify(counts)}::JSONB, ${langArrayLit}::TEXT[],
            ${startedAt.toISOString()}::TIMESTAMP, ${finishedAt.toISOString()}::TIMESTAMP, ${success})
  `);
  return runId;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main runner
// ──────────────────────────────────────────────────────────────────────────────

export async function runSeeder(opts: RunSeederOptions): Promise<SeedResult> {
  const startedAt = new Date();
  const defaultLang = opts.defaultLang ?? opts.languages[0];
  const verbose = opts.verbose ?? true;
  const batchSize = opts.batchSize ?? 200;

  // 1. Auto-détection des types depuis le DDL
  const inferredTypes = parseColumnTypesFromDDL(opts.ddl);
  if (verbose) {
    console.log(`[seed-runner] DDL analysé : ${Object.keys(inferredTypes).length} tables`);
    for (const [tbl, types] of Object.entries(inferredTypes)) {
      const tArr = [...types.textArray];
      const jArr = [...types.jsonb];
      if (tArr.length > 0 || jArr.length > 0) {
        console.log(`  ${tbl}: text[]=[${tArr.join(',')}] jsonb=[${jArr.join(',')}]`);
      }
    }
  }

  // 2. Build des rows (offline)
  const built: Record<string, { rows: BuiltRow[]; cols: string[]; textArr: Set<string>; jsonb: Set<string> }> = {};
  for (const [name, mapping] of Object.entries(opts.entities)) {
    if (opts.only && !opts.only.includes(name)) continue;
    const rows = buildRowsForEntity(name, mapping, opts.parsedDir, opts.languages, defaultLang, opts.dataVersion);
    const cols = columnsForEntity(mapping);
    const inferred = inferredTypes[mapping.table] ?? { textArray: new Set<string>(), jsonb: new Set<string>() };
    const textArr = new Set([...inferred.textArray, ...(mapping.textArrayColumns ?? [])]);
    const jsonb = new Set([...inferred.jsonb, ...(mapping.jsonbColumns ?? [])]);
    built[name] = { rows, cols, textArr, jsonb };
    if (verbose) console.log(`  ${name.padEnd(15)} : ${rows.length} rows`);
  }

  if (opts.dryRun) {
    const totalRows = Object.values(built).reduce((acc, b) => acc + b.rows.length, 0);
    if (verbose) console.log(`[seed-runner] DRY RUN — ${totalRows} rows would be inserted`);
    return {
      schema: opts.schema,
      data_version: opts.dataVersion,
      entities: Object.fromEntries(Object.entries(built).map(([n, b]) => [n, b.rows.length])),
      total_rows: totalRows,
      duration_ms: Date.now() - startedAt.getTime(),
      dry_run: true,
    };
  }

  // 3. Connexion DB
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant. Passer via opts.databaseUrl ou env.');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  try {
    // 4. DDL
    await applyDDL(db, opts.ddl, verbose);

    // 5. Bulk inserts par entité
    const counts: Record<string, number> = {};
    for (const [name, b] of Object.entries(built)) {
      const mapping = opts.entities[name];
      const count = await bulkUpsert(db, opts.schema, mapping.table, b.rows, b.cols, b.textArr, b.jsonb, batchSize);
      counts[name] = count;
      if (verbose) console.log(`  ✓ ${name.padEnd(15)} : ${count} rows upserted`);
    }

    // 6. Log datamine_run
    const finishedAt = new Date();
    const runId = await logDatamineRun(
      db,
      opts.schema,
      opts.manifest,
      opts.dataVersion,
      counts,
      opts.languages,
      startedAt,
      finishedAt,
      true
    );
    if (verbose) console.log(`[seed-runner] Run logged: ${runId}`);

    return {
      schema: opts.schema,
      data_version: opts.dataVersion,
      entities: counts,
      total_rows: Object.values(counts).reduce((acc, n) => acc + n, 0),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      run_id: runId,
      dry_run: false,
    };
  } finally {
    await client.end();
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// DDL standard pour datamine_runs (à inclure au début du DDL de tout jeu)
// ──────────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// Game catalog — mise à jour depuis les seeders TS
// ──────────────────────────────────────────────────────────────────────────────

const CATALOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'game-catalog.json');

/**
 * Met à jour l'entrée d'un jeu dans game-catalog.json.
 * Crée l'entrée si elle n'existe pas encore.
 * Silent no-op si le fichier catalogue n'existe pas.
 */
export function updateCatalog(slug: string, patch: Record<string, unknown>): void {
  if (!existsSync(CATALOG_PATH)) return;
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as {
    games: Array<Record<string, unknown>>;
  };
  const idx = catalog.games.findIndex((g) => g['slug'] === slug);
  if (idx === -1) {
    catalog.games.push({ slug, ...patch });
  } else {
    catalog.games[idx] = { ...catalog.games[idx], ...patch };
  }
  writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
}

export function datamineRunsDDL(schema: string): string {
  return `
CREATE SCHEMA IF NOT EXISTS "${schema}";
CREATE TABLE IF NOT EXISTS "${schema}"."datamine_runs" (
  id TEXT PRIMARY KEY,
  data_version TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_path TEXT,
  source_sha256 TEXT,
  engine TEXT NOT NULL,
  plan_used TEXT,
  counts JSONB NOT NULL,
  languages TEXT[] NOT NULL,
  started_at TIMESTAMP NOT NULL,
  finished_at TIMESTAMP,
  success BOOLEAN NOT NULL,
  error_log TEXT
);
`;
}
