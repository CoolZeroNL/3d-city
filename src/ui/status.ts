/**
 * Loading progress for the three build stages (spec: terrain first, then
 * buildings, then roads/water/vegetation), announced politely to screen readers.
 */

import { t } from '../i18n';

export type StepId = 'terrain' | 'buildings' | 'layers';
export type StepState = 'pending' | 'loading' | 'done' | 'error';

const LABELS: Record<StepId, string> = {
  terrain: t.stepTerrain,
  buildings: t.stepBuildings,
  layers: t.stepLayers,
};

export class StatusView {
  private states: Record<StepId, StepState> = { terrain: 'pending', buildings: 'pending', layers: 'pending' };
  private fadeTimer = 0;
  private retry: (() => void) | null = null;
  private message = '';
  private sticky = false;

  constructor(private readonly el: HTMLElement) {}

  reset(): void {
    this.states = { terrain: 'loading', buildings: 'loading', layers: 'loading' };
    this.retry = null;
    this.message = '';
    this.sticky = false;
    this.render();
  }

  set(step: StepId, state: StepState, retry?: () => void): void {
    this.states[step] = state;
    if (state === 'error' && retry) this.retry = retry;
    this.render();
  }

  get(step: StepId): StepState {
    return this.states[step];
  }

  /** A one-off message (e.g. search errors), shown in place of the steps; fades after a few seconds. */
  say(message: string): void {
    this.message = message;
    this.sticky = false;
    this.render();
  }

  /** Work in progress before loading starts: shown with a spinner until reset() or say(). */
  busy(message: string): void {
    this.message = message;
    this.sticky = true;
    this.render();
  }

  hide(): void {
    this.el.hidden = true;
  }

  private render(): void {
    window.clearTimeout(this.fadeTimer);
    this.el.classList.remove('fade');
    this.el.hidden = false;
    this.el.replaceChildren();
    if (this.message) {
      const span = document.createElement('span');
      span.textContent = this.message;
      if (this.sticky) {
        span.className = 'step';
        span.dataset.state = 'loading';
      } else {
        this.fadeTimer = window.setTimeout(() => this.fadeOut(), 5000);
      }
      this.el.append(span);
      return;
    }
    for (const id of Object.keys(LABELS) as StepId[]) {
      const s = document.createElement('span');
      s.className = 'step';
      s.dataset.state = this.states[id];
      s.textContent = this.states[id] === 'error' ? t.stepFailed(LABELS[id]) : LABELS[id];
      this.el.append(s);
    }
    if (this.retry && Object.values(this.states).includes('error')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'retry';
      b.textContent = t.retry;
      const fn = this.retry;
      b.addEventListener('click', () => fn());
      this.el.append(b);
    }
    const settled = Object.values(this.states).every((s) => s === 'done' || s === 'error');
    const allDone = Object.values(this.states).every((s) => s === 'done');
    if (settled && allDone) this.fadeTimer = window.setTimeout(() => this.fadeOut(), 1600);
  }

  private fadeOut(): void {
    this.el.classList.add('fade');
    this.fadeTimer = window.setTimeout(() => {
      this.el.hidden = true;
      this.message = '';
    }, 450);
  }
}
