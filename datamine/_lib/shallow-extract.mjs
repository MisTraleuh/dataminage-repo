/**
 * datamine/_lib/shallow-extract.mjs
 * Mode "always-works" — extraction par heuristiques génériques, fonctionne sur
 * n'importe quel zip ou installdir, indépendamment de l'engine.
 *
 * Sortie : <output-dir>/shallow_summary.json + sous-dossiers populated.
 *
 * Usage :
 *   node datamine/_lib/shallow-extract.mjs <game-slug>
 *   node datamine/_lib/shallow-extract.mjs <game-slug> --source=<path>
 *   node datamine/_lib/shallow-extract.mjs <game-slug> --max-strings-per-binary=20000
 *
 * Quand utilisé via le skill /datamine, <game-slug> doit avoir un workspace
 * initialisé (manifest.json présent) et zip-unpacked/ peuplé. Sinon utiliser
 * --source=<path> pour pointer un zip ou un dossier d'install.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tga'];
const CONFIG_EXT = ['.json', '.csv', '.xml', '.yaml', '.yml', '.toml', '.ini'];
const SCRIPT_EXT = ['.lua', '.gd', '.gml', '.js', '.ts', '.py'];
const TEXT_EXT = ['.txt', '.md'];
const BINARY_EXT = ['.exe', '.dll', '.so', '.dylib'];
const LOC_DIR_HINTS = ['loc', 'lang', 'locale', 'i18n', 'translation', 'translations'];

const DEFAULT_MAX_STRINGS_PER_BINARY = 20000;
const MIN_STRING_LEN = 8;
const MAX_FILES_SCAN = 500_000; // hard cap pour éviter une exécution infinie sur des installs immenses

function listFilesRecursive(rootDir) {
  const entries = [];
  const stack = [rootDir];
  while (stack.length > 0 && entries.length < MAX_FILES_SCAN) {
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
        try {
          const stat = statSync(full);
          entries.push({
            full_path: full,
            rel_path: path.relative(rootDir, full).replace(/\\/g, '/'),
            size: stat.size,
            mtime: stat.mtimeMs,
            ext: path.extname(full).toLowerCase(),
            basename: path.basename(full),
            dirname: path.dirname(full),
            rel_dirname: path.dirname(path.relative(rootDir, full)).replace(/\\/g, '/'),
          });
        } catch {
          // Skip fichiers inaccessibles (perms, broken symlinks)
        }
      }
    }
  }
  return entries;
}

/**
 * Lance `strings` sur un binaire et capture les résultats.
 * Retourne un tableau de strings (ASCII printable, longueur ≥ MIN_STRING_LEN).
 */
function extractStringsFromBinary(binaryPath, maxStrings) {
  // Préfère le binaire `strings` s'il est dispo (Linux/macOS/Git Bash). Sinon fallback Node.
  const stringsCmd = spawnSync('strings', ['-a', '-n', String(MIN_STRING_LEN), binaryPath], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (stringsCmd.status === 0 && stringsCmd.stdout) {
    return stringsCmd.stdout.split('\n').slice(0, maxStrings);
  }
  // Fallback : extraction Node (plus lente mais cross-plateforme)
  return extractStringsFromBinaryNode(binaryPath, maxStrings);
}

function extractStringsFromBinaryNode(binaryPath, maxStrings) {
  let buffer;
  try {
    buffer = readFileSync(binaryPath);
  } catch {
    return [];
  }
  const results = [];
  let current = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    // ASCII printable (0x20–0x7E) sauf 0x7F
    if (byte >= 0x20 && byte < 0x7f) {
      current.push(byte);
    } else {
      if (current.length >= MIN_STRING_LEN) {
        results.push(Buffer.from(current).toString('ascii'));
        if (results.length >= maxStrings) break;
      }
      current = [];
    }
  }
  if (current.length >= MIN_STRING_LEN && results.length < maxStrings) {
    results.push(Buffer.from(current).toString('ascii'));
  }
  return results;
}

/**
 * Tente de lire les dimensions d'une image PNG/JPEG/WebP.
 * Retourne { width, height } ou null si non identifiable.
 */
