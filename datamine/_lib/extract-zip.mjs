/**
 * datamine/_lib/extract-zip.mjs
 * Décompression universelle de zips de jeux. Gère :
 *  - ZIP standard (méthode 8 deflate, 0 stored)
 *  - ZIP avec Zstandard (méthode 93) — typique des zips AnkerGames récents
 *  - ZIP avec Deflate64 (méthode 9) — typique des zips créés avec WinRAR
 *
 * Stratégie multi-fallback :
 *   Plan A : `unzip` natif (Info-ZIP) — gère méthodes 0, 8, 12 (bzip2)
 *   Plan B : Python + lib `zstandard` avec monkey-patch `zipfile._get_decompressor`
 *            — gère méthode 93 (Zstd) qu'aucun unzip standard ne supporte
 *   Plan C : 7z si installé — gère tout
 *   Plan D : WinRAR si installé (Windows uniquement) — gère tout
 *
 * Usage :
 *   node extract-zip.mjs <zip> --probe                  # listing only, détecte les méthodes utilisées
 *   node extract-zip.mjs <zip> --out=<dir>              # extrait tout
 *   node extract-zip.mjs <zip> --out=<dir> --pattern="A/*.pck" --pattern="A/data/*.dll"
 *
 * Exit codes :
 *   0 = succès
 *   1 = erreur runtime (zip absent, etc.)
 *   2 = aucun extracteur dispo pour la(les) méthode(s) du zip
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────────────────────────────
// ZIP Compression Methods (PKWARE APPNOTE 6.3.10)
// ──────────────────────────────────────────────────────────────────────────────

const COMPRESSION_METHODS = {
  0: 'stored',
  8: 'deflate',
  9: 'deflate64',
  12: 'bzip2',
  14: 'lzma',
  93: 'zstandard',
  95: 'xz',
  98: 'ppmd',
};

const NATIVE_UNZIP_SUPPORTS = new Set([0, 8, 12]); // Info-ZIP unzip
const PYTHON_ZIPFILE_SUPPORTS = new Set([0, 8, 12, 14]); // Python 3.13 stdlib
const PYTHON_WITH_ZSTD_SUPPORTS = new Set([0, 8, 12, 14, 93]); // + zstandard pkg

// ──────────────────────────────────────────────────────────────────────────────
// Probing — lecture du Central Directory pour découvrir les méthodes utilisées
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Lit `length` octets à la position `position` dans le fd, avec boucle pour
 * gérer les cas où readSync retourne moins que demandé (fichiers > 2 GiB).
 */
function readRange(fd, position, length) {
  const buf = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const n = readSync(fd, buf, total, length - total, position + total);
    if (n === 0) throw new Error(`Lecture interrompue à offset ${position + total} (attendu ${length}, lu ${total})`);
    total += n;
  }
  return buf;
}

/**
 * Lit le central directory du zip pour extraire la liste des entries.
 * N'extrait pas les données — juste les métadonnées.
 * Supporte ZIP64 (zips > 4 GB) ET les fichiers > 2 GiB (lit par régions
 * avec openSync/readSync, jamais le fichier entier — sinon Node plafonne
 * readFileSync à kIoMaxLength = 2 GiB - 1).
 *
 * Retourne : { entries: [{ name, size, compressedSize, method }], totalEntries, zipSize }
 */
