import { html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';

import { Color } from '@/components';
import type { BaseRoute } from '@/components/navbar';
import type { NavbarCard } from '@/navbar-card';
import { processBadgeTemplate, processTemplate } from '@/utils';

export class Badge {
  constructor(
    private _navbarCard: NavbarCard,
    private readonly _route: BaseRoute,
  ) {}

  get show(): boolean {
    const badge = this._route.data.badge;
    if (!badge) return false;

    if (badge.show) {
      return (
        processTemplate<boolean>(
          this._navbarCard._hass,
          this._navbarCard,
          badge.show,
        ) ?? false
      );
    }

    if (badge.template) {
      // ⚠️ Deprecated: prefer using `badge.show`
      return processBadgeTemplate(this._navbarCard._hass, badge.template);
    }

    return false;
  }

  get count(): string | number | null {
    return (
      processTemplate<string | number>(
        this._navbarCard._hass,
        this._navbarCard,
        this._route.data.badge?.count,
      ) ?? null
    );
  }

  get icon(): string | null {
    const icon = processTemplate<string>(
      this._navbarCard._hass,
      this._navbarCard,
      this._route.data.badge?.icon,
    );

    return typeof icon === 'string' && icon.trim() !== '' ? icon.trim() : null;
  }

  get backgroundColor(): string {
    return (
      processTemplate<string>(
        this._navbarCard._hass,
        this._navbarCard,
        this._route.data.badge?.color,
      ) ?? 'red'
    );
  }

  /**
   * ST fork: a colour string is a strip of coloured dots under the label, one per comma-separated colour
   * (`var(--purple-color),var(--amber-color)`; commas inside `rgba(...)` etc. kept) - one colour, one dot. `null` for
   * a JS template (`[[[`) or no colour.
   */
  get colors(): string[] | null {
    const result = processTemplate<string>(
      this._navbarCard._hass,
      this._navbarCard,
      this._route.data.badge?.color,
    );
    if (typeof result === 'string' && !result.startsWith('[[[')) {
      const parts = result
        .split(/,(?![^(]*\))/)
        .map((s) => s.trim())
        .filter(Boolean);
      return parts.length ? parts : null;
    }
    return null;
  }

  get textColor(): string | null {
    return (
      processTemplate<string>(
        this._navbarCard._hass,
        this._navbarCard,
        this._route.data.badge?.text_color,
      ) ?? null
    );
  }

  get iconColor(): string | null {
    return (
      processTemplate<string>(
        this._navbarCard._hass,
        this._navbarCard,
        this._route.data.badge?.icon_color,
      ) ?? null
    );
  }

  public render() {
    if (!this.show) return nothing;

    const colors = this.colors;
    if (colors) {
      return html`
        <div class="badge badge-multi ${this._route.selected ? 'active' : ''}">
          ${colors.map((c) => html`<div class="badge-dot" style=${styleMap({ backgroundColor: c })}></div>`)}
        </div>
      `;
    }

    const icon = this.icon;
    const count = this.count;
    const backgroundColor = this.backgroundColor;
    const hasIcon = icon != null;
    const hasCounter = !hasIcon && count != null;
    const configuredForegroundColor = hasIcon
      ? (this.iconColor ?? this.textColor)
      : this.textColor;
    // ST fork: a colour Color can't parse (a CSS variable) no longer throws, which took the whole navbar down
    let foregroundColor = configuredForegroundColor;
    if (foregroundColor == null) {
      try {
        foregroundColor = Color.from(backgroundColor).contrastingColor().hex();
      } catch {
        foregroundColor = 'white';
      }
    }

    return html`
      <div
        class=${classMap({
          active: this._route.selected,
          badge: true,
          'with-counter': hasCounter,
          'with-icon': hasIcon,
        })}
        style=${styleMap({
          backgroundColor,
          color: foregroundColor,
        })}>
        ${
          hasIcon
            ? html`<ha-icon class="badge-icon" .icon=${icon}></ha-icon>`
            : (count ?? nothing)
        }
      </div>
    `;
  }
}
