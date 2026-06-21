/**
 * datamine/_lib/wiki-categories-fetch.mjs
 * Phase 0.7 du skill /datamine — extraction automatique des catégories Mediawiki.
 *
 * Prend un slug de jeu, trouve son wiki via wiki-discovery.mjs (ou --url=),
 * fetch Special:Categories avec pagination, parse les catégories, et écrit
 * datamine/<slug>/wiki_categories.json.
 *
 * ToS : ne fetch que Special:Categories (max 5 pages), jamais les pages
 * individuelles d'entités. Equivalent à un humain qui ouvre la page dans un
 * navigateur pour comprendre la structure du wiki.
 *
 * Usage :
 *   node datamine/_lib/wiki-categories-fetch.mjs <slug>
 *   node datamine/_lib/wiki-categories-fetch.mjs <slug> --name="Display Name"
 *   node datamine/_lib/wiki-categories-fetch.mjs <slug> --url=https://... (bypass discovery)
 *   node datamine/_lib/wiki-categories-fetch.mjs <slug> --json
 *
 * Exit codes :
 *   0 = wiki trouvé + JSON écrit
 *   1 = erreur runtime
 *   2 = aucun wiki ne répond
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { discover } from './wiki-discovery.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATAMINE_ROOT = path.resolve(__dirname, '..');
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGES = 5;
const USER_AGENT = 'datamine-tools (wiki/dle datamine bot)';

// Catégories Mediawiki meta à exclure (maintenance, pas du contenu de jeu)
const META_CATEGORY_PATTERNS = [
  /^stub/i, /stub$/i, /^articles?$/i, /^pages?$/i,
  /^delete/i, /^cleanup/i, /^maintenance/i, /^templates?/i,
  /^files?$/i, /^images?$/i, /^categories$/i,
  /^help/i, /^user/i, /^talk/i, /^wikipedia/i,
  /^featured/i, /^candidates/i, /^redirects?$/i,
  /^wikia/i, /^fandom/i, /^community/i,
];

function isMetaCategory(name) {
  return META_CATEGORY_PATTERNS.some((re) => re.test(name));
}

// ──────────────────────────────────────────────────────────────────────────────
// URL helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Dérive l'URL Special:Categories depuis n'importe quelle URL wiki.
 * Ex: https://mewgenics.wiki.gg/wiki/Mewgenics → https://mewgenics.wiki.gg/wiki/Special:Categories
 */
function deriveSpecialCategoriesUrl(wikiUrl) {
  if (/\/Special:Categories/i.test(wikiUrl)) return wikiUrl;
  try {
    const parsed = new URL(wikiUrl);
    // Remplace le segment de page par Special:Categories dans /wiki/<page>
    const newPath = parsed.pathname.replace(/\/wiki\/[^/]+$/, '/wiki/Special:Categories');
    if (newPath === parsed.pathname) return null;
    return `${parsed.origin}${newPath}`;
  } catch {
    return null;
  }
}

