/**
 * A dismissible card under the search bar for things the user can act on,
 * e.g. "No buildings here — Kleinfelde is 1.8 km north-east [Go to Kleinfelde]".
 */

export interface NoticeAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

export class NoticeView {
  constructor(
    private readonly el: HTMLElement,
    private readonly text: HTMLElement,
    private readonly actions: HTMLElement,
    close: HTMLElement,
  ) {
    close.addEventListener('click', () => this.hide());
  }

  show(message: string, actions: NoticeAction[] = []): void {
    this.text.textContent = message;
    this.actions.replaceChildren(
      ...actions.map((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = a.primary ? 'btn btn-primary' : 'btn';
        b.textContent = a.label;
        b.addEventListener('click', () => {
          this.hide();
          a.onClick();
        });
        return b;
      }),
    );
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }

  get visible(): boolean {
    return !this.el.hidden;
  }
}