function readImageDimensions(filePath) {
  try {
    const fd = readFileSync(filePath, { encoding: null });
    const buf = Buffer.isBuffer(fd) ? fd : Buffer.from(fd);
    if (buf.length < 24) return null;
    // PNG : signature 89 50 4E 47, IHDR width/height aux offsets 16/20
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return { width, height, format: 'png' };
    }
    // JPEG : SOI 0xFFD8, parser les markers SOF0/SOF2
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset < buf.length - 9) {
        if (buf[offset] !== 0xff) break;
        const marker = buf[offset + 1];
        const segLen = buf.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = buf.readUInt16BE(offset + 5);
          const width = buf.readUInt16BE(offset + 7);
          return { width, height, format: 'jpeg' };
        }
        offset += 2 + segLen;
      }
    }
    // WebP : RIFF / WEBP
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8 ') {
        // Lossy
        const width = buf.readUInt16LE(26) & 0x3fff;
        const height = buf.readUInt16LE(28) & 0x3fff;
        return { width, height, format: 'webp' };
      }
      if (fourcc === 'VP8L') {
        const b0 = buf[21];
        const b1 = buf[22];
        const b2 = buf[23];
        const b3 = buf[24];
        const width = 1 + ((b1 & 0x3f) << 8 | b0);
        const height = 1 + ((b3 & 0x0f) << 10 | b2 << 2 | (b1 & 0xc0) >> 6);
        return { width, height, format: 'webp' };
      }
      if (fourcc === 'VP8X') {
        const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { width, height, format: 'webp' };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Heuristique : un fichier image dans un dossier `cards/` avec ratio plausible
 * d'une carte (entre 0.5 et 2.0) → c'est probablement une vraie entité, pas
 * un asset UI.
 */
function looksLikeEntityImage(file, dims) {
  if (!dims) return false;
  if (dims.width < 32 || dims.height < 32) return false;
  const ratio = dims.width / dims.height;
  if (ratio < 0.3 || ratio > 3.5) return false;
  return true;
}

function categorizeImagesByDirname(imageEntries) {
  const byDir = {};
  for (const img of imageEntries) {
    const dir = img.rel_dirname || '(root)';
    byDir[dir] = (byDir[dir] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(byDir)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
  );
}

function detectLocalizationDirs(allFiles) {
  const dirs = new Set();
  for (const file of allFiles) {
    const segments = file.rel_dirname.toLowerCase().split('/');
    for (const seg of segments) {
      if (LOC_DIR_HINTS.some((hint) => seg === hint || seg.startsWith(hint + '_') || seg.startsWith(hint + '-'))) {
        dirs.add(file.rel_dirname);
        break;
      }
    }
  }
  return [...dirs].sort();
}

/**
 * Devine les entités candidates à partir des dossiers d'images.
 * Pour chaque dossier qui ressemble à une catégorie d'entités (>= 5 images,
 * ratios plausibles), proposer un guess.
 */
function guessEntities(imageEntries, allFiles) {
  const ENTITY_DIR_HINTS = {
    cards: 'card',
    relics: 'relic',
    relic: 'relic',
    items: 'item',
    item: 'item',
    monsters: 'monster',
    enemies: 'monster',
    bosses: 'monster',
    characters: 'character',
    char: 'character',
    heroes: 'character',
    jokers: 'joker',
    cats: 'cat',
    weapons: 'weapon',
    powers: 'power',
    skills: 'skill',
    spells: 'spell',
    artifacts: 'artifact',
    runes: 'rune',
    potions: 'potion',
    enchantments: 'enchantment',
  };

  const buckets = {};
  for (const img of imageEntries) {
    const segments = img.rel_dirname.toLowerCase().split('/');
    for (const seg of segments) {
      const cat = ENTITY_DIR_HINTS[seg];
      if (cat) {
        buckets[cat] = buckets[cat] ?? { category: cat, source_dirs: new Set(), candidates: [] };
        buckets[cat].source_dirs.add(img.rel_dirname);
        const dims = readImageDimensions(img.full_path);
        if (looksLikeEntityImage(img, dims)) {
          const id = path.basename(img.basename, img.ext).toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
          buckets[cat].candidates.push({
            id,
            label: id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            image_rel_path: img.rel_path,
            dims,
          });
        }
        break; // 1 catégorie par image, pas de double-count
      }
    }
  }
  return Object.values(buckets).map((b) => ({
    category: b.category,
    source_dirs: [...b.source_dirs],
    candidates_count: b.candidates.length,
    candidates_sample: b.candidates.slice(0, 10),
    candidates: b.candidates,
  }));
}

function readJsonOrCsvHead(filePath, ext, maxBytes = 4 * 1024) {
  try {
    const stat = statSync(filePath);
    const size = Math.min(stat.size, maxBytes);
    const fd = readFileSync(filePath, { encoding: 'utf8', flag: 'r' }).slice(0, size);
    if (ext === '.json') {
      try {
        const parsed = JSON.parse(fd);
        if (Array.isArray(parsed)) return { kind: 'array', length: parsed.length };
        if (typeof parsed === 'object') return { kind: 'object', keys: Object.keys(parsed).slice(0, 20) };
        return { kind: 'scalar' };
      } catch {
        // peut-être tronqué — on tente sur le fichier complet si pas trop gros
        if (stat.size < 256 * 1024) {
          try {
            const full = JSON.parse(readFileSync(filePath, 'utf8'));
            if (Array.isArray(full)) return { kind: 'array', length: full.length };
            if (typeof full === 'object') return { kind: 'object', keys: Object.keys(full).slice(0, 20) };
          } catch {
            return { kind: 'unparseable' };
          }
        }
        return { kind: 'unparseable_or_truncated' };
      }
    }
    if (ext === '.csv') {
      const lines = fd.split('\n').slice(0, 3);
      return { kind: 'csv', headers: lines[0]?.split(',').map((h) => h.trim()).slice(0, 30) ?? [] };
    }
    return { kind: 'text', preview: fd.slice(0, 200) };
  } catch {
    return null;
  }
}

function bytesToMb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function workspaceFor(gameSlug) {
  const dir = path.join(REPO_ROOT, 'scripts', 'datamine', gameSlug);
  if (!existsSync(dir)) {
    throw new Error(`Workspace introuvable : ${dir}. Lancer init-workspace.mjs d'abord.`);
  }
  return dir;
}

function resolveSourceDir(gameSlug, sourceArg) {
  if (sourceArg) {
    const abs = path.isAbsolute(sourceArg) ? sourceArg : path.resolve(REPO_ROOT, sourceArg);
    if (!existsSync(abs)) {
      throw new Error(`Source path introuvable : ${abs}`);
    }
    return abs;
  }
  // Fallback : zip-unpacked du workspace
  const ws = workspaceFor(gameSlug);
  const unpacked = path.join(ws, 'zip-unpacked');
  if (!existsSync(unpacked) || readdirSync(unpacked).length === 0) {
    throw new Error(`zip-unpacked vide pour ${gameSlug}. Décompresser le zip d'abord ou utiliser --source=<path>.`);
  }
  return unpacked;
}

export function shallowExtract(gameSlug, options = {}) {
  const sourceDir = resolveSourceDir(gameSlug, options.source);
  const outDir = options.outputDir
    ? (path.isAbsolute(options.outputDir) ? options.outputDir : path.resolve(REPO_ROOT, options.outputDir))
    : path.join(workspaceFor(gameSlug), 'extracted');

  const rawDir = path.join(outDir, 'raw');
  const stringsDir = path.join(rawDir, 'strings');
  const configsDir = path.join(rawDir, 'configs');
  mkdirSync(stringsDir, { recursive: true });
  mkdirSync(configsDir, { recursive: true });

  console.log(`[shallow] Source     : ${sourceDir}`);
  console.log(`[shallow] Output     : ${outDir}`);
  console.log(`[shallow] Listing files…`);
  const allFiles = listFilesRecursive(sourceDir);
  console.log(`[shallow] Found ${allFiles.length} files`);

  const imageEntries = allFiles.filter((f) => IMAGE_EXT.includes(f.ext));
  const configEntries = allFiles.filter((f) => CONFIG_EXT.includes(f.ext));
  const scriptEntries = allFiles.filter((f) => SCRIPT_EXT.includes(f.ext));
  const textEntries = allFiles.filter((f) => TEXT_EXT.includes(f.ext));
  const binaryEntries = allFiles.filter((f) => BINARY_EXT.includes(f.ext));

  // Extraction de strings sur les binaires
  const maxStrings = options.maxStringsPerBinary ?? DEFAULT_MAX_STRINGS_PER_BINARY;
  const stringsExtracted = [];
  for (const bin of binaryEntries) {
    if (bin.size > 100 * 1024 * 1024) {
      console.log(`[shallow]   Skip ${bin.rel_path} (>100MB)`);
      continue;
    }
    const strings = extractStringsFromBinary(bin.full_path, maxStrings);
    const outPath = path.join(stringsDir, bin.basename.replace(/[^a-zA-Z0-9.-]/g, '_') + '.txt');
    writeFileSync(outPath, strings.join('\n'), 'utf8');
    stringsExtracted.push({ binary: bin.rel_path, strings_count: strings.length, output: path.relative(outDir, outPath) });
  }
  console.log(`[shallow] Extracted strings from ${binaryEntries.length} binaries`);

  // Copie des configs (small ones)
  const configsCopied = [];
  for (const cfg of configEntries) {
    if (cfg.size > 1 * 1024 * 1024) continue; // > 1 MB → skip
    const safeName = cfg.rel_path.replace(/[\\/]/g, '__');
    const dest = path.join(configsDir, safeName);
    try {
      copyFileSync(cfg.full_path, dest);
      const head = readJsonOrCsvHead(cfg.full_path, cfg.ext);
      configsCopied.push({ rel_path: cfg.rel_path, copied_to: path.relative(outDir, dest), head });
    } catch {
      // skip
    }
  }
  console.log(`[shallow] Copied ${configsCopied.length} config files`);

  // Catégorisation des images
  const imagesByDirname = categorizeImagesByDirname(imageEntries);
  console.log(`[shallow] Image dirs (top 5):`, Object.entries(imagesByDirname).slice(0, 5));

  // Localization dirs
  const locDirs = detectLocalizationDirs(allFiles);
  console.log(`[shallow] Localization dirs found: ${locDirs.length}`);

  // Guess entities
  console.log(`[shallow] Guessing entity categories…`);
  const entityGuesses = guessEntities(imageEntries, allFiles);
  for (const guess of entityGuesses) {
    console.log(`[shallow]   ${guess.category}: ${guess.candidates_count} candidates from ${guess.source_dirs.length} dirs`);
  }

  const summary = {
    game_slug: gameSlug,
    extracted_at: new Date().toISOString(),
    source_dir: sourceDir,
    output_dir: outDir,
    files_count: allFiles.length,
    binaries: {
      count: binaryEntries.length,
      total_size_mb: bytesToMb(binaryEntries.reduce((acc, b) => acc + b.size, 0)),
      strings_extracted: stringsExtracted,
    },
    images: {
      count: imageEntries.length,
      total_size_mb: bytesToMb(imageEntries.reduce((acc, i) => acc + i.size, 0)),
      by_dirname_top: imagesByDirname,
    },
    configs: {
      count: configEntries.length,
      copied: configsCopied,
    },
    scripts: {
      count: scriptEntries.length,
      by_ext: scriptEntries.reduce((acc, s) => {
        acc[s.ext] = (acc[s.ext] ?? 0) + 1;
        return acc;
      }, {}),
    },
    text_files: { count: textEntries.length },
    localization_dirs: locDirs,
    entity_guesses: entityGuesses,
  };

  const summaryPath = path.join(outDir, 'shallow_summary.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(`[shallow] Wrote ${summaryPath}`);

  return summary;
}

function parseArgs(argv) {
  const args = { gameSlug: null, source: null, maxStringsPerBinary: DEFAULT_MAX_STRINGS_PER_BINARY, outputDir: null };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--source=')) args.source = arg.slice('--source='.length);
    else if (arg.startsWith('--max-strings-per-binary=')) args.maxStringsPerBinary = parseInt(arg.slice('--max-strings-per-binary='.length), 10);
    else if (arg.startsWith('--output-dir=')) args.outputDir = arg.slice('--output-dir='.length);
    else if (!args.gameSlug && !arg.startsWith('--')) args.gameSlug = arg;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.gameSlug) {
    console.error('Usage : node datamine/_lib/shallow-extract.mjs <game-slug> [--source=<path>] [--max-strings-per-binary=N] [--output-dir=<path>]');
    process.exit(1);
  }
  try {
    const result = shallowExtract(args.gameSlug, {
      source: args.source,
      maxStringsPerBinary: args.maxStringsPerBinary,
      outputDir: args.outputDir,
    });
    console.log('');
    console.log('Résumé :');
    console.log(`  Files          : ${result.files_count}`);
    console.log(`  Binaries       : ${result.binaries.count} (${result.binaries.total_size_mb} MB)`);
    console.log(`  Images         : ${result.images.count} (${result.images.total_size_mb} MB)`);
    console.log(`  Configs        : ${result.configs.count}`);
    console.log(`  Localization   : ${result.localization_dirs.length} dirs`);
    console.log(`  Entity guesses : ${result.entity_guesses.length} categories`);
  } catch (err) {
    console.error(`Erreur : ${err.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
