/**
 * datamine/_lib/init-workspace.mjs
 * Initialise a datamine workspace for a new game.
 *
 * This is engine- AND target-agnostic. The workspace produces a PORTABLE OUTPUT
 * BUNDLE (out/data + out/assets + manifest.json) — see docs/OUTPUT-CONTRACT.md.
 * No database, no cloud, no project-specific assumption is baked in here.
 *
 * Usage : node datamine/_lib/init-workspace.mjs <game-slug> [--display-name="<name>"]
 * Example : node datamine/_lib/init-workspace.mjs hollow-knight --display-name="Hollow Knight"
 */

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATAMINE_ROOT = path.resolve(__dirname, '..');

// game-slug convention: strict kebab-case, must start with a letter
const GAME_SLUG_REGEX = /^[a-z][a-z0-9-]*$/;

function parseArgs(argv) {
  const args = { slug: null, displayName: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--display-name=')) {
      args.displayName = arg.slice('--display-name='.length).replace(/^["']|["']$/g, '');
    } else if (!args.slug && !arg.startsWith('--')) {
      args.slug = arg;
    }
  }
  return args;
}

function printUsageAndExit(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error('Usage : node datamine/_lib/init-workspace.mjs <game-slug> [--display-name="<name>"]');
  console.error('Example : node datamine/_lib/init-workspace.mjs hollow-knight --display-name="Hollow Knight"');
  console.error('\ngame-slug rules:');
  console.error('  - strict kebab-case (lowercase letters + digits + hyphens)');
  console.error('  - must start with a letter');
  console.error('  - ok  : slay-the-spire-2, mewgenics, vampire-crawlers');
  console.error('  - bad : SlayTheSpire2, 2-spire, slay_the_spire_2');
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv);

  if (!args.slug) printUsageAndExit('missing <game-slug> argument');
  if (!GAME_SLUG_REGEX.test(args.slug)) {
    printUsageAndExit(`invalid game-slug "${args.slug}". Expected strict kebab-case (regex ${GAME_SLUG_REGEX}).`);
  }

  const workspaceDir = path.join(DATAMINE_ROOT, args.slug);
  if (existsSync(workspaceDir)) {
    console.error(`Error: workspace "${args.slug}" already exists at ${workspaceDir}`);
    console.error('To reset, delete the folder manually (WARNING: artifacts will be lost).');
    process.exit(2);
  }

  // Workspace layout:
  //   zip-unpacked/      raw decompression of the source zip            (gitignored)
  //   extracted/raw      assets pulled out of the game                  (gitignored)
  //   extracted/decompiled  decompiled code / strings                   (gitignored)
  //   parsed/<lang>/     structured JSON produced by parsers            (gitignored, heavy)
  //   parsers/           game-specific parsers (kept in git)
  //   out/data/          ← THE BUNDLE: clean per-entity JSON            (the deliverable)
  //   out/assets/        ← THE BUNDLE: organized images/audio          (the deliverable)
  //   .tools/            tool binaries downloaded for this game         (gitignored)
  const subdirs = [
    'zip-unpacked', 'extracted', 'extracted/raw', 'extracted/decompiled',
    'parsed', 'parsers', 'out', 'out/data', 'out/assets', '.tools',
  ];
  for (const sub of subdirs) mkdirSync(path.join(workspaceDir, sub), { recursive: true });

  const displayName = args.displayName ?? args.slug
    .split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const manifest = {
    game_slug: args.slug,
    display_name: displayName,
    engine: null,
    engine_detection: {
      pending: true, score: null, confidence: null,
      alternatives: [], fingerprints_version: null, detected_at: null,
    },
    source: { type: null, path: null, sha256: null },
    game_version: null,
    languages: [],
    last_datamine_at: null,
    // Filled in during the run — see docs/OUTPUT-CONTRACT.md
    entities: {},          // { <entity_type>: { count, file, image_field, relations: [] } }
    wiki_coverage: {},     // { <wiki category>: "<entity_type>" | "n/a — reason" }
    image_coverage: {},    // { <entity_type>: { extracted, total, pct } }
    reference_integrity: {},
    bundle: { built_at: null, validated: false, validator_version: null },
    created_at: new Date().toISOString(),
  };

  // Single source of truth: the manifest lives WITH the bundle, at out/manifest.json.
  // build-bundle.mjs and validate-bundle.mjs both operate on this file.
  writeFileSync(path.join(workspaceDir, 'out', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const readmeContent = `# Datamine workspace — ${displayName}

Game slug: \`${args.slug}\`

## Versioned (kept in git)
- \`manifest.json\` — workspace metadata + coverage reports
- \`parsers/\` — game-specific parsers (only when no OSS parser exists)
- \`out/\` — the **portable output bundle** (the deliverable; see ../../docs/OUTPUT-CONTRACT.md)

## Gitignored (heavy, reproducible)
- \`zip-unpacked/\` — decompression of the source zip
- \`extracted/\` — tool output (raw assets + decompiled code)
- \`parsed/\` — structured JSON (parser output, pre-bundle)
- \`.tools/\` — per-game tool binaries

## Usage
Place the zip/installdir somewhere local (gitignored), then from Claude Code:
\`\`\`
/datamine ${args.slug}
\`\`\`
`;
  writeFileSync(path.join(workspaceDir, 'README.md'), readmeContent, 'utf8');

  console.log(`✓ Workspace created: ${workspaceDir}`);
  console.log(`  game_slug    : ${args.slug}`);
  console.log(`  display_name : ${displayName}`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Put the zip/installdir in a local (gitignored) folder`);
  console.log(`  2. From Claude Code: /datamine ${args.slug}`);
}

try {
  main();
} catch (err) {
  console.error('Unexpected error:', err.message);
  process.exit(99);
}
