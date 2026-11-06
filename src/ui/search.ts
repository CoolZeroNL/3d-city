/**
 * Address search: an ARIA combobox with debounced type-ahead suggestions.
 */

import { parseCoordinates, parseMapLink, searchOnce, suggest, suggestionFits, offerTyped, type Place } from '../geo/geocode';
import { t } from '../i18n';
import type { LngLat } from '../geo/projection';

export interface SearchOptions {
  form: HTMLFormElement;
  input: HTMLInputElement;
  list: HTMLUListElement;
  locate: HTMLButtonElement;
  bias: () => LngLat | null;
  onPick: (place: Place) => void;
  onLocate: () => void;
  onError: (message: string) => void;
  /** a short note that isn't an error, e.g. that the closest match was used */
  onNote: (message: string) => void;
}

const isLink = (q: string) => /^(https?:\/\/|geo:)/i.test(q.trim());

export function setupSearch(o: SearchOptions): void {
  let items: Place[] = [];
  /**
   * The typed address, offered first when the suggestions don't carry its house number: the
   * suggestions come from a type-ahead search that guesses ("10 St" for "10 Ave"), this one
   * searches what was typed. It is also what Enter does then, so the list shows Enter's choice.
   */
  let exact: string | null = null;
  let active = -1;
  const count = () => items.length + (exact ? 1 : 0);
  let timer = 0;
  let inflight: AbortController | null = null;

  const close = () => {
    o.list.hidden = true;
    o.input.setAttribute('aria-expanded', 'false');
    o.input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const render = (message?: string) => {
    o.list.replaceChildren();
    if (message) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = message;
      li.setAttribute('aria-disabled', 'true');
      o.list.append(li);
    }
    const option = (i: number) => {
      const li = document.createElement('li');
      li.id = `sugg-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault(); // keep focus; avoid blur closing the list first
        pick(i);
      });
      return li;
    };
    if (exact) {
      const li = option(0);
      li.className = 'exact';
      const label = document.createElement('span');
      label.className = 's-label';
      label.textContent = exact;
      const detail = document.createElement('span');
      detail.className = 's-detail';
      const kind = document.createElement('span');
      kind.className = 's-kind';
      kind.textContent = t.exactAddress;
      detail.append(kind, ` · ${t.searchAsTyped}`);
      li.append(label, detail);
      o.list.append(li);
    }
    const offset = exact ? 1 : 0;
    items.forEach((p, i) => {
      const li = option(i + offset);
      const label = document.createElement('span');
      label.className = 's-label';
      label.textContent = p.label;
      const detail = document.createElement('span');
      detail.className = 's-detail';
      if (p.kind && p.kind !== 'poi') {
        const kind = document.createElement('span');
        kind.className = 's-kind';
        kind.textContent = t.kind[p.kind];
        detail.append(kind, p.detail ? ` · ${p.detail}` : '');
      } else {
        detail.textContent = p.detail;
      }
      li.append(label, detail);
      o.list.append(li);
    });
    const open = count() > 0 || !!message;
    o.list.hidden = !open;
    o.input.setAttribute('aria-expanded', String(open));
    if (active >= 0) o.input.setAttribute('aria-activedescendant', `sugg-${active}`);
    else o.input.removeAttribute('aria-activedescendant');
  };

  const choose = (p: Place) => {
    o.input.value = p.detail ? `${p.label}, ${p.detail}` : p.label;
    close();
    o.input.blur();
    o.onPick(p);
  };
  const pick = (i: number) => {
    if (exact && i === 0) return void searchTyped(exact);
    const p = items[i - (exact ? 1 : 0)];
    if (p) choose(p);
  };

  /** Search exactly what was typed (Nominatim); the top suggestion stands in if that finds nothing. */
  const searchTyped = async (q: string) => {
    const direct = !!(parseCoordinates(q) || parseMapLink(q));
    const closest = direct ? null : (items[0] ?? null);
    close();
    if (isLink(q) && !direct) {
      return o.onError(t.linkNoPosition);
    }
    try {
      const place = await searchOnce(q);
      if (place) {
        o.input.blur();
        o.onPick(place);
        if (place.streetOnly) o.onNote(t.streetOnly);
        return;
      }
      if (closest) {
        choose(closest);
        return o.onNote(t.closestMatch);
      }
      o.onError(t.nothingFound(q));
    } catch (err) {
      console.warn(err);
      if (closest) return choose(closest);
      o.onError(t.searchUnavailable);
    }
  };

  const query = (q: string) => {
    inflight?.abort();
    inflight = new AbortController();
    const signal = inflight.signal;
    suggest(q, o.bias(), signal)
      .then((res) => {
        if (signal.aborted) return;
        items = res;
        exact = offerTyped(q, res[0]) ? q : null;
        active = -1;
        render(res.length || exact ? undefined : t.noMatches);
      })
      .catch((err) => {
        if (signal.aborted) return;
        items = [];
        exact = null;
        render(t.suggestionsUnavailable);
        console.warn(err);
      });
  };

  o.input.addEventListener('input', () => {
    window.clearTimeout(timer);
    const q = o.input.value.trim();
    // coordinates and map links go straight to the map on Enter; they are not sent for suggestions
    if (q.length < 3 || parseCoordinates(q) || isLink(q)) {
      inflight?.abort();
      items = [];
      exact = null;
      close();
      return;
    }
    timer = window.setTimeout(() => query(q), 260);
  });

  o.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && count()) {
      e.preventDefault();
      active = (active + 1) % count();
      render();
    } else if (e.key === 'ArrowUp' && count()) {
      e.preventDefault();
      active = (active - 1 + count()) % count();
      render();
    } else if (e.key === 'Escape') {
      close();
    }
  });

  o.input.addEventListener('blur', () => window.setTimeout(close, 120));

  o.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    window.clearTimeout(timer);
    if (active >= 0) return pick(active);
    const q = o.input.value.trim();
    if (!q) return;
    const direct = !!(parseCoordinates(q) || parseMapLink(q));
    // the top suggestion only when it carries the house number that was typed
    if (!direct && items.length && o.list.hidden === false && suggestionFits(q, items[0])) return pick(exact ? 1 : 0);
    await searchTyped(q);
  });

  o.locate.addEventListener('click', () => o.onLocate());
}
