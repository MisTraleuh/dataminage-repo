/**
 * scripts/datamine/_lib/check-tools.mjs
 * Vérifie que les outils requis pour un engine donné sont installés.
 *
 * Usage :
 *   node scripts/datamine/_lib/check-tools.mjs <engine-id>
 *   node scripts/datamine/_lib/check-tools.mjs <engine-id> --json
 *
 * Exit codes :
 *   0 = tous les outils OK
 *   1 = au moins un outil manquant
 *   2 = engine inconnu
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, 'tool-registry.json');
const LOCAL_TOOLS_DIR = path.join(__dirname, '.tools');
const INSTALLED_PATH = path.join(__dirname, '.tools', 'installed.json');

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

function currentPlatformKey() {
  const platform = process.platform; // 'win32' | 'linux' | 'darwin'
  const arch = process.arch;          // 'x64' | 'arm64'
  return `${platform}-${arch}`;
}

/**
 * Vérifie qu'une commande système répond (PATH lookup).
 */
function commandIsAvailable(cmd, verifyArgs, verifyPattern) {
  const result = spawnSync(cmd, verifyArgs ?? ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.error || result.status === null) return { available: false, reason: 'not found in PATH' };
  if (result.status !== 0 && result.status !== 1) {
    // status=1 toléré : certains outils retournent 1 sur --help
    return { available: false, reason: `exited with ${result.status}` };
  }
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (verifyPattern && !new RegExp(verifyPattern).test(output)) {
    return { available: false, reason: 'verify_pattern mismatch', output: output.slice(0, 200) };
  }
  const versionMatch = output.match(/v?\d+\.\d+(?:\.\d+)?/);
  return { available: true, version: versionMatch?.[0] ?? 'unknown' };
}

/**
 * Vérifie qu'un binaire local (téléchargé dans .tools/) existe et répond.
 */
function localBinaryIsAvailable(toolId, platformConfig, verifyArgs, verifyPattern) {
  const binaryPath = path.join(LOCAL_TOOLS_DIR, toolId, platformConfig.binary ?? '');
  // Si pas de binary configuré (ex: tool en npm-global), on rend la main au caller
  if (!platformConfig.binary) return { available: false, reason: 'no local binary configured' };
  if (!existsSync(binaryPath)) {
    return { available: false, reason: `binary not found at ${binaryPath}` };
  }
  return commandIsAvailable(binaryPath, verifyArgs, verifyPattern);
}

/**
 * Vérifie qu'un dotnet tool est installé globalement.
 */
function dotnetToolIsAvailable(packageId, verifyArgs, verifyPattern) {
  // ilspycmd → directement dans le PATH après `dotnet tool install -g`
  return commandIsAvailable(packageId, verifyArgs, verifyPattern);
}

/**
 * Vérifie qu'un npm package global est installé.
 */
