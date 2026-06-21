# Export adapters (optional)

The datamine pipeline produces a **portable bundle** (`out/data` + `out/assets` +
`manifest.json`). That bundle is the deliverable. **You do not need any of these
adapters to have a complete, correct result.**

Adapters are thin, config-driven steps that push a *validated* bundle into a
specific downstream target. They read `datamine.config.json` at the repo root (see
`datamine.config.example.json`) — never hard-coded project names, buckets, or
connection strings.

| Adapter | Target | Notes |
|---------|--------|-------|
| `postgres-seed.ts` | PostgreSQL | Generic bulk seeder. Schema name and `DATABASE_URL` are parameters/env — no project coupling. Handles the array-literal / JSONB-quoting / Date / DDL-inference pitfalls automatically. |
| *static* (no code) | a static site / git repo | Just copy `out/` into the site. The default, zero-infra path. |
| object storage | S3 / GCS / R2 CDN | A ~40-line uploader — see `docs/EXPORT-ADAPTERS.md` for the reference implementation. Bucket + endpoint + CDN base come from `datamine.config.json`. |

**Order:** never run an adapter until `validate-bundle.mjs` exits 0. Garbage in →
garbage in a database is worse than garbage in a file.

See `docs/EXPORT-ADAPTERS.md` for full usage.