function probeZip(zipPath) {
  const stat = statSync(zipPath);
  const fileSize = stat.size;
  if (fileSize < 22) throw new Error('zip trop petit pour être valide');

  const fd = openSync(zipPath, 'r');
  try {
    // 1. Lire la queue pour localiser EOCD (signature 0x06054b50)
    //    Max 65557 octets : 65535 (max comment) + 22 (EOCD fixe).
    const tailSize = Math.min(fileSize, 65557);
    const tail = readRange(fd, fileSize - tailSize, tailSize);
    let eocdOffset = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) throw new Error('EOCD signature introuvable — zip corrompu ou non standard');

    let totalEntries = tail.readUInt16LE(eocdOffset + 10);
    let cdSize = tail.readUInt32LE(eocdOffset + 12);
    let cdOffset = tail.readUInt32LE(eocdOffset + 16);

    // ZIP64 : valeurs sentinel 0xFFFFFFFF/0xFFFF → lire EOCD64
    if (cdOffset === 0xffffffff || totalEntries === 0xffff || cdSize === 0xffffffff) {
      // Chercher Zip64 EOCD Locator (signature 0x07064b50, 20 octets avant EOCD)
      const locOffset = eocdOffset - 20;
      if (locOffset < 0 || tail.readUInt32LE(locOffset) !== 0x07064b50) {
        throw new Error('ZIP64 sentinel détecté mais EOCD64 Locator introuvable');
      }
      const eocd64Offset = Number(tail.readBigUInt64LE(locOffset + 8));
      // EOCD64 record fixe = 56 octets (signature 4 + size 8 + version 2+2 + disk 4+4 + entries 8+8 + cd size 8 + cd offset 8 + extensible)
      const eocd64 = readRange(fd, eocd64Offset, 56);
      if (eocd64.readUInt32LE(0) !== 0x06064b50) {
        throw new Error('Signature EOCD64 invalide');
      }
      totalEntries = Number(eocd64.readBigUInt64LE(32));
      cdSize = Number(eocd64.readBigUInt64LE(40));
      cdOffset = Number(eocd64.readBigUInt64LE(48));
    }

    // 2. Lire le Central Directory entier (taille bornée par cdSize)
    if (cdSize > 1_500_000_000) {
      throw new Error(`Central Directory trop gros (${cdSize} octets) — non supporté par cette implémentation`);
    }
    const cd = readRange(fd, cdOffset, cdSize);

    const entries = [];
    let pos = 0;
    for (let i = 0; i < totalEntries; i += 1) {
      if (cd.readUInt32LE(pos) !== 0x02014b50) {
        throw new Error(`CD entry signature invalide à offset ${pos} (entry ${i})`);
      }
      const method = cd.readUInt16LE(pos + 10);
      let compressedSize = cd.readUInt32LE(pos + 20);
      let size = cd.readUInt32LE(pos + 24);
      const nameLen = cd.readUInt16LE(pos + 28);
      const extraLen = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      const name = cd.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');

      // ZIP64 extra field : si size/compressedSize sont 0xFFFFFFFF, chercher dans extra
      if (size === 0xffffffff || compressedSize === 0xffffffff) {
        let extraPos = pos + 46 + nameLen;
        const extraEnd = extraPos + extraLen;
        while (extraPos < extraEnd - 4) {
          const headerId = cd.readUInt16LE(extraPos);
          const dataSize = cd.readUInt16LE(extraPos + 2);
          if (headerId === 0x0001) {
            let dpos = extraPos + 4;
            if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(dpos)); dpos += 8; }
            if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(dpos)); dpos += 8; }
            break;
          }
          extraPos += 4 + dataSize;
        }
      }

      entries.push({ name, size, compressedSize, method, methodName: COMPRESSION_METHODS[method] ?? `unknown(${method})` });
      pos += 46 + nameLen + extraLen + commentLen;
    }

    const methodCounts = {};
    for (const e of entries) {
      methodCounts[e.method] = (methodCounts[e.method] ?? 0) + 1;
    }

    return { entries, totalEntries, zipSize: fileSize, methodCounts };
  } finally {
    closeSync(fd);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Extracteurs — chacun gère un sous-set de méthodes
// ──────────────────────────────────────────────────────────────────────────────

function detectAvailableExtractors() {
  const available = [];

  // Plan A : unzip natif
  const unzipCheck = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
  if (unzipCheck.status === 0 || (unzipCheck.stdout ?? '').includes('UnZip')) {
    available.push({ id: 'unzip', supports: NATIVE_UNZIP_SUPPORTS });
  }

  // Plan B : Python avec zstandard
  const pyCheck = spawnSync('python3', ['-c', 'import zstandard; print("ok")'], { encoding: 'utf8' });
  if (pyCheck.status === 0 && (pyCheck.stdout ?? '').includes('ok')) {
    available.push({ id: 'python-zstd', supports: PYTHON_WITH_ZSTD_SUPPORTS });
  } else {
    // Python sans zstandard → fallback subset
    const pyOnly = spawnSync('python3', ['-c', 'import zipfile; print("ok")'], { encoding: 'utf8' });
    if (pyOnly.status === 0) {
      available.push({ id: 'python', supports: PYTHON_ZIPFILE_SUPPORTS });
    }
  }

  // Plan C : 7z
  for (const cmd of ['7z', '7za', '/c/Program Files/7-Zip/7z.exe']) {
    const r = spawnSync(cmd, ['--help'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (r.status === 0 || (r.stdout ?? '').includes('7-Zip')) {
      available.push({ id: '7z', cmd, supports: new Set([0, 8, 9, 12, 14, 93, 95, 98]) });
      break;
    }
  }

  // Plan D : WinRAR (Windows)
  if (process.platform === 'win32') {
    const winrar = 'C:\\Program Files\\WinRAR\\WinRAR.exe';
    if (existsSync(winrar)) {
      available.push({ id: 'winrar', cmd: winrar, supports: new Set([0, 8, 9, 12, 14, 93, 95]) });
    }
  }

  return available;
}

/**
 * Choisit le meilleur extracteur pour un set de méthodes données.
 */
function pickExtractor(methodsUsed, available) {
  // Préférence : unzip > python-zstd > python > 7z > winrar
  // (unzip = rapide ; python-zstd = portable ; 7z = exhaustif ; winrar = dernier recours)
  const priority = ['unzip', 'python-zstd', 'python', '7z', 'winrar'];
  for (const id of priority) {
    const ext = available.find((a) => a.id === id);
    if (!ext) continue;
    const allSupported = methodsUsed.every((m) => ext.supports.has(m));
    if (allSupported) return ext;
  }
  return null;
}

/**
 * Convertit un array de patterns glob basique en regex.
 */
function patternsToRegex(patterns) {
  if (!patterns || patterns.length === 0) return null;
  const regexes = patterns.map((p) => {
    let r = '';
    for (let i = 0; i < p.length; i += 1) {
      const c = p[i];
      if (c === '*' && p[i + 1] === '*') { r += '.*'; i += 1; }
      else if (c === '*') r += '[^/]*';
      else if (c === '?') r += '[^/]';
      else if ('.+?^${}()|[]\\'.includes(c)) r += '\\' + c;
      else r += c;
    }
    return new RegExp('^' + r + '$');
  });
  return (filename) => regexes.some((re) => re.test(filename));
}

// ──────────────────────────────────────────────────────────────────────────────
// Implémentation des extracteurs
// ──────────────────────────────────────────────────────────────────────────────

function extractWithUnzip(zipPath, outDir, patterns) {
  mkdirSync(outDir, { recursive: true });
  const args = ['-o', zipPath];
  if (patterns && patterns.length > 0) args.push(...patterns);
  args.push('-d', outDir);
  const result = spawnSync('unzip', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`unzip failed (status ${result.status})`);
}

function extractWithPython(zipPath, outDir, patterns, useZstd) {
  mkdirSync(outDir, { recursive: true });
  const patternsList = patterns && patterns.length > 0 ? JSON.stringify(patterns) : 'null';
  const zstdImports = useZstd ? `
import zipfile, zstandard

class _ZstdDecompressor:
    def __init__(self):
        self._dctx = zstandard.ZstdDecompressor()
        self._dobj = self._dctx.decompressobj()
        self.eof = False
        self.unconsumed_tail = b""
        self.unused_data = b""
    def decompress(self, data, max_length=-1):
        return self._dobj.decompress(data) if max_length < 0 else self._dobj.decompress(data, max_output_size=max_length)
    def flush(self):
        return b""

ZIP_ZSTD = 93
_orig_check = zipfile._check_compression
def _patched_check(t):
    if t == ZIP_ZSTD: return
    return _orig_check(t)
zipfile._check_compression = _patched_check
_orig_get = zipfile._get_decompressor
def _patched_get(t):
    if t == ZIP_ZSTD: return _ZstdDecompressor()
    return _orig_get(t)
zipfile._get_decompressor = _patched_get
` : 'import zipfile';

  const script = `
import sys, json, fnmatch
${zstdImports}
from pathlib import Path

zip_path = sys.argv[1]
out_dir = Path(sys.argv[2])
patterns = json.loads(sys.argv[3])
out_dir.mkdir(parents=True, exist_ok=True)

def matches(name):
    if not patterns:
        return True
    for p in patterns:
        if fnmatch.fnmatch(name, p):
            return True
    return False

extracted = 0
with zipfile.ZipFile(zip_path, "r") as zf:
    for info in zf.infolist():
        if info.is_dir():
            continue
        if not matches(info.filename):
            continue
        zf.extract(info, out_dir)
        extracted += 1
print(f"[python-extract] extracted {extracted} files")
`;

  const result = spawnSync('python3', ['-c', script, zipPath, outDir, patternsList], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`python extract failed (status ${result.status})`);
}

function extractWith7z(cmd, zipPath, outDir, patterns) {
  mkdirSync(outDir, { recursive: true });
  const args = ['x', '-y', `-o${outDir}`, zipPath];
  if (patterns && patterns.length > 0) args.push(...patterns);
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`7z failed (status ${result.status})`);
}

function extractWithWinrar(cmd, zipPath, outDir, patterns) {
  mkdirSync(outDir, { recursive: true });
  // WinRAR x: extract with full paths, -inul: silent, -y: yes to all
  const args = ['x', '-inul', '-y', zipPath];
  if (patterns && patterns.length > 0) args.push(...patterns);
  args.push(outDir + path.sep);
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`WinRAR failed (status ${result.status})`);
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { zipPath: null, out: null, patterns: [], probe: false, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--probe') args.probe = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg.startsWith('--pattern=')) args.patterns.push(arg.slice('--pattern='.length));
    else if (!args.zipPath && !arg.startsWith('--')) args.zipPath = arg;
  }
  return args;
}

function printProbeReport(probe, available, picker) {
  console.log(`Zip probe — ${probe.zipSize / (1024 * 1024) >= 100 ? (probe.zipSize / (1024 * 1024 * 1024)).toFixed(2) + ' GB' : (probe.zipSize / (1024 * 1024)).toFixed(1) + ' MB'}`);
  console.log(`  Total entries : ${probe.totalEntries}`);
  console.log(`  Methods used  :`);
  for (const [method, count] of Object.entries(probe.methodCounts)) {
    const m = parseInt(method, 10);
    const name = COMPRESSION_METHODS[m] ?? `unknown(${m})`;
    console.log(`    [${String(m).padStart(2)}] ${name.padEnd(12)} : ${count} entries`);
  }
  console.log('');
  console.log(`Extractors available :`);
  for (const ext of available) {
    console.log(`  ✓ ${ext.id.padEnd(15)} supports methods [${[...ext.supports].sort((a, b) => a - b).join(',')}]`);
  }
  console.log('');
  if (picker) {
    console.log(`Recommended extractor : ${picker.id}`);
  } else {
    const methodsUsed = Object.keys(probe.methodCounts).map((m) => parseInt(m, 10));
    console.log(`⚠ Aucun extracteur dispo ne couvre toutes les méthodes utilisées (${methodsUsed.join(',')})`);
    console.log(`   Solutions :`);
    if (methodsUsed.includes(93)) {
      console.log(`     - méthode 93 (Zstandard) : pip install --user zstandard puis re-tester`);
    }
    if (methodsUsed.includes(9)) {
      console.log(`     - méthode 9 (Deflate64) : installer 7-Zip ou WinRAR`);
    }
  }
}

export function probe(zipPath) {
  const probeResult = probeZip(zipPath);
  const available = detectAvailableExtractors();
  const methodsUsed = Object.keys(probeResult.methodCounts).map((m) => parseInt(m, 10));
  const picker = pickExtractor(methodsUsed, available);
  return { probe: probeResult, available, picker, methodsUsed };
}

export function extract(zipPath, outDir, patterns) {
  if (!existsSync(zipPath)) throw new Error(`Zip introuvable : ${zipPath}`);
  const { probe: probeResult, available, picker, methodsUsed } = probe(zipPath);

  if (!picker) {
    throw new Error(`Aucun extracteur dispo ne couvre les méthodes [${methodsUsed.join(',')}]. Voir --probe pour le détail.`);
  }

  console.log(`[extract-zip] Méthodes utilisées : ${methodsUsed.join(',')}`);
  console.log(`[extract-zip] Extracteur choisi   : ${picker.id}`);

  switch (picker.id) {
    case 'unzip':
      return extractWithUnzip(zipPath, outDir, patterns);
    case 'python':
      return extractWithPython(zipPath, outDir, patterns, false);
    case 'python-zstd':
      return extractWithPython(zipPath, outDir, patterns, true);
    case '7z':
      return extractWith7z(picker.cmd, zipPath, outDir, patterns);
    case 'winrar':
      return extractWithWinrar(picker.cmd, zipPath, outDir, patterns);
    default:
      throw new Error(`Extracteur ${picker.id} non implémenté`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.zipPath) {
    console.error('Usage :');
    console.error('  node extract-zip.mjs <zip> --probe                          # listing + détection méthodes');
    console.error('  node extract-zip.mjs <zip> --out=<dir>                      # extraction complète');
    console.error('  node extract-zip.mjs <zip> --out=<dir> --pattern="A/*.pck"  # extraction sélective');
    process.exit(1);
  }
  if (!existsSync(args.zipPath)) {
    console.error(`Zip introuvable : ${args.zipPath}`);
    process.exit(1);
  }

  try {
    const { probe: probeResult, available, picker, methodsUsed } = probe(args.zipPath);

    if (args.probe) {
      if (args.json) {
        console.log(JSON.stringify({
          zip_path: args.zipPath,
          zip_size: probeResult.zipSize,
          total_entries: probeResult.totalEntries,
          methods: probeResult.methodCounts,
          extractors_available: available.map((a) => ({ id: a.id, supports: [...a.supports] })),
          extractor_recommended: picker?.id ?? null,
          can_extract: !!picker,
        }, null, 2));
      } else {
        printProbeReport(probeResult, available, picker);
      }
      process.exit(picker ? 0 : 2);
    }

    if (!args.out) {
      console.error('--out=<dir> requis pour extraire (ou --probe pour juste lister)');
      process.exit(1);
    }

    extract(args.zipPath, args.out, args.patterns);
    console.log(`[extract-zip] OK → ${args.out}`);
  } catch (err) {
    console.error(`Erreur : ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