function npmGlobalIsAvailable(packageId, verifyArgs, verifyPattern) {
  // @electron/asar → fournit le binaire `asar`
  const cmdName = packageId.split('/').pop().replace(/^@.*?\//, '');
  return commandIsAvailable(cmdName, verifyArgs, verifyPattern);
}

/**
 * Vérifie un prérequis (ex: dotnet SDK pour ilspycmd).
 */
function checkPrerequisite(prereq) {
  if (prereq.type === 'command') {
    const result = commandIsAvailable(prereq.name, ['--version']);
    if (!result.available) {
      return { ok: false, message: `Prerequisite "${prereq.name}" missing. ${prereq.install_hint ?? ''}` };
    }
    return { ok: true, version: result.version };
  }
  return { ok: false, message: `Unknown prerequisite type: ${prereq.type}` };
}

function checkTool(toolId, registry) {
  const tool = registry.tools[toolId];
  if (!tool) {
    return { tool: toolId, ok: false, reason: 'not in registry' };
  }

  // Vérifier les prérequis avant tout
  for (const prereq of tool.prerequisites ?? []) {
    const check = checkPrerequisite(prereq);
    if (!check.ok) {
      return { tool: toolId, ok: false, reason: check.message, install_via: tool.install_via };
    }
  }

  switch (tool.install_via) {
    case 'github-release': {
      const platKey = currentPlatformKey();
      const platConfig = tool.platforms[platKey];
      if (!platConfig) {
        return { tool: toolId, ok: false, reason: `platform ${platKey} not supported` };
      }
      if (platConfig.fallback === 'manual') {
        return { tool: toolId, ok: false, reason: `manual install required: ${platConfig.manual_instructions}` };
      }
      const result = localBinaryIsAvailable(toolId, platConfig, tool.verify_command, tool.verify_pattern);
      return {
        tool: toolId,
        ok: result.available,
        reason: result.reason,
        version: result.version,
        install_via: tool.install_via,
        install_hint: result.available ? null : `node scripts/datamine/_lib/install-tool.mjs ${toolId}`,
      };
    }
    case 'dotnet-tool': {
      const result = dotnetToolIsAvailable(tool.package_id, tool.verify_command, tool.verify_pattern);
      return {
        tool: toolId,
        ok: result.available,
        reason: result.reason,
        version: result.version,
        install_via: tool.install_via,
        install_hint: result.available ? null : `dotnet tool install -g ${tool.package_id} --version ${tool.version_pin}`,
      };
    }
    case 'npm-global': {
      const result = npmGlobalIsAvailable(tool.package_id, tool.verify_command, tool.verify_pattern);
      return {
        tool: toolId,
        ok: result.available,
        reason: result.reason,
        version: result.version,
        install_via: tool.install_via,
        install_hint: result.available ? null : `npm install -g ${tool.package_id}@${tool.version_pin}`,
      };
    }
    default:
      return { tool: toolId, ok: false, reason: `unknown install_via: ${tool.install_via}` };
  }
}

export function checkEngine(engineId) {
  const registry = loadRegistry();
  const tools = registry.engines_to_tools[engineId];
  if (!tools) {
    return { engine: engineId, ok: false, error: 'engine not in registry', tools: [] };
  }
  if (tools.length === 0) {
    return { engine: engineId, ok: true, message: 'no tools required', tools: [] };
  }
  const results = tools.map((toolId) => checkTool(toolId, registry));
  const allOk = results.every((r) => r.ok);
  return { engine: engineId, ok: allOk, tools: results };
}

function parseArgs(argv) {
  const args = { engine: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') args.json = true;
    else if (!args.engine && !arg.startsWith('--')) args.engine = arg;
  }
  return args;
}

function printHumanReport(report) {
  console.log(`Vérification toolchain — engine: ${report.engine}`);
  console.log('');
  if (report.error) {
    console.error(`✗ ${report.error}`);
    return;
  }
  if (report.message === 'no tools required') {
    console.log(`  (aucun outil externe requis pour cet engine)`);
    return;
  }
  for (const t of report.tools) {
    const tick = t.ok ? '✓' : '✗';
    const versionStr = t.version ? ` (${t.version})` : '';
    console.log(`  ${tick} ${t.tool.padEnd(20)} via ${t.install_via}${versionStr}`);
    if (!t.ok) {
      console.log(`      Reason : ${t.reason}`);
      if (t.install_hint) {
        console.log(`      Install: ${t.install_hint}`);
      }
    }
  }
  console.log('');
  if (report.ok) {
    console.log('Tous les outils requis sont disponibles.');
  } else {
    console.log('⚠ Certains outils manquent. Lancer `node scripts/datamine/_lib/install-tool.mjs --engine ' + report.engine + '` ou suivre les hints ci-dessus.');
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.engine) {
    console.error('Usage : node scripts/datamine/_lib/check-tools.mjs <engine-id> [--json]');
    process.exit(2);
  }
  try {
    const report = checkEngine(args.engine);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report);
    }
    if (report.error) process.exit(2);
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    console.error(`Erreur : ${err.message}`);
    process.exit(99);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
