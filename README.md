# dataminage-repo

**A self-contained kit for datamining any Windows game into a portable bundle you can
build a wiki or a "dle" from.** Hand a fresh Claude this repo plus a game zip, and it
has everything it needs to extract the game's data and art with **zero tolerated
error** — regardless of engine (Godot, Unity Mono/IL2CPP, Unreal, GameMaker, LÖVE,
Electron, Flash, or a custom native engine).

It is **project-agnostic**: no database, no cloud bucket, no site framework is baked
in. The output is a clean, verifiable **bundle** (`out/data` + `out/assets` +
`manifest.json`). Any downstream — a SvelteKit wiki, a daily-guessing dle, Postgres,
a static site — is built *from* that bundle, optionally and separately.

## Two things live here

1. **The skill** — `.claude/skills/datamine/SKILL.md`. The mandatory playbook a Claude
   follows: **ultrathink**, **workflows are mandatory** for all fan-out work,
   **sub-agents** for parallel extraction and adversarial verification, and **no time
   or token limit** — thoroughness wins. Invoke with `/datamine <zip | dir | slug>`.
2. **The toolchain** — `datamine/`. Engine-agnostic scripts (`_lib/`) plus a
   per-game workspace for each game you process.

## Start here

| If you want to… | Read |
|------------------|------|
| Understand exactly what a finished datamine must produce (the contract) | **`docs/OUTPUT-CONTRACT.md`** ← most important |
| Run a datamine | `.claude/skills/datamine/SKILL.md`, then `datamine/README.md` |
| Know the per-engine recipes + known traps | `datamine/_lib/toolchains.md` |
| Push a finished bundle into a DB / CDN (optional) | `docs/EXPORT-ADAPTERS.md` |

## The contract in one breath

A run is **done** only when `node datamine/_lib/validate-bundle.mjs <slug>` prints
`0 hard errors` and exits 0 — meaning every entity file is a non-empty array, every
record has a stable `id` and a **human-readable** name (never a raw technical id),
every declared image **resolves to a real file**, every cross-entity reference
**exists** (no 404s), and every player-visible wiki category is **covered** or
explicitly marked absent. That gate is what "aucune erreur tolérée" means in code.

## Layout

```
dataminage-repo/
├── README.md                       (this file)
├── .gitignore                      games never committed; heavy intermediates ignored
├── datamine.config.example.json    optional — only for export adapters
├── .claude/skills/datamine/SKILL.md   ★ the skill
├── docs/
│   ├── OUTPUT-CONTRACT.md          ★ what a finished datamine must produce
│   └── EXPORT-ADAPTERS.md          optional downstream (Postgres / object storage / static)
└── datamine/
    ├── README.md
    ├── _lib/                       engine-agnostic toolchain (see datamine/README.md)
    └── <game-slug>/                one workspace per game (the bundle lives in out/)
```

## Adding a new game

```bash
node datamine/_lib/discover-game.mjs  /path/to/Game.zip --json
node datamine/_lib/init-workspace.mjs new-game-slug --display-name="New Game"
# then: /datamine new-game-slug   (the skill drives the rest)
```
