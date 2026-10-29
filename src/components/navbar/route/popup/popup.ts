import { type CSSResult, css, html } from 'lit';
import { classMap } from 'lit/directives/class-map.js';

import { PopupItem } from '@/components/navbar';
import { StMenu } from '@/components/navbar/route/popup/st-menu';
import { executeAction } from '@/lib/action-handler';
import { processTemplate } from '@/utils';
import type { NavbarCard } from '@/navbar-card';
import { DesktopPosition, type PopupItem as PopupItemDef } from '@/types';

export class Popup {
  private _popupItems: PopupItem[] = [];
  private _backdropClickListener?: (e: Event) => void;
  private _menu?: StMenu;

  constructor(
    private _navbarCard: NavbarCard,
    _popupItemData: PopupItemDef[],
  ) {
    _popupItemData.forEach((_itemData, _index) => {
      this._popupItems.push(
        new PopupItem(this._navbarCard, this, _itemData, _index),
      );
    });
  }

  get items(): PopupItem[] {
    return this._popupItems;
  }

  get backdrop(): HTMLElement | null {
    return (
      this._navbarCard.shadowRoot?.querySelector('.navbar-popup-backdrop') ??
      null
    );
  }

  /** ST fork: the popup as iOS's menu (popup_style: menu) */
  get menu(): StMenu {
    return (this._menu ??= new StMenu(this._navbarCard, this));
  }

  public open(target: HTMLElement): void {
    if (this._navbarCard.config?.popup_style === 'menu') return this.menu.open(target);
    if (this._navbarCard.config?.popup_style === 'native' && this._openNative(target)) return;
    this._openOwn(target);
  }

  /** The card's own popup (upstream's) */
  private _openOwn(target: HTMLElement): void {
    const anchorRect = target.getBoundingClientRect();

    const { style, labelPositionClassName, popupDirectionClassName } =
      this._getPopupStyles(
        anchorRect,
        !this._navbarCard.isDesktop
          ? 'mobile'
          : (this._navbarCard.config?.desktop?.position ??
              DesktopPosition.bottom),
      );

    const popupStaggerStep = this._getPopupStaggerStepSeconds(
      this.items.length,
    );

    this._navbarCard.focusedPopup = html`
      <div class="navbar-popup-backdrop"></div>
      <div
        class=${classMap({
          'navbar-popup': true,
          [popupDirectionClassName]: true,
          [labelPositionClassName]: true,
          desktop: this._navbarCard.isDesktop ?? false,
          mobile: !this._navbarCard.isDesktop,
          popuplabelbackground: this._shouldShowLabelBackground(),
        })}
        style="${style}; --popup-item-stagger-step: ${popupStaggerStep}s;">
        ${this.items
          .map(popupItem =>
            popupItem.render(popupDirectionClassName, labelPositionClassName),
          )
          .filter(x => x != null)}
      </div>
    `;

    // Trigger animations after element is rendered
    requestAnimationFrame(() => {
      const popup = this._navbarCard.shadowRoot?.querySelector('.navbar-popup');
      const backdrop = this._navbarCard.shadowRoot?.querySelector(
        '.navbar-popup-backdrop',
      );
      if (popup && backdrop) {
        popup.classList.add('visible');
        backdrop.classList.add('visible');
      }
    });
    // Add Escape key listener when popup is opened
    window.addEventListener('keydown', this._onPopupKeyDownListener);

    // Add click listener to backdrop after a short delay, to prevent a recurring issue
    // where the popup is closed right after being opened. This happens because the click
    // event that opens the popup, bubbles up the DOM up to this backdrop, even with
    // preventDefault or stopPropagation :(
    setTimeout(() => {
      if (this.backdrop) {
        // Store reference for cleanup
        this._backdropClickListener = (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        };
        this.backdrop.addEventListener('click', this._backdropClickListener);
      }
    }, 400);
  }

  /**
   * ST fork: the popup as the system's menu - a <select> laid over the button it opens from (where iOS anchors its
   * pop-up menu), shown with showPicker(). For a hold's popup: a tap's is the route's own <select> (Route.render),
   * the finger's tap itself opening it - iOS's web view has no showPicker for a <select>, or won't use it (ST,
   * 2026-10-29: the card's own popup still). iOS opens it only straight after a tap or a finger lifting: a hold's
   * popup (opened while the finger's still down) waits for the lift. False where it can't be done here (no
   * showPicker): the card's own popup instead.
   */
  private _openNative(target: HTMLElement): boolean {
    const root = this._navbarCard.shadowRoot;
    if (!root || !this.items.some(item => !item.hidden)) return false;
    let select = root.querySelector<HTMLSelectElement>('select.st-native-popup');
    if (!select) {
      select = document.createElement('select');
      select.className = 'st-native-popup';
      select.setAttribute('aria-hidden', 'true');
      select.tabIndex = -1;
      root.append(select);
    }
    if (typeof select.showPicker !== 'function') return false;
    const r = target.getBoundingClientRect();
    Object.assign(select.style, {
      position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
      opacity: '0', pointerEvents: 'none', zIndex: '-1', border: '0', margin: '0', padding: '0', fontSize: '16px',
    });
    this.fillNative(select, target);
    try {
      select.showPicker();
    } catch {
      // (no user activation: a hold, its finger still down - opened as it lifts)
      const lifted = () => {
        try {
          select.showPicker();
        } catch {
          this._openOwn(target);  // (the system wouldn't: the card's own)
        }
      };
      window.addEventListener('pointerup', lifted, { capture: true, once: true });
    }
    return true;
  }

