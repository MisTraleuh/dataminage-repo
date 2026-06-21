# Export adapters (optional, config-driven)

The datamine pipeline's job ends at a **validated portable bundle** (`out/`). Turning
that bundle into a live wiki/dle is a separate concern, and intentionally pluggable.
Nothing here is required for a correct datamine — these are conveniences for shipping
the bundle into a target.

> **Hard rule:** never run an adapter until `node datamine/_lib/validate-bundle.mjs
> <slug>` exits 0. Adapters trust the bundle; the validator is what makes it trustworthy.

All adapters read **`datamine.config.json`** at the repo root (copy
`datamine.config.example.json`). No project name, bucket, or DSN is hard-coded.

```jsonc
{
  "target": "static",                 // "static" | "postgres" | "object-storage" | combos
  "postgres": {
    "schemaFromSlug": true,           // schema = slug with - → _
    "urlEnv": "DATABASE_URL"          // connection string read from this env var
  },
  "objectStorage": {
    "provider": "gcs",                // "gcs" | "s3" | "r2"
    "bucket": "my-cdn-bucket",
    "cdnBase": "https://cdn.example.com",
    "keyTemplate": "{slug}/{entity_type}/{id}.{ext}",
    "credentialsEnv": "STORAGE_CREDENTIALS_JSON"
  }
}
```

---

## 1. Static (default, zero-infra)

The bundle *is* the site's data. Copy `out/` into your wiki/dle repo (or symlink it),
point the front-end at `out/data/*.json` and `out/assets/`. Done. Recommended for a
first launch and for any site that ships its own data.

---

## 2. PostgreSQL — `datamine/_lib/adapters/postgres-seed.ts`

A generic bulk seeder (originally hardened over real runs — it auto-handles the five
classic SQL pitfalls: JS arrays → Postgres array literals, scalar-into-JSONB quoting,
JS `Date` → `toISOString()::TIMESTAMP`, TEXT[]/JSONB column inference from the DDL,
and idempotent multi-statement DDL). It is game-agnostic: the schema is a parameter
(default: slug with `-`→`_`) and the connection comes from `DATABASE_URL`.

```bash
export DATABASE_URL="postgres://…"
pnpm exec tsx datamine/_lib/adapters/postgres-seed.ts <slug>   # wrap with a per-game DDL
```

You provide the `CREATE TABLE` DDL (one table per entity type, columns matching the
bundle's typed fields) and a field mapping; the runner does the rest. After seeding,
re-verify in the DB that no `name`/`name_i18n` is NULL and counts match the bundle —
the bundle JSON is not proof the DB write succeeded.

---

## 3. Object storage (S3 / GCS / R2) — reference uploader

Uploads `out/assets/**` to a bucket and rewrites each record's `image` to the CDN URL.
Provider creds + bucket + CDN base come from `datamine.config.json` — **never** a
hard-coded bucket name.

```ts
// adapters/upload-assets.ts (reference — wire to your provider SDK)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(readFileSync('datamine.config.json', 'utf8')).objectStorage;
const creds = JSON.parse(process.env[cfg.credentialsEnv]);
// const client = makeClient(cfg.provider, creds);   // S3Client | Storage | R2…

function key(slug, type, id, ext) {
  return cfg.keyTemplate
    .replace('{slug}', slug).replace('{entity_type}', type)
    .replace('{id}', id).replace('{ext}', ext);
}

// For each out/assets/<type>/<file>: upload to cfg.bucket at key(...),
// then UPDATE the record's `image` (or the DB column) to `${cfg.cdnBase}/${key}`.
// Make it idempotent (skip if the object already exists) and log uploaded/updated/failed.
```

The point: the *contract* (`OUTPUT-CONTRACT.md`) never mentions a bucket. Only this
optional step does, and only via config. That is what keeps the repo reusable across
unrelated projects.
