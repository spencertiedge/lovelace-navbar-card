import { css, html, nothing, type TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';

import type { Popup, PopupItem } from '@/components/navbar';
import { executeAction } from '@/lib/action-handler';
import type { NavbarCard } from '@/navbar-card';
import { fireDOMEvent, processTemplate } from '@/utils';

/**
 * ST fork: popup_style menu - a route's popup drawn as iOS's menu (ST, 2026-10-29: the system's own, a <select>'s,
 * takes nothing but names; wanted "more detail than just the name", drag to select and haptics). Opens on the press
 * (a tap's from the route's pointerdown, a hold's as the hold fires, the finger still down); the finger dragged
 * along it lights the row under it, a haptic tick each time that changes (Home Assistant's app plays the window's
 * `haptic` events); lifting on a row chooses it, on the button or the menu leaves it open to tap, elsewhere closes
 * it. Rows: a checkmark on the current one, label, an optional detail line (`detail`, templatable), icon on the right;
 * sections (`section`) under headings.
 */

// a finger (or button) down anywhere, seen first (capture): a menu opened while one is down follows it
let pressing = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (pressing = true), true);
  for (const t of ['pointerup', 'pointercancel'])
    window.addEventListener(t, () => (pressing = false), true);
}

const CHECK = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"
    stroke-linejoin="round" />
