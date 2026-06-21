# `datamine/` — the toolchain + per-game workspaces

This folder holds everything needed to datamine a game, and the workspace for each
game you've processed.

```
datamine/
├── _lib/                  ← shared, engine-agnostic toolchain (committed, reusable)
│   ├── discover-game.mjs        Phase 0: probe input → engine, extractor, plan (RUN THIS FIRST)
│   ├── detect-engine.mjs        Engine fingerprinting (confirmation)
│   ├── extract-zip.mjs          Universal decompression (handles Zstandard / method 93, etc.)
│   ├── check-tools.mjs          Toolchain presence check per engine
│   ├── install-tool.mjs         Download + SHA-256 verify + install (no trust-on-first-use)
│   ├── init-workspace.mjs       Create datamine/<slug>/ + manifest skeleton
│   ├── wiki-discovery.mjs        Find the best public wiki for a game
│   ├── wiki-categories-fetch.mjs Fetch a game's content categories (the "what must exist" checklist)
│   ├── shallow-extract.mjs      Always-works fallback extraction
│   ├── validate-extraction.mjs  Per-phase sanity checks
│   ├── build-bundle.mjs         Finalize the bundle: recompute TRUE counts/coverage from disk
│   ├── validate-bundle.mjs      ★ THE GATE: exits 1 on any hard error (zero-error contract)
│   ├── humanize-id.ts           id → human name (name-resolution cascade, step 4)
│   ├── parser-template.{py,ts}  Starting points for game-specific parsers
│   ├── llm-parser-gen.md        Checklist for writing a parser from scratch
│   ├── toolchains.md            ★ Plan A/B/C per engine + the known-traps cookbook
│   ├── engine-fingerprints.json Detection matrix
│   ├── tool-registry.json       Tool versions + pinned SHA-256 + GitHub release URLs
│   ├── validation-rules.json    Per-engine/phase sanity rules
│   ├── public-sources.json      Optional OSS-data-source registry (ships empty)
│   ├── manifest.template.json   Reference manifest
│   └── adapters/                Optional, config-driven export (Postgres, object storage)
│
└── <game-slug>/           ← one workspace per game (created by init-workspace.mjs)
    ├── parsers/                 committed — only if no OSS parser exists
    ├── out/                     committed — THE BUNDLE (data/ + assets/ + manifest.json)
    ├── extracted/   parsed/   zip-unpacked/   .tools/      gitignored, reproducible
```

## The loop, in one screen

```bash
node datamine/_lib/discover-game.mjs   <zip-or-dir> --json     # 0  investigate
node datamine/_lib/wiki-categories-fetch.mjs <slug> --name="…" # 0.5 what must exist
node datamine/_lib/init-workspace.mjs  <slug> --display-name="…"
node datamine/_lib/extract-zip.mjs     <zip> --out=datamine/<slug>/zip-unpacked
node datamine/_lib/detect-engine.mjs   datamine/<slug>/zip-unpacked --json
node datamine/_lib/check-tools.mjs     <engine> --json
# … extract assets + decompile code (see toolchains.md) …
# … parse → out/data/*.json, extract images → out/assets/<type>/<id>.<ext> …
node datamine/_lib/build-bundle.mjs    <slug>                  # truthful counts
node datamine/_lib/validate-bundle.mjs <slug>                  # ★ must exit 0
```

The full, mandatory playbook (ultrathink + workflows + sub-agents, no limits) is the
skill at `.claude/skills/datamine/SKILL.md`. The definition of "done" is
`docs/OUTPUT-CONTRACT.md`.

`_lib/` is shared across all games — don't edit it for one game's quirks. Per-game
code goes in `datamine/<slug>/parsers/`.
