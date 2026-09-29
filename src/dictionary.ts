// Word definitions from Wiktionary's REST API (CORS-enabled, no key). Definitions are
// in English, grouped by the language of the word, so a Spanish book gets Spanish words.

export interface Sense {
  text: string;
  examples: string[];
}

export interface Entry {
  partOfSpeech: string;
  senses: Sense[];
}

export interface Lookup {
  word: string;
  entries: Entry[];
  /** Page to read more, in the browser. */
  url: string;
}

interface ApiDefinition {
  definition: string;
  examples?: string[];
  parsedExamples?: { example: string }[];
}

type ApiResponse = Record<string, { partOfSpeech: string; language: string; definitions: ApiDefinition[] }[]>;

const API = 'https://en.wiktionary.org/api/rest_v1/page/definition/';
const cache = new Map<string, Lookup | null>();

const plain = (html: string) =>
  (new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Cleans a selection down to a lookup term: trims punctuation and possessives. */
export function lookupTerm(text: string): string {
  return text
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/['’]s$/u, '');
}

/**
 * Looks a word up, preferring entries in `language` (a BCP 47 tag such as "en-US").
 * Returns null when there is no entry; throws when offline.
 */
export async function define(word: string, language: string): Promise<Lookup | null> {
  const term = lookupTerm(word);
  if (!term) return null;
  const lang = (language || 'en').toLowerCase().split('-')[0];
  const key = `${lang}:${term}`;
  if (cache.has(key)) return cache.get(key)!;

  let data: ApiResponse | null = null;
  let found = term;
  for (const candidate of new Set([term, term.toLowerCase()])) {
    const res = await fetch(API + encodeURIComponent(candidate.replace(/ /g, '_')), { headers: { accept: 'application/json' } });
    if (res.ok) {
      data = (await res.json()) as ApiResponse;
      found = candidate;
      break;
    }
    if (res.status !== 404) throw new Error(`HTTP ${res.status}`);
  }
  const groups = data ? (data[lang] ?? data.en ?? Object.values(data)[0] ?? []) : [];
  const entries: Entry[] = groups
    .map((g) => ({
      partOfSpeech: g.partOfSpeech,
      senses: g.definitions
        .map((d) => ({
          text: plain(d.definition),
          examples: (d.parsedExamples?.map((e) => e.example) ?? d.examples ?? []).map(plain).filter(Boolean).slice(0, 1),
        }))
        .filter((s) => s.text)
        .slice(0, 5),
    }))
    .filter((e) => e.senses.length);
  const result = entries.length ? { word: found, entries, url: `https://en.wiktionary.org/wiki/${encodeURIComponent(found)}` } : null;
  cache.set(key, result);
  return result;
}
