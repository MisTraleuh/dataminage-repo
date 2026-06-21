// Shared helper for the datamine pipeline (Critère B.2 of /datamine skill).
// Turns a technical id like "rooms_Floor1_Large" into a wiki-friendly title
// like "Floor 1 Large Room".

export interface HumanizeOptions {
  /** Catégorie préfixes à strip si l'id commence par eux (`rooms_`, `upgrades_`...). */
  categoryPrefixes?: string[];
  /** Suffixe ajouté quand le préfixe a été strippé — utile pour rendre le sens
   *  ("BasementUpgrade" → "Basement Upgrade", "House1" → "House 1"). */
  suffixWhenPrefixStripped?: string;
  /** Si l'id résultant est un seul mot opaque, préfixer par cette catégorie display name. */
  fallbackCategoryLabel?: string;
}

const TITLE_CASE_EXCEPTIONS = new Set(['of', 'the', 'and', 'a', 'an', 'to', 'in', 'on', 'for', 'vs']);

function titleCase(words: string[]): string {
  return words
    .map((w, i) => {
      if (!w) return w;
      const lower = w.toLowerCase();
      if (i > 0 && TITLE_CASE_EXCEPTIONS.has(lower)) return lower;
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(' ');
}

export function humanizeId(id: string, opts: HumanizeOptions = {}): string {
  let s = id;
  let prefixStripped = false;

  for (const p of opts.categoryPrefixes ?? []) {
    if (s.startsWith(p + '_')) {
      s = s.slice(p.length + 1);
      prefixStripped = true;
      break;
    }
  }

  s = s.replace(/_+/g, ' ');
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  s = s.replace(/([A-Za-z])(\d)/g, '$1 $2');
  s = s.replace(/(\d)([A-Za-z])/g, '$1 $2');
  s = s.replace(/\s+/g, ' ').trim();

  if (!s) s = id;

  let result = titleCase(s.split(' '));

  if (prefixStripped && opts.suffixWhenPrefixStripped) {
    if (!result.toLowerCase().includes(opts.suffixWhenPrefixStripped.toLowerCase())) {
      result = `${result} ${opts.suffixWhenPrefixStripped}`;
    }
  }

  if (opts.fallbackCategoryLabel && !/\s/.test(result) && result.length < 4) {
    result = `${opts.fallbackCategoryLabel} ${result}`;
  }

  return result;
}

/**
 * Detects if a string looks like a raw technical id that a wiki visitor should
 * never see. Used in post-seed validation (Critère B.5).
 */
export function isTechnicalName(name: string, id?: string): boolean {
  if (!name) return true;
  if (/^[a-z][a-z0-9_]*$/.test(name) && name.includes('_')) return true;
  if (/^[A-Z][A-Z0-9_]+$/.test(name) && name.includes('_')) return true;
  if (/^(default|tmp|test|set|new|old)_/i.test(name)) return true;
  if (/_(v\d+|new|old|tmp|tmp\d+)$/i.test(name)) return true;
  if (id && name === id && !/^[A-Z][a-z]+([A-Z][a-z]+)*$/.test(id)) return true;
  return false;
}
