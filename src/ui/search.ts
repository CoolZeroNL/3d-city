/**
 * Address search: an ARIA combobox with debounced type-ahead suggestions.
 */

import { KIND_LABEL, parseCoordinates, parseMapLink, searchOnce, suggest, suggestionFits, type Place } from '../geo/geocode';
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
  let active = -1;
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
    items.forEach((p, i) => {
      const li = document.createElement('li');
      li.id = `sugg-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      const label = document.createElement('span');
      label.className = 's-label';
      label.textContent = p.label;
      const detail = document.createElement('span');
      detail.className = 's-detail';
      if (p.kind && p.kind !== 'poi') {
        const kind = document.createElement('span');
        kind.className = 's-kind';
        kind.textContent = KIND_LABEL[p.kind];
        detail.append(kind, p.detail ? ` · ${p.detail}` : '');
      } else {
        detail.textContent = p.detail;
      }
      li.append(label, detail);
      li.addEventListener('pointerdown', (e) => {
        e.preventDefault(); // keep focus; avoid blur closing the list first
        pick(i);
      });
      o.list.append(li);
    });
    const open = items.length > 0 || !!message;
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
    const p = items[i];
    if (p) choose(p);
  };

  const query = (q: string) => {
    inflight?.abort();
    inflight = new AbortController();
    const signal = inflight.signal;
    suggest(q, o.bias(), signal)
      .then((res) => {
        if (signal.aborted) return;
        items = res;
        active = -1;
        render(res.length ? undefined : 'No matches — try a street and town');
      })
      .catch((err) => {
        if (signal.aborted) return;
        items = [];
        render('Suggestions unavailable — press Enter to search');
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
      close();
      return;
    }
    timer = window.setTimeout(() => query(q), 260);
  });

  o.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      active = (active + 1) % items.length;
      render();
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      active = (active - 1 + items.length) % items.length;
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
    if (!direct && items.length && o.list.hidden === false && suggestionFits(q, items[0])) return pick(0);
    const closest = direct ? null : (items[0] ?? null);
    close();
    if (isLink(q) && !direct) {
      return o.onError('This link doesn’t show its position. Open it, copy the coordinates and paste those instead.');
    }
    try {
      const place = await searchOnce(q);
      if (place) {
        o.input.blur();
        return o.onPick(place);
      }
      if (closest) {
        choose(closest);
        return o.onNote('That exact address isn’t in OpenStreetMap, so this is the closest match. Slide the model and tap your building to pin it.');
      }
      o.onError(`Nothing found for “${q}”`);
    } catch (err) {
      console.warn(err);
      if (closest) return choose(closest);
      o.onError('Search is unavailable right now. Check your connection and try again.');
    }
  });

  o.locate.addEventListener('click', () => o.onLocate());
}