</svg>`;

export class StMenu {
  private _items: PopupItem[] = [];
  private _target?: HTMLElement;
  private _anchor?: DOMRect;
  private _active = -1;
  private _tracking = false;
  private _open = false;
  // the click that ends the press which opened it opens it again (the route's tap action): not while that press lasts
  private _ignoreOpenUntil = 0;
  private _removal?: number;

  constructor(
    private readonly _navbarCard: NavbarCard,
    private readonly _popup: Popup,
  ) {}

  get isOpen(): boolean {
    return this._open;
  }

  private get _root(): ShadowRoot | null {
    return this._navbarCard.shadowRoot;
  }

  /** Opens it from `target` (the route); `press`: from that route's own pointerdown (a tap's popup) */
  public open(target: HTMLElement, press = false): void {
    if (!press && Date.now() < this._ignoreOpenUntil) return;  // (a new press always opens it)
    this._items = this._popup.items.filter(item => !item.hidden);
    if (!this._items.length) return;
    clearTimeout(this._removal);
    this._target = target;
    this._anchor = target.getBoundingClientRect();
    this._active = -1;
    this._open = true;
    if (press) this._ignoreOpenUntil = Infinity;
    this._navbarCard.focusedPopup = this._render();
    window.addEventListener('keydown', this._onKey);
    if (pressing) this._track();
    this._navbarCard.updateComplete.then(() => {
      this._place();
      requestAnimationFrame(() => this._menu()?.classList.add('visible'));
    });
  }

  /** Closes it; the backdrop kept until the finger's up (so the tap that closed it lands on nothing) */
  public close(): void {
    if (!this._open) return;
    this._open = false;
    this._untrack();
    window.removeEventListener('keydown', this._onKey);
    const menu = this._menu();
    menu?.classList.remove('visible');
    menu?.classList.add('closing');
    const remove = () => {
      clearTimeout(this._removal);
      this._removal = window.setTimeout(() => {
        if (!this._open) this._navbarCard.focusedPopup = null;
      }, menu ? 220 : 0);
    };
    if (pressing) window.addEventListener('pointerup', () => setTimeout(remove, 60), { capture: true, once: true });
    else remove();
  }

  private _render(): TemplateResult<1> {
    const hass = this._navbarCard._hass;
    const checks = this._items.some(item => item.selected);
    let section: string | undefined;
    const rows = this._items.map((item, i) => {
      const s = item.data.section;
      const heading =
        s !== section
          ? html`${i ? html`<div class="st-menu-gap"></div>` : nothing}${
              s ? html`<div class="st-menu-section">${s}</div>` : nothing
            }`
          : nothing;
      section = s;
      // (its label whatever the navbar's show_labels: a menu of names)
      const label = processTemplate<string>(hass, this._navbarCard, item.data.label) || item.url || '';
      const detail = processTemplate<string>(hass, this._navbarCard, item.data.detail);
      const icon = processTemplate<string>(hass, this._navbarCard, item.data.icon);
      return html`${heading}<div
          class=${classMap({ 'st-menu-row': true, current: item.selected })}
          role="menuitem"
          data-i=${i}>
          ${checks ? html`<span class="st-menu-check">${item.selected ? CHECK : nothing}</span>` : nothing}
          <span class="st-menu-text">
            <span class="st-menu-label">${label}</span>
            ${detail ? html`<span class="st-menu-detail">${detail}</span>` : nothing}
          </span>
          ${icon ? html`<ha-icon class="st-menu-icon" icon=${icon}></ha-icon>` : nothing}
        </div>`;
    });
    return html`<div class="st-menu-backdrop" @pointerdown=${this._onBackdropDown}></div>
      <div
        class=${classMap({ 'st-menu': true, dark: !!(hass?.themes as { darkMode?: boolean } | undefined)?.darkMode })}
        role="menu"
        @pointerdown=${this._onMenuDown}
        @pointermove=${this._onHover}
        @pointerleave=${this._onLeave}>
        ${rows}
      </div>`;
  }

  /** Beside its button: over a bar along the bottom (under one along the top), beside a rail; grown from the button */
  private _place(): void {
    const menu = this._menu(), a = this._anchor;
    if (!menu || !a) return;
    const M = 12, G = 10, vw = window.innerWidth, vh = window.innerHeight;
    const bar = this._target?.parentElement?.getBoundingClientRect();
    const rail = !!bar && bar.height > bar.width;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
    let w = menu.offsetWidth, h = menu.offsetHeight, left: number, top: number;
    if (rail) {
      left = a.left + a.width / 2 < vw / 2 ? a.right + G : a.left - G - w;
      top = clamp(a.top, M, vh - h - M);
    } else {
      const up = a.top + a.height / 2 > vh / 2;
      const room = up ? a.top - G - M : vh - a.bottom - G - M;
      if (h > room) {
        menu.style.maxHeight = `${Math.max(room, 120)}px`;
        h = menu.offsetHeight;
      }
      top = up ? a.top - G - h : a.bottom + G;
      left = clamp(a.left + a.width / 2 - w / 2, M, vw - w - M);
    }
    w = menu.offsetWidth;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.transformOrigin = `${clamp(a.left + a.width / 2 - left, 0, w)}px ${clamp(a.top + a.height / 2 - top, 0, h)}px`;
    // (a menu that scrolls lets the finger scroll it; one that doesn't keeps the drag)
    if (menu.scrollHeight > menu.clientHeight + 1) menu.style.touchAction = 'pan-y';
  }

  private _menu(): HTMLElement | null {
    return this._root?.querySelector<HTMLElement>('.st-menu') ?? null;
  }

  private _rowAt(x: number, y: number): number {
    for (const row of this._root?.querySelectorAll<HTMLElement>('.st-menu-row') ?? []) {
      const r = row.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return Number(row.dataset.i);
    }
    return -1;
  }

  private _setActive(i: number, tick: boolean): void {
    if (i === this._active) return;
    this._active = i;
    this._root?.querySelectorAll<HTMLElement>('.st-menu-row').forEach(row =>
      row.classList.toggle('active', Number(row.dataset.i) === i),
    );
    if (tick && i >= 0) fireDOMEvent(window, 'haptic', { detailOverride: 'selection' });
  }

  private _track(): void {
    if (this._tracking) return;
    this._tracking = true;
    window.addEventListener('pointermove', this._onMove, true);
    window.addEventListener('pointerup', this._onUp, true);
    window.addEventListener('pointercancel', this._onCancel, true);
  }

  private _untrack(): void {
    this._tracking = false;
    window.removeEventListener('pointermove', this._onMove, true);
    window.removeEventListener('pointerup', this._onUp, true);
    window.removeEventListener('pointercancel', this._onCancel, true);
  }

  private _inside(r: DOMRect | undefined, x: number, y: number, pad = 0): boolean {
    return !!r && x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  }

  private _onMove = (ev: PointerEvent): void => {
    this._setActive(this._rowAt(ev.clientX, ev.clientY), true);
  };

  private _onUp = (ev: PointerEvent): void => {
    this._untrack();
    this._ignoreOpenUntil = Date.now() + 400;
    const i = this._rowAt(ev.clientX, ev.clientY);
    if (i >= 0) return this._choose(i);
    this._setActive(-1, false);
    // lifted on its button or on the menu: left open, to tap; anywhere else: closed
    const x = ev.clientX, y = ev.clientY;
    if (!this._inside(this._anchor, x, y, 8) && !this._inside(this._menu()?.getBoundingClientRect(), x, y)) this.close();
  };

  private _onCancel = (): void => {
    this._untrack();
    this._ignoreOpenUntil = Date.now() + 400;
    this._setActive(-1, false);
  };

  // open, a finger put down on it: that row lit (no tick - it's where the finger landed), followed from there
  private _onMenuDown = (ev: PointerEvent): void => {
    ev.stopPropagation();
    this._setActive(this._rowAt(ev.clientX, ev.clientY), false);
    this._track();
  };

  // a mouse over it, nothing pressed: the row under it lit
  private _onHover = (ev: PointerEvent): void => {
    if (!this._tracking && ev.pointerType === 'mouse') this._setActive(this._rowAt(ev.clientX, ev.clientY), false);
  };

  private _onLeave = (): void => {
    if (!this._tracking) this._setActive(-1, false);
  };

  private _onBackdropDown = (ev: PointerEvent): void => {
    ev.preventDefault();
    ev.stopPropagation();
    this._ignoreOpenUntil = Date.now() + 600;  // (its own button, tapped to close it: not opened again)
    this.close();
  };

  private _onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.close();
    }
  };

  private _choose(i: number): void {
    const item = this._items[i];
    const target = this._target;
    this.close();
    if (!item || !target) return;
    executeAction({
      action: item.tap_action,  // (none: a page, gone to by its url, as a tap on it would)
      actionType: 'tap',
      context: this._navbarCard,
      data: { popupItem: item },
      target,
    });
  }
}

export const ST_MENU_STYLES = css`
  .route.st-menu-route {
    touch-action: none;
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .st-menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: var(--navbar-popup-backdrop-z-index);
    touch-action: none;
  }
  .st-menu {
    --st-menu-secondary: rgba(60, 60, 67, 0.6);
    --st-menu-highlight: rgba(0, 0, 0, 0.08);
    --st-menu-separator: rgba(60, 60, 67, 0.18);
    position: fixed;
    left: 0;
    top: 0;
    z-index: var(--navbar-popup-z-index);
    box-sizing: border-box;
    min-width: 250px;
    max-width: min(320px, calc(100vw - 24px));
    max-height: calc(100vh - 24px);
    padding: 8px 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    border-radius: 26px;
    background: rgba(246, 246, 248, 0.78);
    -webkit-backdrop-filter: blur(30px) saturate(180%);
    backdrop-filter: blur(30px) saturate(180%);
    box-shadow:
      0 12px 48px rgba(0, 0, 0, 0.2),
      0 0 0 0.5px rgba(0, 0, 0, 0.06);
    color: #000;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
    touch-action: none;
    opacity: 0;
    transform: scale(0.25);
    transition:
      transform 0.42s cubic-bezier(0.3, 1.3, 0.5, 1),
      opacity 0.18s ease-out;
  }
  .st-menu.dark {
    --st-menu-secondary: rgba(235, 235, 245, 0.6);
    --st-menu-highlight: rgba(255, 255, 255, 0.12);
    --st-menu-separator: rgba(84, 84, 88, 0.6);
    background: rgba(37, 37, 40, 0.78);
    color: #fff;
    box-shadow:
      0 12px 48px rgba(0, 0, 0, 0.45),
      0 0 0 0.5px rgba(255, 255, 255, 0.08);
  }
  .st-menu.visible {
    opacity: 1;
    transform: none;
  }
  .st-menu.closing {
    opacity: 0;
    transform: scale(0.9);
    pointer-events: none;
    transition:
      transform 0.2s ease-in,
      opacity 0.2s ease-in;
  }
  .st-menu-row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    margin: 0 8px;
    padding: 9px 14px 9px 12px;
    box-sizing: border-box;
    border-radius: 16px;
    transition: background-color 0.12s;
  }
  .st-menu-row.active {
    background: var(--st-menu-highlight);
    transition: none;
  }
  .st-menu-check {
    flex: none;
    display: flex;
    width: 18px;
  }
  .st-menu-check svg {
    width: 18px;
    height: 18px;
  }
  .st-menu-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .st-menu-label,
  .st-menu-detail {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .st-menu-label {
    font-size: 17px;
    line-height: 22px;
    letter-spacing: -0.41px;
  }
  .st-menu-detail {
    font-size: 13px;
    line-height: 17px;
    letter-spacing: -0.08px;
    color: var(--st-menu-secondary);
  }
  .st-menu-icon {
    flex: none;
    display: flex;
    justify-content: center;
    width: 24px;
    --mdc-icon-size: 21px;
  }
  .st-menu-gap {
    height: 0.5px;
    margin: 6px 20px;
    background: var(--st-menu-separator);
  }
  .st-menu-section {
    padding: 6px 20px 2px;
    font-size: 13px;
    line-height: 18px;
    color: var(--st-menu-secondary);
  }
  @media (prefers-reduced-motion: reduce) {
    .st-menu,
    .st-menu.closing {
      transform: none;
      transition: opacity 0.15s;
    }
  }
`;
