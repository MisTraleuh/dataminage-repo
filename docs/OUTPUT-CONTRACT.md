# Output Contract — the portable datamine bundle

> **This is the single most important document in the repo.**
> A datamine run is *finished* when, and only when, it has produced a bundle that
> satisfies every rule below **and `validate-bundle.mjs` exits 0**. The bundle —
> not a database, not a website — is the deliverable. Any wiki or dle site is then
> built *from* this bundle. **Aucune erreur n'est tolérée :** the validator is the
> gate, and it is non-negotiable.

The datamine tool is **target-agnostic**. It does not know or care whether the
output becomes a SvelteKit wiki, a daily-guessing "dle" game, a Postgres table, or
a static JSON site. It produces one thing: a clean, self-describing, **portable
bundle** that any of those can consume. Database/CDN export is a separate, optional
step (see `EXPORT-ADAPTERS.md`).

---

## 1. Where the bundle lives

Every game gets a workspace at `datamine/<game-slug>/`. The bundle is the `out/`
subtree — and only `out/` plus `manifest.json` and `parsers/` are committed; the
heavy intermediate dirs (`extracted/`, `parsed/`, `zip-unpacked/`) are gitignored
and fully reproducible.

```
datamine/<game-slug>/
├── out/                     # ← THE BUNDLE (the only thing a site needs)
│   ├── manifest.json        # the single source of truth — index of the whole bundle (§4)
│   ├── data/
│   │   └── <entity_type>.json     # one JSON array per entity type (§2)
│   ├── assets/
│   │   └── <entity_type>/<id>.<ext>   # one image/audio file per record (§3)
│   └── missing_images.json  # documented, justified absences (§3)
├── parsers/                 # game-specific parsers (only if no OSS parser exists)
├── extracted/   (gitignored — raw assets + decompiled code)
├── parsed/      (gitignored — pre-bundle structured JSON)
└── zip-unpacked/(gitignored — raw decompression)
```

There is exactly **one** manifest — `out/manifest.json`. It ships with the bundle,
and both `build-bundle.mjs` and `validate-bundle.mjs` read and write it.

`out/` must be **self-contained**: copy that folder anywhere and a site can be
built with zero access to the original game files.

---

## 2. Data — `out/data/<entity_type>.json`

One file per entity type. Each file is a **non-empty JSON array of records**. A
record is a flat-ish JSON object. The contract per record:

| Field | Rule |
|-------|------|
| `id` | **Required.** String, unique within the entity type, stable across re-runs. The game's internal id is fine as the value — but it must never surface as a *display name*. |
| `name` | **Required, human-readable.** Either a string, or an i18n map `{ "eng": "...", "fra": "..." }`. Never a raw technical id (`rooms_Floor1_Large`, `HOUSE_BUTTON_DEFEND`, `set_x_v2`). If the game has no label, you **fabricate** one from the id (humanize) — see the name cascade in the skill. |
| `description` | Optional. String or i18n map. Runtime template tokens (`{aux}`, `{str_aux_active_name}`) must be resolved or replaced with readable substitutes — never shown raw. |
| `image` | Optional. A path **relative to `out/assets/`** (e.g. `"cards/strike.png"`), OR an inline `data:` URI placeholder. If present, the file **must exist**. |
| typed fields | Scalars (`cost`, `rarity`, `hp`), arrays (`keywords`), nested objects (`stats`). Promote anything a site renders into a typed field — don't bury it in an opaque blob a front-end must re-parse. |
| relation fields | Arrays or scalars of **ids that reference other entity types** (e.g. `character.abilities = ["WolfLeap"]`). Every referenced id **must exist** in its target file. |

**i18n convention.** A field is translatable iff it is an object keyed by language
code. `manifest.languages` lists the languages present. Single-language games may
use plain strings everywhere — both forms are valid. The validator resolves the
primary language (`manifest.languages[0]`, default `eng`).

