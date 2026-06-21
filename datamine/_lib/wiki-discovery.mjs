/**
 * scripts/datamine/_lib/wiki-discovery.mjs
 * Phase 0.7 du skill /datamine — découverte des wikis publics qui répondent
 * pour un jeu donné, par test parallèle de plusieurs patterns d'URL.
 *
 * Ne fait PAS de scraping de contenu — retourne juste les URLs qui répondent
 * (status 200) et la recommandation pour le LLM (« utilise WebFetch sur la
 * meilleure URL avec ce prompt »).
 *
 * Usage :
 *   node scripts/datamine/_lib/wiki-discovery.mjs <slug>
 *   node scripts/datamine/_lib/wiki-discovery.mjs <slug> --name="Display Name"
 *   node scripts/datamine/_lib/wiki-discovery.mjs <slug> --json
 *
 * Patterns testés (par priorité décroissante) :
 *   1. <slug>.wiki.gg/wiki/Special:Categories     (wiki.gg = souvent officiel, ToS friendly)
 *   2. <slug>.wiki.gg/wiki/<DisplayName>           (page principale)
 *   3. <slug>.fandom.com/wiki/Special:Categories   (Fandom)
 *   4. <slug>.fandom.com/wiki/<DisplayName>        (page Fandom principale)
 *   5. www.pcgamingwiki.com/wiki/<DisplayName>     (PCGamingWiki)
 *   6. en.wikipedia.org/wiki/<DisplayName>         (Wikipedia)
 *
 * Exit codes :
 *   0 = au moins un wiki répond
 *   1 = erreur runtime
 *   2 = aucun wiki ne répond (le datamine continue sans wiki crossref)
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const TIMEOUT_MS = 8000;

function slugToWikiSlug(slug) {
  // "slay-the-spire-2" → "slay-the-spire-2" (kebab, lowercase, alphanum + hyphens only)
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function nameToWikiPath(name) {
  // "Slay the Spire 2" → "Slay_the_Spire_2"
  return name
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '');
}

async function testUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'datamine-tools (wiki/dle datamine bot)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    return { url, status: res.status, ok: res.ok, final_url: res.url };
  } catch (err) {
    return { url, status: 0, ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timeout);
  }
}

export async function discover(slug, displayName = null) {
  const wikiSlug = slugToWikiSlug(slug);
  const wikiName = nameToWikiPath(displayName ?? slug);

  const candidates = [
    { url: `https://${wikiSlug}.wiki.gg/wiki/Special:Categories`, type: 'wiki.gg', priority: 1, fetch_hint: 'liste des Categories Mediawiki' },
    { url: `https://${wikiSlug}.wiki.gg/wiki/${wikiName}`, type: 'wiki.gg-main', priority: 2, fetch_hint: 'page principale + sidebar de navigation' },
    { url: `https://${wikiSlug}.fandom.com/wiki/Special:Categories`, type: 'fandom', priority: 3, fetch_hint: 'liste des Categories Fandom' },
    { url: `https://${wikiSlug}.fandom.com/wiki/${wikiName}`, type: 'fandom-main', priority: 4, fetch_hint: 'page principale Fandom + portail catégories' },
    { url: `https://www.pcgamingwiki.com/wiki/${wikiName}`, type: 'pcgamingwiki', priority: 5, fetch_hint: 'fiche technique du jeu (engine, fixes)' },
    { url: `https://en.wikipedia.org/wiki/${wikiName}`, type: 'wikipedia', priority: 6, fetch_hint: 'overview + dev info, pas de catégories de contenu' },
  ];

  const tested = await Promise.all(
    candidates.map(async (c) => ({ ...c, ...(await testUrl(c.url)) }))
  );

  const ok = tested.filter((t) => t.ok).sort((a, b) => a.priority - b.priority);
  const best = ok[0] ?? null;

  const result = {
    slug,
    display_name: displayName,
    candidates_tested: tested.map(({ priority, fetch_hint, ...rest }) => ({ ...rest, priority, fetch_hint })),
    best: best ? { url: best.url, type: best.type, final_url: best.final_url, fetch_hint: best.fetch_hint } : null,
    next_step: best
      ? `WebFetch sur ${best.url} avec ce prompt : "Liste toutes les catégories de contenu de ce jeu listées sur cette page Mediawiki/wiki — items, monsters, characters, abilities, etc. Pour chaque catégorie, donne nom + URL de la page d'index si visible. Format JSON: [{name, url, count?}]."`
      : 'Aucun wiki ne répond. Continue Phase 1 sans wiki crossref. Marquer wiki_categories.json = {"categories": [], "note": "no wiki found"}',
  };
  return result;
}

function parseArgs(argv) {
  const args = { slug: null, name: null, json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a.startsWith('--name=')) args.name = a.slice('--name='.length);
    else if (a === '--name' && i + 1 < argv.length) args.name = argv[++i];
    else if (!args.slug && !a.startsWith('--')) args.slug = a;
  }
  return args;
}

function printHumanReport(r) {
  console.log('═'.repeat(70));
  console.log(` Wiki discovery — slug: ${r.slug}${r.display_name ? `  (${r.display_name})` : ''}`);
  console.log('═'.repeat(70));
  for (const c of r.candidates_tested) {
    const flag = c.ok ? '✓' : '✗';
    const status = c.error ? c.error : c.status;
    console.log(`  ${flag} [${c.type.padEnd(15)}] ${String(status).padStart(7)}  ${c.url}`);
  }
  console.log('');
  if (r.best) {
    console.log(` Meilleur candidat : ${r.best.type} → ${r.best.url}`);
    console.log(` Fetch hint        : ${r.best.fetch_hint}`);
    console.log('');
    console.log(` Next step :`);
    console.log(`   ${r.next_step}`);
  } else {
    console.log(` ⚠ Aucun wiki ne répond.`);
    console.log(`   ${r.next_step}`);
  }
  console.log('═'.repeat(70));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.slug) {
    console.error('Usage : node scripts/datamine/_lib/wiki-discovery.mjs <slug> [--name="Display Name"] [--json]');
    process.exit(1);
  }
  try {
    const r = await discover(args.slug, args.name);
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else printHumanReport(r);
    process.exit(r.best ? 0 : 2);
  } catch (err) {
    console.error(`Erreur : ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
