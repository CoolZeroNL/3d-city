import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en, type Messages } from '../src/i18n/en';
import { lookup, MESSAGES, pickLang } from '../src/i18n';

/** Every text of a dictionary, by dotted key; functions are called with sample arguments. */
function texts(m: Messages): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (o: unknown, path: string) => {
    if (typeof o === 'string') out.set(path, o);
    else if (typeof o === 'function') {
      const args = Array.from({ length: o.length }, (_, i) => (i % 3 === 1 ? 2 : i % 3 === 2 ? true : `x${i}`));
      out.set(path, String(o(...args)));
      // and the singular, where a count decides the wording
      out.set(`${path}#1`, String(o(...args.map((a) => (typeof a === 'number' ? 1 : a)))));
    } else if (Array.isArray(o)) o.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(m, '');
  return out;
}

/** Texts that are rightly the same as in English (names, units, words the languages share). */
const SAME: Record<string, string[]> = {
  pt: ['legendTop', 'legendTop#1', 'printSquare', 'printSquare#1'],
  de: ['legendTop', 'legendTop#1', 'printSquare', 'printSquare#1', 'docTitle', 'docTitle#1', 'shareInApp', 'shareInApp#1', 'optional', 'style.sand'],
};

describe('languages', () => {
  it('picks the visitor’s choice, else the first browser language it has, else English', () => {
    expect(pickLang('de', ['pt-BR'])).toBe('de');
    expect(pickLang(null, ['pt-BR', 'en'])).toBe('pt');
    expect(pickLang(null, ['fr-FR', 'de-AT'])).toBe('de');
    expect(pickLang(null, ['fr-FR', 'es'])).toBe('en');
    expect(pickLang('xx', ['en-US'])).toBe('en');
  });

  for (const code of ['pt', 'de'] as const) {
    it(`has every text in ${code === 'pt' ? 'Portuguese' : 'German'}, and none left in English`, () => {
      const base = texts(en);
      const other = texts(MESSAGES[code]);
      expect([...other.keys()].sort()).toEqual([...base.keys()].sort());
      const untranslated = [...base].filter(([k, v]) => other.get(k) === v && !SAME[code].includes(k)).map(([k]) => k);
      expect(untranslated).toEqual([]);
      for (const [k, v] of other) expect(v.trim(), k).not.toBe('');
    });
  }

  it('matches the page: every marked text exists, and the page’s English is the dictionary’s', () => {
    const html = readFileSync('index.html', 'utf8');
    const texts = [...html.matchAll(/<\w+[^>]*\sdata-t="([^"]+)"[^>]*>([^<]*)</g)];
    expect(texts.length).toBeGreaterThan(40);
    for (const [, key, text] of texts) expect(lookup(key, en), key).toBe(text);
    const attrs = [...html.matchAll(/<[^>]*data-t-attr="([^"]+)"[^>]*>/g)];
    expect(attrs.length).toBeGreaterThan(10);
    for (const [tag, spec] of attrs) {
      for (const pair of spec.split(';')) {
        const [attr, key] = pair.split(':');
        const value = new RegExp(`\\s${attr}="([^"]*)"`).exec(tag)?.[1];
        expect(lookup(key, en), `${attr} ${key}`).toBe(value);
      }
    }
  });
});