function getOrigin(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function resolveHref(href, baseUrl) {
  if (href.startsWith('http')) return href;
  const origin = getOrigin(baseUrl);
  return origin ? `${origin}${href}` : href;
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP fetch
// ──────────────────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return { html: null, finalUrl: url, error: `HTTP ${res.status} ${res.statusText}` };
    return { html: await res.text(), finalUrl: res.url, error: null };
  } catch (err) {
    return { html: null, finalUrl: url, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timeout);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// HTML parsing — Mediawiki Special:Categories
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Parse le HTML d'une page Special:Categories Mediawiki.
 * Retourne les catégories trouvées sur cette page.
 *
 * Structures Mediawiki gérées :
 *   wiki.gg : <li><bdi dir="ltr"><a href="/wiki/Category:Items">Items</a></bdi> (1,134 members)</li>
 *   Fandom  : <li><a href="/wiki/Category:Items" title="...">Items</a>&#160;(1,134)</li>
 *   Classic : <li><a href="/wiki/Category:Items">Items</a> (1134)</li>
 */
function parseMediawikiCategories(html, baseUrl) {
  const categories = [];
  // Capture : href, nom URL, texte affiché, texte trailing (closing tags + count)
  // (?:<\/[^>]+>)* gère les tags fermants entre </a> et le count (ex: </bdi>)
  const catRe = /href="([^"]*\/wiki\/Category:([^"#?]+))"[^>]*>([^<]+)<\/a>(?:<\/[^>]+>)*([^<\n]*)/g;
  let m;
  while ((m = catRe.exec(html)) !== null) {
    const href = m[1];
    const rawName = decodeURIComponent(m[2].replace(/_/g, ' ')).trim();
    const displayName = m[3].trim();
    const trailing = m[4];

    const name = displayName || rawName;
    if (!name || isMetaCategory(name)) continue;

    // Count — formats gérés :
    //   (1,134 members)  — wiki.gg
    //   &#160;(1,134)    — Fandom / Mediawiki standard
    //   (760)            — simple
    let count = null;
    const countMatch = trailing.match(/\((\d[\d,\s]*)(?:\s*members?)?\)/i);
    if (countMatch) {
      count = parseInt(countMatch[1].replace(/[,\s]/g, ''), 10);
      if (isNaN(count)) count = null;
    }

    categories.push({
      name,
      url: resolveHref(href, baseUrl),
      count,
    });
  }
  return categories;
}

/**
 * Cherche l'URL de la page suivante dans une page Special:Categories.
 * Maintient un Set des URLs déjà visitées pour éviter les boucles.
 */
function findNextPageUrl(html, baseUrl, visitedUrls) {
  // Match les liens avec Special:Categories + from= pas encore visités
  const re = /href="(\/wiki\/Special:Categories[^"]*[?&]from=[^"&]+[^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].replace(/&amp;/g, '&');
    const fullUrl = resolveHref(href, baseUrl);
    if (!visitedUrls.has(fullUrl)) return fullUrl;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Heading inference — pcgamingwiki / wikipedia (fallback)
// ──────────────────────────────────────────────────────────────────────────────

const HEADING_SKIP = new Set([
  'contents', 'navigation', 'see also', 'references', 'external links',
  'notes', 'gallery', 'trivia', 'reception', 'development', 'description',
  'synopsis', 'plot', 'gameplay', 'overview', 'history', 'background',
  'community', 'media', 'soundtrack', 'legacy', 'cancellation',
]);

function inferCategoriesFromHeadings(html) {
  const categories = [];
  const seen = new Set();
  const re = /<h[23][^>]*>(?:<[^>]+>)*([^<]+?)(?:<[^>]+>)*<\/h[23]>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = m[1].replace(/\[.*?\]/g, '').trim(); // strip [edit] links
    if (!text || text.length < 2 || text.length > 80) continue;
    const key = text.toLowerCase();
    if (HEADING_SKIP.has(key) || seen.has(key)) continue;
    seen.add(key);
    categories.push({ name: text, url: null, count: null });
  }
  return categories;
}

// ──────────────────────────────────────────────────────────────────────────────
// Détection du type de source depuis une URL arbitraire
// ──────────────────────────────────────────────────────────────────────────────

function detectSourceType(url) {
  if (url.includes('wiki.gg')) return 'wiki.gg';
  if (url.includes('fandom.com')) return 'fandom';
  if (url.includes('pcgamingwiki.com')) return 'pcgamingwiki';
  if (url.includes('wikipedia.org')) return 'wikipedia';
  return 'custom';
}

// ──────────────────────────────────────────────────────────────────────────────
// Point d'entrée exporté
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Récupère et parse les catégories du wiki pour un jeu.
 * Écrit le résultat dans datamine/<slug>/wiki_categories.json.
 *
 * @param {string} slug - game slug (kebab-case)
 * @param {string|null} displayName - nom lisible du jeu (optionnel)
 * @param {{ url?: string }} options - url override (bypass discovery)
 */
export async function fetchCategories(slug, displayName = null, options = {}) {
  let sourceUrl, sourceType, sourceQuality;

  if (options.url) {
    // Override : utiliser l'URL fournie directement
    sourceType = detectSourceType(options.url);
    sourceQuality = 'authoritative';
    // Normaliser vers Special:Categories si c'est une URL de page principale
    const derived = deriveSpecialCategoriesUrl(options.url);
    sourceUrl = derived ?? options.url;
  } else {
    const discovery = await discover(slug, displayName);

    if (!discovery.best) {
      return {
        slug,
        source_url: null,
        source_type: null,
        source_quality: null,
        categories: [],
        note: 'no wiki found',
        fetched_at: new Date().toISOString(),
      };
    }

    const best = discovery.best;
    sourceType = best.type.replace('-main', ''); // normalise wiki.gg-main → wiki.gg

    const isMediawikiDirect = best.type === 'wiki.gg' || best.type === 'fandom';
    const isMediawikiMain = best.type === 'wiki.gg-main' || best.type === 'fandom-main';

    if (isMediawikiDirect) {
      // L'URL pointe déjà vers Special:Categories
      sourceUrl = best.final_url ?? best.url;
      sourceQuality = 'authoritative';
    } else if (isMediawikiMain) {
      // Dériver Special:Categories depuis la page principale
      const derived = deriveSpecialCategoriesUrl(best.final_url ?? best.url);
      sourceUrl = derived ?? (best.final_url ?? best.url);
      sourceQuality = derived ? 'authoritative' : 'inferred';
    } else {
      // pcgamingwiki / wikipedia → inférence par headings
      sourceUrl = best.final_url ?? best.url;
      sourceQuality = 'inferred';
    }
  }

  const isMediawiki = sourceType === 'wiki.gg' || sourceType === 'fandom';
  let allCategories = [];

  if (isMediawiki && sourceQuality !== 'inferred') {
    // Fetch paginé de Special:Categories
    const visitedUrls = new Set();
    let currentUrl = sourceUrl;
    let pagesFetched = 0;

    while (currentUrl && pagesFetched < MAX_PAGES) {
      visitedUrls.add(currentUrl);
      const { html, finalUrl, error } = await fetchHtml(currentUrl);
      pagesFetched++;

      if (error || !html) break;

      const pageCats = parseMediawikiCategories(html, finalUrl);
      allCategories.push(...pageCats);

      const nextUrl = findNextPageUrl(html, finalUrl, visitedUrls);
      currentUrl = nextUrl;
    }

    // Dédoublonner par nom (peut arriver sur navigation/breadcrumbs)
    const seen = new Set();
    allCategories = allCategories.filter((c) => {
      if (seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    });
  } else {
    // Inférence par headings (pcgamingwiki, wikipedia, fallback)
    const { html, error } = await fetchHtml(sourceUrl);
    if (!error && html) {
      allCategories = inferCategoriesFromHeadings(html);
    }
  }

  // Écrire wiki_categories.json dans le workspace du jeu
  const workspaceDir = path.join(DATAMINE_ROOT, slug);
  mkdirSync(workspaceDir, { recursive: true });
  const outPath = path.join(workspaceDir, 'wiki_categories.json');

  const result = {
    slug,
    source_url: sourceUrl,
    source_type: sourceType,
    source_quality: sourceQuality,
    categories: allCategories,
    note: allCategories.length === 0 ? 'no categories found' : null,
    fetched_at: new Date().toISOString(),
  };

  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { slug: null, name: null, url: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a.startsWith('--name=')) args.name = a.slice('--name='.length).replace(/^["']|["']$/g, '');
    else if (a === '--name' && i + 1 < argv.length) args.name = argv[++i].replace(/^["']|["']$/g, '');
    else if (a.startsWith('--url=')) args.url = a.slice('--url='.length).replace(/^["']|["']$/g, '');
    else if (!args.slug && !a.startsWith('--')) args.slug = a;
  }
  return args;
}

function printHumanReport(r) {
  const W = 70;
  console.log('═'.repeat(W));
  console.log(` Wiki categories — slug: ${r.slug}${r.note ? `  ⚠ ${r.note}` : ''}`);
  console.log('═'.repeat(W));

  if (!r.source_url) {
    console.log(' ✗ Aucun wiki trouvé.');
    console.log('   Continuer le pipeline sans wiki crossref.');
    console.log('═'.repeat(W));
    return;
  }

  const qualityFlag = r.source_quality === 'authoritative' ? '✓' : '~';
  console.log(` ${qualityFlag} Source : ${r.source_type}  (${r.source_quality})`);
  console.log(`   ${r.source_url}`);
  console.log('');

  if (r.categories.length === 0) {
    console.log(' Aucune catégorie trouvée sur ce wiki.');
  } else {
    console.log(` ${r.categories.length} catégorie(s) trouvée(s) :`);
    for (const cat of r.categories) {
      const count = cat.count !== null ? `(${cat.count.toLocaleString('fr-FR')})` : '';
      console.log(`   • ${cat.name.padEnd(25)} ${count}`);
    }
  }

  console.log('');
  console.log(` Écrit dans : datamine/${r.slug}/wiki_categories.json`);
  console.log('═'.repeat(W));
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.slug) {
    console.error('Usage : node datamine/_lib/wiki-categories-fetch.mjs <slug> [--name="Display Name"] [--url=URL] [--json]');
    process.exit(1);
  }
  try {
    const r = await fetchCategories(args.slug, args.name, { url: args.url });
    if (args.json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      printHumanReport(r);
    }
    process.exit(r.source_url ? 0 : 2);
  } catch (err) {
    console.error(`Erreur : ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
