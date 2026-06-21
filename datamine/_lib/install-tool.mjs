/**
 * datamine/_lib/install-tool.mjs
 * Installe un outil de la matrice toolchain.
 *
 * Usage :
 *   node datamine/_lib/install-tool.mjs <tool-id>
 *   node datamine/_lib/install-tool.mjs --engine <engine-id>     # tous les outils d'un engine
 *   node datamine/_lib/install-tool.mjs <tool-id> --bootstrap-checksums  # accepte le 1er download sans SHA256, l'imprime
 *
 * Refuse de télécharger un binaire sans checksum SHA-256 référencé dans
 * tool-registry.json — sauf si --bootstrap-checksums (procédure 1ʳᵉ install
 * documentée dans datamine/_lib/README.md).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, createWriteStream, createReadStream, chmodSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, 'tool-registry.json');
const TOOLS_DIR = path.join(__dirname, '.tools');
const TOOLS_CACHE = path.join(__dirname, '.tools-cache');
const INSTALLED_PATH = path.join(TOOLS_DIR, 'installed.json');

function loadRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
}

function loadInstalled() {
  if (!existsSync(INSTALLED_PATH)) return {};
  try {
    return JSON.parse(readFileSync(INSTALLED_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveInstalled(state) {
  mkdirSync(TOOLS_DIR, { recursive: true });
  writeFileSync(INSTALLED_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function currentPlatformKey() {
  return `${process.platform}-${process.arch}`;
}

async function fetchGithubRelease(repo, tag) {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const headers = { 'User-Agent': 'datamine-tools-installer' };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${res.statusText} pour ${repo}@${tag}. Body: ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

async function downloadFile(url, destPath) {
  mkdirSync(path.dirname(destPath), { recursive: true });
  const res = await fetch(url, { headers: { 'User-Agent': 'datamine-tools-installer' }, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download ${res.status} ${res.statusText} : ${url}`);
  }
  const writer = createWriteStream(destPath);
  const reader = res.body.getReader();
  return new Promise(async (resolve, reject) => {
    writer.on('error', reject);
    writer.on('finish', resolve);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        writer.write(value);
      }
      writer.end();
    } catch (err) {
      writer.destroy(err);
      reject(err);
    }
  });
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function extractArchive(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const ext = path.extname(archivePath).toLowerCase();
  if (ext === '.zip') {
    const result = spawnSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`unzip a échoué pour ${archivePath}`);
    return;
  }
  if (ext === '.gz' || archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    const result = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`tar a échoué pour ${archivePath}`);
    return;
  }
  if (ext === '.exe' || ext === '.msi') {
    // Pas d'extraction — le fichier est l'installer lui-même
    throw new Error(`Setup .exe/.msi détecté (${archivePath}). Lancer manuellement et installer dans ${destDir}.`);
  }
  throw new Error(`Format d'archive non supporté : ${ext} (${archivePath})`);
}

async function installGithubRelease(toolId, tool, options) {
  const platKey = currentPlatformKey();
  const platConfig = tool.platforms[platKey];
  if (!platConfig) {
    throw new Error(`Plateforme ${platKey} non supportée pour ${toolId}`);
  }
  if (platConfig.fallback === 'manual') {
    console.log(`⚠ ${toolId} requiert une install manuelle sur ${platKey}.`);
    console.log(`   ${platConfig.manual_instructions}`);
    return { skipped: true, reason: 'manual install required' };
  }

  const release = await fetchGithubRelease(tool.github_repo, tool.release_pin);
  const assets = release.assets ?? [];
  const pattern = new RegExp('^' + platConfig.asset_pattern + '$');
  const asset = assets.find((a) => pattern.test(a.name));
  if (!asset) {
    throw new Error(`Aucun asset matchant ${platConfig.asset_pattern} dans ${tool.github_repo}@${tool.release_pin}. Assets: ${assets.map((a) => a.name).join(', ')}`);
  }

  mkdirSync(TOOLS_CACHE, { recursive: true });
  const cachedFile = path.join(TOOLS_CACHE, asset.name);
  if (!existsSync(cachedFile)) {
    console.log(`Téléchargement ${asset.name} (${(asset.size / (1024 * 1024)).toFixed(1)} MB)...`);
    await downloadFile(asset.browser_download_url, cachedFile);
  } else {
    console.log(`Utilise cache : ${cachedFile}`);
  }

  const actualSha = await sha256OfFile(cachedFile);
  if (!platConfig.sha256) {
    if (options.bootstrapChecksums) {
      console.log(`⚠ Checksum manquant pour ${toolId} sur ${platKey}.`);
      console.log(`   SHA-256 calculé : ${actualSha}`);
      console.log(`   Coller cette valeur dans tool-registry.json :`);
      console.log(`   tools.${toolId}.platforms["${platKey}"].sha256 = "${actualSha}"`);
      console.log(`   Puis re-lancer SANS --bootstrap-checksums.`);
      return { skipped: true, reason: 'checksum bootstrap', sha256: actualSha };
    }
    throw new Error(`SHA-256 manquant pour ${toolId}/${platKey} dans tool-registry.json. Re-lancer avec --bootstrap-checksums pour calculer et copier le hash.`);
  }
  if (actualSha.toLowerCase() !== platConfig.sha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch pour ${toolId}/${platKey} : attendu ${platConfig.sha256}, calculé ${actualSha}. Le binaire a peut-être été altéré ou la version GitHub Releases a changé.`);
  }

  const extractDir = path.join(__dirname, platConfig.extract_to);
  mkdirSync(extractDir, { recursive: true });
  const binaryPath = path.join(extractDir, platConfig.binary);

  if (platConfig.bare_binary) {
    // L'asset téléchargé EST le binaire final (pas une archive). Copier en place.
    console.log(`Copie binaire → ${binaryPath}`);
    copyFileSync(cachedFile, binaryPath);
  } else {
    console.log(`Extraction → ${extractDir}`);
    extractArchive(cachedFile, extractDir);
  }

  // Rendre le binaire exécutable sur Unix
  if (process.platform !== 'win32' && existsSync(binaryPath)) {
    try {
      chmodSync(binaryPath, 0o755);
    } catch {
      // Pas critique
    }
  }

  if (platConfig.post_install) {
    console.log(`ℹ Post-install : ${platConfig.post_install}`);
  }

  return {
    skipped: false,
    tool_id: toolId,
    version: release.tag_name,
    platform: platKey,
    sha256: actualSha,
    binary_path: binaryPath,
    installed_at: new Date().toISOString(),
  };
}

function installDotnetTool(toolId, tool) {
  const args = ['tool', 'install', '-g', tool.package_id, '--version', tool.version_pin];
  console.log(`Exécution : dotnet ${args.join(' ')}`);
  const result = spawnSync('dotnet', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    // Tool peut déjà être installé → tenter `update` sinon erreur
    const updateArgs = ['tool', 'update', '-g', tool.package_id, '--version', tool.version_pin];
    console.log(`Install a échoué (peut-être déjà installé). Tentative : dotnet ${updateArgs.join(' ')}`);
    const upd = spawnSync('dotnet', updateArgs, { stdio: 'inherit', shell: process.platform === 'win32' });
    if (upd.status !== 0) {
      throw new Error(`dotnet tool install/update a échoué pour ${tool.package_id}`);
    }
  }
  return {
    skipped: false,
    tool_id: toolId,
    version: tool.version_pin,
    install_via: 'dotnet-tool',
    installed_at: new Date().toISOString(),
  };
}

function installNpmGlobal(toolId, tool) {
  const args = ['install', '-g', `${tool.package_id}@${tool.version_pin}`];
  console.log(`Exécution : npm ${args.join(' ')}`);
  const result = spawnSync('npm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    throw new Error(`npm install a échoué pour ${tool.package_id}`);
  }
  return {
    skipped: false,
    tool_id: toolId,
    version: tool.version_pin,
    install_via: 'npm-global',
    installed_at: new Date().toISOString(),
  };
}

async function installTool(toolId, options = {}) {
  const registry = loadRegistry();
  const tool = registry.tools[toolId];
  if (!tool) {
    throw new Error(`Outil inconnu : ${toolId}. Voir tool-registry.json.`);
  }

  // Prérequis
  for (const prereq of tool.prerequisites ?? []) {
    if (prereq.type === 'command') {
      const result = spawnSync(prereq.name, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
      if (result.error || result.status !== 0) {
        throw new Error(`Prérequis manquant : ${prereq.name}. ${prereq.install_hint ?? ''}`);
      }
    }
  }

  let installResult;
  switch (tool.install_via) {
    case 'github-release':
      installResult = await installGithubRelease(toolId, tool, options);
      break;
    case 'dotnet-tool':
      installResult = installDotnetTool(toolId, tool);
      break;
    case 'npm-global':
      installResult = installNpmGlobal(toolId, tool);
      break;
    default:
      throw new Error(`install_via inconnu : ${tool.install_via}`);
  }

  if (!installResult.skipped) {
    const installed = loadInstalled();
    installed[toolId] = installResult;
    saveInstalled(installed);
    console.log(`✓ ${toolId} installé (${installResult.version ?? 'unknown version'})`);
  }
  return installResult;
}

async function installEngine(engineId, options = {}) {
  const registry = loadRegistry();
  const tools = registry.engines_to_tools[engineId];
  if (!tools) {
    throw new Error(`Engine inconnu : ${engineId}`);
  }
  if (tools.length === 0) {
    console.log(`Aucun outil requis pour ${engineId}.`);
    return [];
  }
  const results = [];
  for (const toolId of tools) {
    console.log(`\n--- ${toolId} ---`);
    try {
      results.push(await installTool(toolId, options));
    } catch (err) {
      console.error(`✗ Erreur sur ${toolId} : ${err.message}`);
      results.push({ tool_id: toolId, error: err.message });
    }
  }
  return results;
}

function parseArgs(argv) {
  const args = { toolId: null, engineId: null, bootstrapChecksums: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--engine') {
      args.engineId = argv[++i];
    } else if (arg === '--bootstrap-checksums') {
      args.bootstrapChecksums = true;
    } else if (!args.toolId && !arg.startsWith('--')) {
      args.toolId = arg;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.toolId && !args.engineId) {
    console.error('Usage :');
    console.error('  node datamine/_lib/install-tool.mjs <tool-id>');
    console.error('  node datamine/_lib/install-tool.mjs --engine <engine-id>');
    console.error('  node datamine/_lib/install-tool.mjs <tool-id> --bootstrap-checksums');
    process.exit(1);
  }
  try {
    if (args.engineId) {
      await installEngine(args.engineId, { bootstrapChecksums: args.bootstrapChecksums });
    } else {
      await installTool(args.toolId, { bootstrapChecksums: args.bootstrapChecksums });
    }
  } catch (err) {
    console.error(`Erreur : ${err.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { installTool, installEngine };