  /**
   * ST fork: a <select>'s options made this popup's items: each item under its section's heading (an optgroup),
   * the current one selected (iOS's checkmark) - when none is, none selected (selectedIndex -1, so any choice is a
   * change; not a hidden placeholder, which iOS's menu shows anyway: a blank first row with the checkmark, ST
   * 2026-10-29). Choosing one runs that item's tap action, as a tap on it would.
   */
  public fillNative(select: HTMLSelectElement, target: HTMLElement): void {
    const items = this.items.filter(item => !item.hidden);
    select.replaceChildren();
    const current = items.findIndex(item => item.selected);
    let group: HTMLElement = select, section: string | undefined;
    items.forEach((item, i) => {
      const s = item.data.section;
      if (s !== section) {
        section = s;
        if (s) {
          group = document.createElement('optgroup');
          (group as HTMLOptGroupElement).label = s;
          select.append(group);
        } else group = select;
      }
      const option = document.createElement('option');
      option.value = String(i);
      // (its label whatever the navbar's show_labels: a menu of names)
      option.textContent =
        processTemplate<string>(this._navbarCard._hass, this._navbarCard, item.data.label) || item.url || '';
      option.selected = i === current;
      group.append(option);
    });
    select.selectedIndex = current;  // (after the options: adding them chose the first)
    select.onchange = () => {
      const item = items[Number(select.value)];
      if (!item) return;
      executeAction({
        action: item.tap_action,  // (none: a page, gone to by its url, as a tap on it would)
        actionType: 'tap',
        context: this._navbarCard,
        data: { popupItem: item },
        target,
      });
    };
  }

  public close(): void {
    if (this._menu?.isOpen) return this._menu.close();
    const popup = this._navbarCard.shadowRoot?.querySelector('.navbar-popup');

    // Remove backdrop listener
    if (this._backdropClickListener && this.backdrop) {
      this.backdrop.removeEventListener('click', this._backdropClickListener);
      this._backdropClickListener = undefined;
    }

    if (popup && this.backdrop) {
      popup.classList.remove('visible');
      this.backdrop.classList.remove('visible');

      // Wait for transitions to complete before removing
      setTimeout(() => {
        this._navbarCard.focusedPopup = null;
      }, 200);
    } else {
      this._navbarCard.focusedPopup = null;
    }
    // Remove Escape key listener when popup is closed
    window.removeEventListener('keydown', this._onPopupKeyDownListener);
  }

  protected _shouldShowLabelBackground = (): boolean => {
    const enabled = this._navbarCard.isDesktop
      ? this._navbarCard.config?.desktop?.show_popup_label_backgrounds
      : this._navbarCard.config?.mobile?.show_popup_label_backgrounds;
    return !!enabled;
  };

  private _getPopupStaggerStepSeconds(itemsCount: number): number {
    const maxTotalStaggerDelaySeconds = 0.25;
    const minStepSeconds = 0.01;
    const maxStepSeconds = 0.05;
    const staggeredTransitions = Math.max(itemsCount - 1, 1);
    const dynamicStep = maxTotalStaggerDelaySeconds / staggeredTransitions;

    return Math.max(minStepSeconds, Math.min(maxStepSeconds, dynamicStep));
  }

  /**
   * Get the styles for the popup based on its position relative to the anchor element.
   */
  private _getPopupStyles(
    anchorRect: DOMRect,
    position: 'top' | 'left' | 'bottom' | 'right' | 'mobile',
  ): {
    style: CSSResult;
    labelPositionClassName: string;
    popupDirectionClassName: string;
  } {
    const { top, left, x, width, height } = anchorRect;
    const windowWidth = window.innerWidth;

    const positions: Record<
      typeof position,
      { style: CSSResult; label: string; dir: string } | null
    > = {
      bottom: null,
      left: {
        dir: 'open-right',
        label: 'label-bottom',
        style: css`
          top: ${top}px;
          left: ${x + width}px;
        `,
      },
      mobile: null,
      right: {
        dir: 'open-left',
        label: 'label-bottom',
        style: css`
          top: ${top}px;
          right: ${windowWidth - x}px;
        `,
      },
      top: {
        dir: 'open-bottom',
        label: 'label-right',
        style: css`
          top: ${top + height}px;
          left: ${x}px;
        `,
      },
    };

    if (positions[position]) {
      return {
        labelPositionClassName: positions[position].label,
        popupDirectionClassName: positions[position].dir,
        style: positions[position].style,
      };
    }

    // fallback for bottom/mobile
    const isRightSide = x > windowWidth / 2;
    return isRightSide
      ? {
          labelPositionClassName: 'label-left',
          popupDirectionClassName: 'open-up',
          style: css`
            top: ${top}px;
            right: ${windowWidth - x - width}px;
          `,
        }
      : {
          labelPositionClassName: 'label-right',
          popupDirectionClassName: 'open-up',
          style: css`
            top: ${top}px;
            left: ${left}px;
          `,
        };
  }

  private _onPopupKeyDownListener = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && this._navbarCard.focusedPopup) {
      e.preventDefault();
      this.close();
    }
  };
}
