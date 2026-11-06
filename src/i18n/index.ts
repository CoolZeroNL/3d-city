/**
 * The app's language: English, Spanish, Portuguese (Brazil) or German. It follows the browser unless the
 * visitor picked one, which is remembered on this device. Share links carry no language, so a
 * link opens in each visitor's own.
 *
 * The page's HTML is in English (for search engines and as a fallback); elements carry their
 * dictionary key in data-t (text) or data-t-attr ("attribute:key;…"), and translatePage swaps
 * them in. Everything the script writes comes from `t`.
 */

import { de } from './de';
import { en, type Messages } from './en';
import { es } from './es';
import { pt } from './pt';

export type Lang = 'en' | 'es' | 'pt' | 'de';

export const LANGS: ReadonlyArray<{ code: Lang; name: string; locale: string }> = [
  { code: 'en', name: 'English', locale: 'en-GB' },
  // Latin American Spanish, with Mexico's numbers (1.5, 13,300)
  { code: 'es', name: 'Español', locale: 'es-MX' },
  { code: 'pt', name: 'Português', locale: 'pt-BR' },
  { code: 'de', name: 'Deutsch', locale: 'de-DE' },
];

export const MESSAGES: Record<Lang, Messages> = { en, es, pt, de };

const KEY = 'yp:lang';

/** The visitor's choice if there is one, else the first browser language we have, else English. */
export function pickLang(chosen: string | null, preferred: readonly string[]): Lang {
  if (chosen && chosen in MESSAGES) return chosen as Lang;
  for (const p of preferred) {
    const code = p.slice(0, 2).toLowerCase();
    if (code in MESSAGES) return code as Lang;
  }
  return 'en';
}

function chosenLang(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const lang: Lang =
  typeof navigator === 'undefined' ? 'en' : pickLang(chosenLang(), navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en']);
export const t: Messages = MESSAGES[lang];
export const locale = LANGS.find((l) => l.code === lang)!.locale;

/** Remember a choice for next time (the page reloads to apply it). */
export function saveLang(code: Lang): void {
  try {
    localStorage.setItem(KEY, code);
  } catch {
    /* private browsing: the choice lasts for this page only */
  }
}

const formats = new Map<number, Intl.NumberFormat>();

/** A number as this language writes it: 1.5 is "1,5" in Portuguese and German; thousands grouped. */
export function num(x: number, digits = 0): string {
  let f = formats.get(digits);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    formats.set(digits, f);
  }
  return f.format(x);
}

/** "500 × 500 m", "2 × 2 km", "1,5 × 1,5 km" */
export function area(m: number): string {
  if (m < 1000) return `${num(m)} × ${num(m)} m`;
  const km = Number((m / 1000).toFixed(1));
  const s = num(km, Number.isInteger(km) ? 0 : 1);
  return `${s} × ${s} km`;
}

/** "350 m", "1,9 km", "12 km" */
export function distance(m: number): string {
  return m < 950 ? `${num(Math.round(m / 50) * 50)} m` : `${num(m / 1000, m < 9950 ? 1 : 0)} km`;
}

/** The direction for a bearing, in a phrase like "1.9 km north-east". */
export function direction(bearingDeg: number): string {
  return t.compass[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8];
}

/** "1:13,300" (English), "1:13.300" (Portuguese, German): a print of `sideMm` covering `sizeM`. */
export function scale(sizeM: number, sideMm: number): string {
  return `1:${new Intl.NumberFormat(locale, { maximumSignificantDigits: 3 }).format((sizeM * 1000) / sideMm)}`;
}

/** A dictionary entry by its dotted key ("style.white"), as the page's data-t names it. */
export function lookup(key: string, messages: Messages = t): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), messages);
}

/** Put this language's texts into the page, and fill the language pickers. */
export function translatePage(root: Document = document): void {
  root.documentElement.lang = locale;
  root.title = t.homeTitle;
  for (const el of root.querySelectorAll<HTMLElement>('[data-t]')) {
    const v = lookup(el.dataset.t!);
    if (typeof v === 'string') el.textContent = v;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-t-attr]')) {
    for (const pair of el.dataset.tAttr!.split(';')) {
      const [attr, key] = pair.split(':');
      const v = lookup(key);
      if (typeof v === 'string') el.setAttribute(attr, v);
    }
  }
  for (const select of root.querySelectorAll<HTMLSelectElement>('.lang-select')) {
    select.replaceChildren(
      ...LANGS.map((l) => {
        const o = root.createElement('option');
        o.value = l.code;
        o.textContent = l.name;
        o.lang = l.locale;
        o.selected = l.code === lang;
        return o;
      }),
    );
    select.addEventListener('change', () => {
      saveLang(select.value as Lang);
      // the link keeps the view, so the model comes back as it was, in the new language
      location.reload();
    });
  }
}