**Exhaustiveness is the default.** Ship *every* entity a player can encounter, not
a 3–5 row sample. Reducing scope is allowed only on explicit instruction or a
documented technical impossibility.

---

## 3. Assets — `out/assets/<entity_type>/<id>.<ext>`

- One file per record that has a visual, named by the record `id`, under a
  per-entity-type subfolder. The record's `image` field points at it
  (`"<entity_type>/<id>.<ext>"`).
- Images come **only from the game's own assets** (sprites, textures, SWF, atlases,
  decompiled UI). **Never scrape a third-party wiki for images.** The whole point is
  to be the *first* wiki on a new game — the pipeline must be autonomous.
- Records genuinely without a visual (programmatic/test/internal entities) go in
  `out/missing_images.json` with a documented reason:

```json
{ "entries": [
  { "entity_type": "events", "id": "house_intro", "reason": "programmatic event, no sprite in game" }
] }
```

`render_failed` / `empty_render` are **not** acceptable reasons without a documented
investigation. "I didn't look" is never a reason.

---

## 4. `manifest.json` — the index

The manifest is what a downstream tool reads first. **You declare** the entity
types, their name/image fields, relations and wiki coverage; **`build-bundle.mjs`
fills in** the truthful counts, image coverage and reference integrity from disk.

```jsonc
{
  "game_slug": "slay-the-spire-2",
  "display_name": "Slay the Spire 2",
  "engine": "godot4-csharp",
  "game_version": "1.0.0",
  "languages": ["eng", "fra"],

  "entities": {
    "cards": {
      "file": "data/cards.json",
      "name_field": "name",          // default "name"
      "image_field": "image",        // default "image"
      "relations": [
        { "field": "keywords", "target": "keywords" }
      ],
      "count": 576                   // ← filled by build-bundle from disk
    }
  },

  "wiki_coverage": {                 // every player-visible category must map…
    "Cards": "cards",
    "Bosses": "characters",
    "Achievements": "n/a — confirmed absent from game data after binary decompile"
  },

  "image_coverage": { "cards": { "extracted": 576, "total": 576, "pct": 100 } }, // filled by build-bundle
  "reference_integrity": { "characters.abilities -> abilities": { "refs": 84, "broken": 0 } }, // filled by build-bundle
  "bundle": { "built_at": "…", "validated": true, "validator_version": "1" }
}
```

A template lives at `datamine/_lib/manifest.template.json`.

---

## 5. The gate — what "no error" means concretely

`node datamine/_lib/build-bundle.mjs <slug>` then
`node datamine/_lib/validate-bundle.mjs <slug>`.

The validator **exits 1** (bundle not shippable) on any of:

1. A declared entity whose data file is missing, unreadable, not an array, or empty.
2. A record with no `id`, or a duplicate `id`.
3. A record whose `name` is empty or a raw technical id (name cascade incomplete).
4. An `image` path that does not resolve to a real file under `assets/`.
5. A relation referencing an id absent from its target entity (>5% broken = hard).
6. A wiki category with real content that maps to no produced entity type and is
   not explicitly marked `"n/a — <reason>"`.
7. A manifest `count` that disagrees with the data file by more than 1%.

It prints **warnings** (non-blocking) for image coverage < 70%, records with no
image absent from `missing_images.json`, and small broken-ref counts.

**A run is done only when `validate-bundle.mjs` prints `0 hard errors` and exits 0.**
At that point set `bundle.validated = true`. Until then, the datamine is not finished
— no matter how much was extracted.

---

## 6. Why this shape

- **Portable** → the same bundle feeds a wiki, a dle, Postgres, or a static site.
  No infra is required to *produce* a correct result.
- **Verifiable** → every guarantee a site relies on (names exist, images resolve,
  references are not 404s, categories are covered) is mechanically checkable, so a
  fresh Claude with only the game zip can reach a *provably* complete result.
- **Decoupled** → no project name, database, or bucket appears in the contract.
  Export to a specific target is a thin, optional, config-driven adapter step.
