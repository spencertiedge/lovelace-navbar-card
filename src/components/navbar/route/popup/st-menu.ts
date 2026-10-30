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
let pressAt = { x: 0, y: 0 };
if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    ev => {
      pressing = true;
      pressAt = { x: ev.clientX, y: ev.clientY };
    },
    true,
  );
  for (const t of ['pointerup', 'pointercancel'])
    window.addEventListener(t, () => (pressing = false), true);
}

const CHECK = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"
    stroke-linejoin="round" />
</svg>`;

// iOS's spring, as CSS's linear() easing: `response` (s) and damping ratio; its duration is when it has settled
const spring = (response: number, damping: number): { easing: string; duration: number } => {
  const w = (2 * Math.PI) / response, wd = w * Math.sqrt(1 - damping * damping);
  const x = (t: number) => 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
  let duration = response;
  while (duration < 2 && Math.exp(-damping * w * duration) > 0.002) duration += 0.02;
  const n = 48, points = Array.from({ length: n + 1 }, (_, i) => (i === n ? 1 : x((duration * i) / n)).toFixed(4));
  return { easing: `linear(${points.join(', ')})`, duration: Math.round(duration * 1000) };
};
const OPEN = spring(0.42, 0.78);  // (a little bounce, as the system's menus)
const CLOSE = spring(0.3, 1);
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const canAnimate = (el: Element | null): el is HTMLElement => !!el && typeof (el as HTMLElement).animate === 'function';

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
  // the press that opened it: lifted where it landed it leaves the menu open (the row under it isn't chosen)
  private _openingPress = false;
  private _moved = false;
  // where its glass starts and ends: the button's capsule, as insets of the menu's box
  private _from = '';
  private _radius = 26;

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
    this._openingPress = pressing;
    this._moved = false;
    if (press) this._ignoreOpenUntil = Infinity;
    this._navbarCard.focusedPopup = this._render();
    window.addEventListener('keydown', this._onKey);
    if (pressing) this._track();
    this._navbarCard.updateComplete.then(() => {
      this._place();
      this._morph(true);
    });
  }

  /** Closes it; the backdrop kept until the finger's up (so the tap that closed it lands on nothing) */
  public close(): void {
    if (!this._open) return;
    this._open = false;
    this._untrack();
    window.removeEventListener('keydown', this._onKey);
    const menu = this._menu();
    menu?.classList.add('closing');
    const took = menu ? this._morph(false) : 0;
    const remove = () => {
      clearTimeout(this._removal);
      this._removal = window.setTimeout(() => {
        if (!this._open) this._navbarCard.focusedPopup = null;
      }, took);
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
      <div class="st-menu-shadow"></div>
      <div
        class=${classMap({ 'st-menu': true, dark: !!(hass?.themes as { darkMode?: boolean } | undefined)?.darkMode })}
        role="menu"
        @pointerdown=${this._onMenuDown}
        @pointermove=${this._onHover}
        @pointerleave=${this._onLeave}>
        <div class="st-menu-body">${rows}</div>
      </div>`;
  }

  /** Over its button, as iOS 26's: grown out of it, an edge kept where the button's is (along a bar: over it, toward
   * the screen; on a rail: its top and outer side at the button's) */
  private _place(): void {
    const menu = this._menu(), a = this._anchor;
    if (!menu || !a) return;
    const M = 8, vw = window.innerWidth, vh = window.innerHeight;
    const bar = this._target?.parentElement?.getBoundingClientRect();
    const rail = !!bar && bar.height > bar.width;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
    let w = menu.offsetWidth, h = menu.offsetHeight, left: number, top: number;
    if (rail) {
      if (h > vh - 2 * M) {
        menu.style.maxHeight = `${vh - 2 * M}px`;
        h = menu.offsetHeight;
      }
      left = clamp(a.left + a.width / 2 < vw / 2 ? a.left : a.right - w, M, vw - w - M);
      top = clamp(a.top, M, vh - h - M);
    } else {
      const up = a.top + a.height / 2 > vh / 2;
      const room = up ? a.bottom - M : vh - a.top - M;
      if (h > room) {
        menu.style.maxHeight = `${Math.max(room, 120)}px`;
        h = menu.offsetHeight;
      }
      top = clamp(up ? a.bottom - h : a.top, M, vh - h - M);
      left = clamp(a.left + a.width / 2 - w / 2, M, vw - w - M);
    }
    w = menu.offsetWidth;
    for (const el of [menu, this._shadow()]) {
      if (!el) continue;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
    // the button's capsule, as insets of the menu's box (its corners round as it is)
    const t = a.top - top, l = a.left - left, r = left + w - a.right, b = top + h - a.bottom;
    this._from = `inset(${t}px ${r}px ${b}px ${l}px round ${Math.min(a.width, a.height) / 2}px)`;
    this._radius = parseFloat(getComputedStyle(menu).borderTopLeftRadius) || 26;
    const body = menu.querySelector<HTMLElement>('.st-menu-body');
    if (body) body.style.transformOrigin = `${a.left + a.width / 2 - left}px ${a.top + a.height / 2 - top}px`;
    // (a menu that scrolls lets the finger scroll it; one that doesn't keeps the drag)
    if (menu.scrollHeight > menu.clientHeight + 1) menu.style.touchAction = 'pan-y';
  }

  /** iOS 26's menu: the button's glass grows into the menu (a spring, a little bounce), its rows coming in out of a
   * blur; closing, it goes back into the button. Returns how long that takes (ms) */
  private _morph(opening: boolean): number {
    const menu = this._menu(), shadow = this._shadow(), a = this._anchor;
    if (!menu) return 0;
    menu.classList.toggle('visible', opening);
    if (!canAnimate(menu) || !a || !this._from) return 0;
    const full = `inset(0px 0px 0px 0px round ${this._radius}px)`;
    const body = menu.querySelector<HTMLElement>('.st-menu-body');
    if (reducedMotion()) {
      const fade = [{ opacity: 0 }, { opacity: 1 }];
      menu.animate(opening ? fade : fade.reverse(), { duration: 150, fill: 'both' });
      return 150;
    }
    const { easing, duration } = opening ? OPEN : CLOSE;
    const glass = [{ clipPath: this._from }, { clipPath: full }];
    menu.animate(opening ? glass : [...glass].reverse(), { duration, easing, fill: 'both' });
    if (canAnimate(shadow)) {
      const r = shadow.getBoundingClientRect();
      const sx = a.width / Math.max(r.width, 1), sy = a.height / Math.max(r.height, 1);
      const small = { transform: `translate(${a.left - r.left}px, ${a.top - r.top}px) scale(${sx}, ${sy})`, opacity: 0 };
      const big = { transform: 'none', opacity: 1 };
      shadow.animate(opening ? [small, big] : [big, small], { duration, easing, fill: 'both' });
    }
    if (canAnimate(body)) {
      const hidden = { opacity: 0, filter: 'blur(8px)', transform: 'scale(0.9)' };
      const shown = { opacity: 1, filter: 'blur(0px)', transform: 'none' };
      if (opening) body.animate([hidden, shown], { duration: Math.round(duration * 0.6), delay: 40, easing: 'ease-out', fill: 'both' });
      else body.animate([shown, hidden], { duration: Math.round(duration * 0.5), easing: 'ease-in', fill: 'both' });
    }
    return opening ? 0 : duration;
  }

  private _menu(): HTMLElement | null {
    return this._root?.querySelector<HTMLElement>('.st-menu') ?? null;
  }

  private _shadow(): HTMLElement | null {
    return this._root?.querySelector<HTMLElement>('.st-menu-shadow') ?? null;
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
    // (the menu opens over the button: the press that opened it lights nothing until it moves)
    if (!this._moved && Math.hypot(ev.clientX - pressAt.x, ev.clientY - pressAt.y) < 8) return;
    this._moved = true;
    this._setActive(this._rowAt(ev.clientX, ev.clientY), true);
  };

  private _onUp = (ev: PointerEvent): void => {
    this._untrack();
    this._ignoreOpenUntil = Date.now() + 400;
    const still = this._openingPress && !this._moved;
    this._openingPress = false;
    const i = still ? -1 : this._rowAt(ev.clientX, ev.clientY);
    if (i >= 0) return this._choose(i);
    this._setActive(-1, false);
    // lifted on its button or on the menu: left open, to tap; anywhere else: closed
    const x = ev.clientX, y = ev.clientY;
    if (!this._inside(this._anchor, x, y, 8) && !this._inside(this._menu()?.getBoundingClientRect(), x, y)) this.close();
  };

  private _onCancel = (): void => {
    this._untrack();
    this._openingPress = false;
    this._ignoreOpenUntil = Date.now() + 400;
    this._setActive(-1, false);
  };

  // open, a finger put down on it: that row lit (no tick - it's where the finger landed), followed from there
  private _onMenuDown = (ev: PointerEvent): void => {
    ev.stopPropagation();
    this._openingPress = false;
    this._moved = true;
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
    color: #000;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
    touch-action: none;
    opacity: 0;
  }
  /* its shadow, beside it (the glass is clipped as it grows, which would take a shadow of its own with it) */
  .st-menu-shadow {
    position: fixed;
    left: 0;
    top: 0;
    z-index: var(--navbar-popup-z-index);
    border-radius: 26px;
    pointer-events: none;
    transform-origin: 0 0;
    opacity: 0;
    box-shadow:
      0 12px 48px rgba(0, 0, 0, 0.2),
      0 0 0 0.5px rgba(0, 0, 0, 0.06);
  }
  .st-menu-shadow:has(+ .st-menu.visible),
  .st-menu-shadow:has(+ .st-menu.closing) {
    opacity: 1;
  }
  .st-menu-shadow:has(+ .st-menu.dark) {
    box-shadow:
      0 12px 48px rgba(0, 0, 0, 0.45),
      0 0 0 0.5px rgba(255, 255, 255, 0.08);
  }
  .st-menu.dark {
    --st-menu-secondary: rgba(235, 235, 245, 0.6);
    --st-menu-highlight: rgba(255, 255, 255, 0.12);
    --st-menu-separator: rgba(84, 84, 88, 0.6);
    background: rgba(37, 37, 40, 0.78);
    color: #fff;
  }
  .st-menu.visible {
    opacity: 1;
  }
  /* (closing: it stays drawn while it goes back into the button) */
  .st-menu.closing {
    opacity: 1;
    pointer-events: none;
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
`;
