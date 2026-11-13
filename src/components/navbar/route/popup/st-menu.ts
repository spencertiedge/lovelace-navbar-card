import { css, html, nothing, type TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';

import { PopupItem, type Popup } from '@/components/navbar';
import { executeAction } from '@/lib/action-handler';
import type { PopupItem as PopupItemDef } from '@/types';
import type { NavbarCard } from '@/navbar-card';
import { fireDOMEvent, processTemplate } from '@/utils';

/**
 * ST fork: popup_style menu - a route's popup drawn as iOS's menu (ST, 2026-10-29: the system's own, a <select>'s,
 * takes nothing but names; wanted "more detail than just the name", drag to select and haptics). Opens on the press
 * (a tap's from the route's pointerdown, a hold's as the hold fires, the finger still down); the finger dragged
 * along it lights the row under it, a haptic tick each time that changes (Home Assistant's app plays the window's
 * `haptic` events); lifting on a row chooses it, on the button or the menu leaves it open to tap, elsewhere closes
 * it. Rows: a checkmark on the current one, label, an optional detail line (`detail`, templatable), icon on the right;
 * sections (`section`) under headings. A row with a `submenu` (ST, 2026-11-13) shows a › and opens its rows in the
 * same menu, a ‹ Back row (the row's own label) over them; the glass resizes and the rows slide in from the side, as
 * iOS's nested menus.
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

const CHEVRON = (left: boolean) => html`<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d=${left ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"
    stroke-linejoin="round" />
</svg>`;
// a row's data-i for the Back row of a submenu
const BACK = -2;

const CHECK = html`<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"
    stroke-linejoin="round" />
</svg>`;

// iOS's spring, as CSS's linear() easing: `response` (s) and damping ratio; its duration is when it has settled
const spring = (response: number, damping: number): { easing: string; duration: number } => {
  const w = (2 * Math.PI) / response, wd = w * Math.sqrt(Math.max(1 - damping * damping, 0));
  // (critically damped, wd 0: its own form - the general one divides by it, NaN, and animate() throws on the easing)
  const x = (t: number) =>
    wd < 1e-6
      ? 1 - Math.exp(-w * t) * (1 + w * t)
      : 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
  let duration = response;
  while (duration < 2 && Math.exp(-damping * w * duration) > 0.002) duration += 0.02;
  const n = 48, points = Array.from({ length: n + 1 }, (_, i) => (i === n ? 1 : x((duration * i) / n)).toFixed(4));
  return { easing: `linear(${points.join(', ')})`, duration: Math.round(duration * 1000) };
};
const OPEN = spring(0.36, 1);  // (the glass's outline: no bounce - a clip past its box shows nothing)
const STRETCH = spring(0.43, 0.6);  // (the stretch: past its size toward where it grows, then back - iOS 26's liquid)
const CLOSE = OPEN;  // (as long as it took to open: ST, 2026-10-30)
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// the screen's safe area (the status bar, the camera's cutout, the home bar): a probe padded by env()'s insets
const safeArea = (): { top: number; right: number; bottom: number; left: number } => {
  const probe = document.createElement('div');
  probe.dataset.stSafeArea = '';
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe), px = (v: string) => parseFloat(v) || 0;
  const inset = { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  probe.remove();
  return inset;
};
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
  // where its glass starts: a capsule the button's size on the menu's edge by the button (insets of its box)
  private _from = '';
  private _cap?: { left: number; top: number; width: number; height: number };
  private _radius = 26;
  // (a submenu showing) the rows it opened with, to go back to, and the row's label for the Back row
  private _top: PopupItem[] | null = null;
  private _subTitle = '';
  // (a submenu showing) where the row that opened it was: its top, and the menu's right edge
  private _subAt?: { top: number; right: number };

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
    this._top = null;
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
      // (opened again before the last one was taken away: the same element, still closing)
      const menu = this._menu();
      menu?.classList.remove('closing');
      for (const el of [menu, this._shadow(), menu?.querySelector('.st-menu-body')])
        (el as HTMLElement | null)?.getAnimations?.().forEach(an => an.cancel());
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
      const sub = !!item.data.submenu?.length;
      return html`${heading}<div
          class=${classMap({ 'st-menu-row': true, current: item.selected, 'st-menu-opens': sub })}
          role="menuitem"
          aria-haspopup=${sub ? 'menu' : nothing}
          data-i=${i}>
          ${checks ? html`<span class="st-menu-check">${item.selected ? CHECK : nothing}</span>` : nothing}
          <span class="st-menu-text">
            <span class="st-menu-label">${label}</span>
            ${detail ? html`<span class="st-menu-detail">${detail}</span>` : nothing}
          </span>
          ${icon ? html`<ha-icon class="st-menu-icon" icon=${icon}></ha-icon>` : nothing}
          ${sub ? html`<span class="st-menu-more">${CHEVRON(false)}</span>` : nothing}
        </div>`;
    });
    // (a submenu: its Back row first, the row's own label beside a ‹)
    const back = this._top
      ? html`<div class="st-menu-row st-menu-back" role="menuitem" aria-label=${`Back to ${this._subTitle}`} data-i=${BACK}>
            <span class="st-menu-more">${CHEVRON(true)}</span>
            <span class="st-menu-text"><span class="st-menu-label">${this._subTitle}</span></span>
          </div><div class="st-menu-gap"></div>`
      : nothing;
    return html`<div class="st-menu-backdrop" @pointerdown=${this._onBackdropDown}></div>
      <div class="st-menu-shadow"></div>
      <div
        class=${classMap({ 'st-menu': true, dark: !!(hass?.themes as { darkMode?: boolean } | undefined)?.darkMode })}
        role="menu"
        @pointerdown=${this._onMenuDown}
        @pointermove=${this._onHover}
        @pointerleave=${this._onLeave}>
        <div class="st-menu-body">${back}${rows}</div>
      </div>`;
  }

  /** Over its button, as iOS 26's: it shares the button's edges, the one toward the bar's own edge of the screen (a
   * bottom bar's: its bottom; a top one's: its top; a rail's: its top) and the one toward the screen's nearer side,
   * and grows from there toward the middle (a button in the middle third: centred on it) */
  private _place(at?: { top: number; right: number }): void {
    const menu = this._menu(), a = this._anchor;
    if (!menu || !a) return;
    const M = 8, vw = window.innerWidth, vh = window.innerHeight;
    // (kept inside the safe area: a button in the status bar's strip - the outside display's rail or menu button - has
    // the camera's cutout beside it; ST, 2026-10-30)
    const safe = safeArea();
    const minX = M + safe.left, maxX = (w: number) => vw - w - M - safe.right;
    const minY = M + safe.top, maxY = (h: number) => vh - h - M - safe.bottom;
    const bar = this._target?.parentElement?.getBoundingClientRect();
    const rail = !!bar && bar.height > bar.width;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
    let w = menu.offsetWidth, h = menu.offsetHeight, top: number;
    if (rail) {
      if (h > maxY(0) - minY) {
        menu.style.maxHeight = `${maxY(0) - minY}px`;
        h = menu.offsetHeight;
      }
      top = clamp(a.top, minY, maxY(h));
    } else {
      const up = a.top + a.height / 2 > vh / 2;
      const room = up ? a.bottom - minY : maxY(0) - a.top;
      if (h > room) {
        menu.style.maxHeight = `${Math.max(room, 120)}px`;
        h = menu.offsetHeight;
      }
      top = clamp(up ? a.bottom - h : a.top, minY, maxY(h));
    }
    // (a submenu: from the row that opened it - its Back row where that row was, the menu's own edge kept - growing
    // down, kept on screen: ST, 2026-11-13, not dropped to the button)
    if (at) {
      if (h > maxY(0) - minY) {
        menu.style.maxHeight = `${maxY(0) - minY}px`;
        h = menu.offsetHeight;
      }
      top = clamp(at.top, minY, maxY(h));
    }
    const mid = a.left + a.width / 2;
    const side = rail ? (mid < vw / 2 ? 'left' : 'right') : mid < vw / 3 ? 'left' : mid > (2 * vw) / 3 ? 'right' : 'centre';
    const left = at ? clamp(at.right - w, minX, maxX(w))
      : clamp(side === 'left' ? a.left : side === 'right' ? a.right - w : mid - w / 2, minX, maxX(w));
    w = menu.offsetWidth;
    for (const el of [menu, this._shadow()]) {
      if (!el) continue;
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
    // the glass starts as the button's capsule (where it is, inside the menu's box)
    const cw = Math.min(a.width, w), ch = Math.min(a.height, h);
    const x = clamp(a.left - left, 0, w - cw), y = clamp(a.top - top, 0, h - ch);
    this._cap = { left: left + x, top: top + y, width: cw, height: ch };
    this._from = `inset(${y}px ${w - x - cw}px ${h - y - ch}px ${x}px round ${Math.min(cw, ch) / 2}px)`;
    this._radius = parseFloat(getComputedStyle(menu).borderTopLeftRadius) || 26;
    const body = menu.querySelector<HTMLElement>('.st-menu-body');
    menu.style.transformOrigin = `${x + cw / 2}px ${y + ch / 2}px`;
    if (body) body.style.transformOrigin = `${x + cw / 2}px ${y + ch / 2}px`;
    // (a menu that scrolls lets the finger scroll it; one that doesn't keeps the drag)
    if (menu.scrollHeight > menu.clientHeight + 1) menu.style.touchAction = 'pan-y';
  }

  /** iOS 26's menu: the button's glass grows into the menu (a spring, a little bounce), its rows coming in out of a
   * blur; closing, it goes back into the button. Returns how long that takes (ms); an animation that fails is
   * skipped (never a menu left on screen that can't be used or closed) */
  private _morph(opening: boolean): number {
    const menu = this._menu();
    if (!menu) return 0;
    menu.classList.toggle('visible', opening);
    try {
      return this._animate(menu, opening);
    } catch (err) {
      console.warn('navbar-card: menu animation', err);
      return 0;
    }
  }

  private _animate(menu: HTMLElement, opening: boolean): number {
    const shadow = this._shadow(), a = this._cap;
    if (!canAnimate(menu) || !a || !this._from) return 0;
    const full = `inset(0px 0px 0px 0px round ${this._radius}px)`;
    const body = menu.querySelector<HTMLElement>('.st-menu-body');
    if (reducedMotion()) {
      const fade = [{ opacity: 0 }, { opacity: 1 }];
      menu.animate(opening ? fade : fade.reverse(), { duration: 150, fill: opening ? 'backwards' : 'both' });
      return 150;
    }
    const { easing, duration } = opening ? OPEN : CLOSE;
    // opening: held at its first frame only - once done the menu is its own style again (held at the last, WebKit
    // left the rows' blur drawn after it had ended); closing: held at the last, until it's taken away
    const fill: FillMode = opening ? 'backwards' : 'both';
    const glass = [{ clipPath: this._from }, { clipPath: full }];
    menu.animate(opening ? glass : [...glass].reverse(), { duration, easing, fill });
    // stretched out of the button (more along the way it grows), past its size, back: from the button, so it pulls
    const pulled = { transform: 'scale(0.85, 0.55)' }, settled = { transform: 'none' };
    if (opening) menu.animate([pulled, settled], { duration: STRETCH.duration, easing: STRETCH.easing, fill });
    else menu.animate([settled, pulled], { duration, easing, fill });
    if (canAnimate(shadow)) {
      const r = shadow.getBoundingClientRect();
      const sx = a.width / Math.max(r.width, 1), sy = a.height / Math.max(r.height, 1);
      const small = { transform: `translate(${a.left - r.left}px, ${a.top - r.top}px) scale(${sx}, ${sy})`, opacity: 0 };
      const big = { transform: 'none', opacity: 1 };
      shadow.animate(opening ? [small, big] : [big, small], { duration, easing, fill });
    }
    if (canAnimate(body)) {
      // the rows smeared along the stretch, sharp as it settles
      const smeared = { opacity: 0, filter: 'blur(12px)', transform: 'scale(0.9, 1.5)' };
      const settling = { offset: 0.55, opacity: 1, filter: 'blur(3px)', transform: 'scale(1, 1.08)' };
      const sharp = { opacity: 1, filter: 'blur(0px)', transform: 'none' };
      if (opening) {
        const rows = body.animate([smeared, settling, sharp], { duration: Math.round(STRETCH.duration * 0.6), delay: 30, easing: 'ease-out', fill });
        // (and once it's ended, nothing of it left on the rows: WebKit can keep a filter's last frame drawn)
        rows.finished?.then(() => rows.cancel(), () => {});
      }
      else body.animate([sharp, smeared], { duration: Math.round(duration * 0.6), easing: 'ease-in', fill: 'both' });
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
    if (tick && (i >= 0 || i === BACK)) fireDOMEvent(window, 'haptic', { detailOverride: 'selection' });
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
    // (the press that opened it lights nothing until it moves)
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
    if (i >= 0 || i === BACK) return this._choose(i);
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
      if (this._top) this._back();  // (a submenu: back to the menu it came from)
      else this.close();
    }
  };

  private _choose(i: number): void {
    if (i === BACK) return this._back();
    const item = this._items[i];
    // a row that opens a submenu: its rows, in this menu
    if (item?.data.submenu?.length) return this._enter(item);
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

  /** A row's submenu: its rows shown in this menu, a Back row over them */
  private _enter(item: PopupItem): void {
    const hass = this._navbarCard._hass;
    const row = this._root?.querySelector<HTMLElement>(`.st-menu-row[data-i="${this._items.indexOf(item)}"]`);
    const r = row?.getBoundingClientRect(), m = this._menu()?.getBoundingClientRect();
    this._subAt = r && m ? { top: r.top, right: m.right } : undefined;
    this._top = this._items;
    this._subTitle = processTemplate<string>(hass, this._navbarCard, item.data.label) || '';
    this._items = ((item.data.submenu ?? []) as PopupItemDef[])
      .map((data, k) => new PopupItem(this._navbarCard, this._popup, data, k))
      .filter(x => !x.hidden);
    this._swap(1);
  }

  /** Back to the rows it came from */
  private _back(): void {
    if (!this._top) return;
    this._items = this._top;
    this._top = null;
    this._swap(-1);
  }

  /** The rows changed in place: the glass resized (from its old box to its new one) and the rows slid in from the side
   * they come from (forward: the right; back: the left), a haptic tick */
  private _swap(dir: 1 | -1): void {
    const was = this._menu()?.getBoundingClientRect();
    this._active = -1;
    this._navbarCard.focusedPopup = this._render();
    fireDOMEvent(window, 'haptic', { detailOverride: 'selection' });
    this._navbarCard.updateComplete.then(() => {
      const m = this._menu();
      if (!m) return;
      for (const el of [m, this._shadow()]) {
        if (!el) continue;
        el.style.width = '';
        el.style.height = '';
        el.style.maxHeight = '';
      }
      // (a submenu: its Back row where the row that opened it was; back: where the menu first opened)
      const back = this._top ? m.querySelector<HTMLElement>('.st-menu-back') : null;
      if (back && this._subAt) {
        const off = back.getBoundingClientRect().top - m.getBoundingClientRect().top;
        this._place({ top: this._subAt.top - off, right: this._subAt.right });
      } else this._place();
      if (reducedMotion()) return;
      const now = m.getBoundingClientRect();
      try {
        const ease = { duration: 300, easing: 'cubic-bezier(.32, .72, 0, 1)' };
        const box = (r: DOMRect) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        if (was && canAnimate(m)) m.animate([box(was), box(now)], ease);
        const sh = this._shadow();
        if (was && canAnimate(sh)) sh.animate([box(was), box(now)], ease);
        const body = m.querySelector<HTMLElement>('.st-menu-body');
        if (canAnimate(body))
          body.animate([{ transform: `translateX(${dir * 28}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], {
            duration: 280,
            easing: 'cubic-bezier(.32, .72, 0, 1)',
          });
      } catch (err) {
        console.warn('navbar-card: submenu animation', err);
      }
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
  /* a row's submenu: a › at its end; the submenu's Back row: a ‹ and the row's label, in bold */
  .st-menu-more {
    flex: none;
    display: flex;
    width: 16px;
    color: var(--st-menu-secondary);
  }
  .st-menu-more svg {
    width: 16px;
    height: 16px;
  }
  .st-menu-back .st-menu-label {
    font-weight: 600;
  }
  .st-menu-back .st-menu-more {
    color: inherit;
  }
  .st-menu-section {
    padding: 6px 20px 2px;
    font-size: 13px;
    line-height: 18px;
    color: var(--st-menu-secondary);
  }
`;
