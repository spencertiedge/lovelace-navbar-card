import { html, nothing, type TemplateResult } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';

import { BaseRoute, Popup } from '@/components/navbar';
import { eventDetection } from '@/lib/event-detection';
import type { NavbarCard } from '@/navbar-card';
import type { PopupItem, RouteItem } from '@/types';
import { processTemplate } from '@/utils';

export class Route extends BaseRoute {
  private _popupInstance?: Popup;

  constructor(
    _navbarCard: NavbarCard,
    private readonly _routeData: RouteItem,
  ) {
    super(_navbarCard, _routeData);
    this._validateRoute();
  }

  get popup(): Popup {
    return (this._popupInstance ??= new Popup(
      this._navbarCard,
      processTemplate<PopupItem[]>(
        this._navbarCard._hass,
        this._navbarCard,
        this._routeData.popup,
      ) ??
        this._routeData.popup ??
        this._routeData.submenu ??
        [],
    ));
  }

  get isSelfOrChildActive(): boolean {
    // If the route is not active, check if any of its children are active (if configured to do so)
    if (
      this._navbarCard.config?.layout?.reflect_child_state &&
      !this.selected
    ) {
      return this.popup.items.some(item => item.selected);
    }

    return this.selected;
  }

  public render(): TemplateResult | null {
    if (this.hidden) return null;

    const isActive = this.isSelfOrChildActive;

    return html`
      <div
        class=${classMap({
          active: isActive,
          route: true,
        })}
        style=${styleMap({
          '--navbar-primary-color': this.selected_color ?? null,
        })}
        ${eventDetection({
          context: this._navbarCard,
          doubleTap: this.double_tap_action,
          hold: this.hold_action,
          route: this,
          tap: this.tap_action ?? {
            action: 'navigate',
            navigation_path: this.url ?? '',
          },
        })}>
        <div
          class=${classMap({
            active: isActive,
            button: true,
          })}
          style=${styleMap({
            '--navbar-primary-color': this.selected_color ?? null,
          })}>
          ${this.icon.render()}
          <ha-ripple></ha-ripple>
          ${this.badge.colors ? nothing : this.badge.render()}
        </div>
        ${
          this.label
            ? html`<div
              class=${classMap({
                active: isActive,
                label: true,
              })}>
              ${this.label}
            </div>`
            : html``
        }
        ${/* ST fork: the colour strip after the label, outside the button */ this.badge.colors ? this.badge.render() : nothing}
        ${this._nativeSelect()}
      </div>
    `;
  }

  /**
   * ST fork: a route whose tap opens its popup, with popup_style native: an invisible <select> over it, so the tap
   * itself opens the system's menu (iOS's web view won't open one from script - no showPicker for a <select>; ST,
   * 2026-10-29: the card's own popup still). Its options are the popup's, made as the finger goes down. Not with a
   * hold or double tap of its own (the <select> takes the touch).
   */
  private _nativeSelect(): TemplateResult | typeof nothing {
    if (
      this._navbarCard.config?.popup_style !== 'native' ||
      this.tap_action?.action !== 'open-popup' ||
      this.hold_action ||
      this.double_tap_action
    )
      return nothing;
    const fill = (ev: Event) => {
      ev.stopPropagation();  // (not the route's own tap: the card's popup too)
      const select = ev.currentTarget as HTMLSelectElement;
      this.popup.fillNative(select, select.parentElement ?? select);
    };
    const stop = (ev: Event) => ev.stopPropagation();
    return html`<select
      class="st-native-select"
      aria-label=${this.label || 'Menu'}
      @pointerdown=${fill}
      @focus=${fill}
      @pointerup=${stop}
      @click=${stop}></select>`;
  }

  private _validateRoute(): void {
    if (!(this.data.icon || this.data.image)) {
      throw new Error(
        'Each route must have either an "icon" or "image" property configured',
      );
    }

    if (
      !(
        this._routeData.popup ||
        this.tap_action ||
        this.hold_action ||
        this.url ||
        this.double_tap_action
      )
    ) {
      throw new Error(
        'Each route must have at least one actionable property (url, popup, tap_action, hold_action, double_tap_action)',
      );
    }

    if (this.tap_action && !this.tap_action.action) {
      throw new Error('"tap_action" must have an "action" property');
    }
    if (this.hold_action && !this.hold_action.action) {
      throw new Error('"hold_action" must have an "action" property');
    }
    if (this.double_tap_action && !this.double_tap_action.action) {
      throw new Error('"double_tap_action" must have an "action" property');
    }
  }
}
