import type { HassEntity } from 'home-assistant-js-websocket';
import { html, nothing } from 'lit';
import { classMap } from 'lit/directives/class-map.js';
import { keyed } from 'lit/directives/keyed.js';

import { eventDetection } from '@/lib/event-detection';
import type { NavbarCard } from '@/navbar-card';
import {
  DEFAULT_NAVBAR_CONFIG,
  type MediaPlayerPlayerConfig,
  type WidgetPosition,
} from '@/types';
import { preventEventDefault, processTemplate } from '@/utils';

const CAROUSEL_GAP = 12;

export class MediaPlayer {
  private _activeIndex = 0;
  private _trackPointerId: number | null = null;
  private _dragStartX = 0;
  private _dragStartT = 0;
  private _dragOffset = 0;
  private _isDragging = false;
  /** Playback position per entity, recomputed only when HA reports a new one */
  private _progressAnchors = new Map<
    string,
    { key: string; position: number }
  >();

  constructor(private readonly _navbarCard: NavbarCard) {}

  get desktop_position(): WidgetPosition {
    return (
      this._navbarCard.config?.media_player?.desktop_position ??
      DEFAULT_NAVBAR_CONFIG.media_player.desktop_position
    );
  }

  /**
   * Check if the media player widget should be shown.
   */
  public isVisible = (): { visible: boolean; error?: string } => {
    const config = this._navbarCard.config?.media_player;
    const players = config?.players ?? [];
    if (players.length === 0) return { visible: false };

    if (config?.show != null) {
      const widgetVisible = processTemplate<boolean>(
        this._navbarCard._hass,
        this._navbarCard,
        config.show,
      );
      if (!widgetVisible) return { visible: false };
    }

    for (const player of players) {
      const result = this._isPlayerVisible(player);
      if (result.visible || result.error) return result;
    }
    return { visible: false };
  };

  /**
   * Render either a single media-player card or a carousel of media-player cards.
   */
  public render = (options: { isInsideNavbar: boolean }) => {
    const { visible } = this.isVisible();
    if (!visible) return html``;

    const allPlayers = this._navbarCard.config?.media_player?.players ?? [];
    const visiblePlayers = allPlayers.filter(
      p => this._isPlayerVisible(p).visible,
    );

    this._activeIndex = Math.max(
      0,
      Math.min(this._activeIndex, visiblePlayers.length - 1),
    );

    if (visiblePlayers.length <= 1) {
      return this._renderSingle(visiblePlayers[0], options);
    }
    return this._renderCarousel(visiblePlayers, options);
  };

  /**
   * Check if one specific player should be shown.
   */
  private _isPlayerVisible(player: MediaPlayerPlayerConfig): {
    visible: boolean;
    error?: string;
  } {
    const entity = this._resolveEntity(player);
    const state = this._navbarCard._hass.states[entity ?? ''];

    if (!(state && entity)) {
      return { error: `Entity not found "${entity}"`, visible: true };
    }

    if (player.show != null) {
      return {
        visible: processTemplate<boolean>(
          this._navbarCard._hass,
          this._navbarCard,
          player.show,
        ),
      };
    }

    return { visible: ['playing', 'paused'].includes(state.state) };
  }

  /**
   * Resolve the entity ID for a player.
   */
  private _resolveEntity(player: MediaPlayerPlayerConfig): string | null {
    return processTemplate<string>(
      this._navbarCard._hass,
      this._navbarCard,
      player.entity,
    );
  }

  private _resolveIcon(player: MediaPlayerPlayerConfig): string | null {
    return player.icon
      ? processTemplate<string>(
          this._navbarCard._hass,
          this._navbarCard,
          player.icon,
        )
      : null;
  }

  /**
   * Resolve the title for a player. Falls back to the media_title attribute.
   */
  private _resolveTitle(
    player: MediaPlayerPlayerConfig,
    state: HassEntity,
  ): string {
    return player.title
      ? processTemplate<string>(
          this._navbarCard._hass,
          this._navbarCard,
          player.title,
        )
      : (state.attributes.media_title ?? '');
  }

  /**
   * Resolve the subtitle for a player. Falls back to the media_artist attribute.
   */
  private _resolveSubtitle(
    player: MediaPlayerPlayerConfig,
    state: HassEntity,
  ): string {
    return player.subtitle
      ? processTemplate<string>(
          this._navbarCard._hass,
          this._navbarCard,
          player.subtitle,
        )
      : (state.attributes.media_artist ?? '');
  }

  private _handlePlayPause = (e: MouseEvent, entity: string) => {
    e.preventDefault();
    e.stopPropagation();
    const state = this._navbarCard._hass.states[entity];
    if (!state) return;
    const action = state.state === 'playing' ? 'media_pause' : 'media_play';
    this._navbarCard._hass.callService('media_player', action, {
      entity_id: entity,
    });
  };

  /** ST fork: previous, shuffle (toggle) and repeat (off -> all -> one -> off). */
  private _handleExtra = (
    e: MouseEvent,
    entity: string,
    kind: 'prev' | 'shuffle' | 'repeat',
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const hass = this._navbarCard._hass;
    const a = hass.states[entity]?.attributes ?? {};
    if (kind === 'prev') {
      hass.callService('media_player', 'media_previous_track', { entity_id: entity });
    } else if (kind === 'shuffle') {
      hass.callService('media_player', 'shuffle_set', { entity_id: entity, shuffle: !a.shuffle });
    } else {
      const next: Record<string, string> = { off: 'all', all: 'one', one: 'off' };
      hass.callService('media_player', 'repeat_set', { entity_id: entity, repeat: next[a.repeat] ?? 'all' });
    }
  };

  private _handleSkipNext = (e: MouseEvent, entity: string) => {
    e.preventDefault();
    e.stopPropagation();
    this._navbarCard._hass.callService('media_player', 'media_next_track', {
      entity_id: entity,
    });
  };

  private _onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this._trackPointerId = e.pointerId;
    this._dragStartX = e.clientX;
    this._dragStartT = performance.now();
    this._dragOffset = 0;
    this._isDragging = false;
  };

  private _onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== this._trackPointerId) return;
    const dx = e.clientX - this._dragStartX;

    if (!this._isDragging) {
      if (Math.abs(dx) < 10) return;
      this._isDragging = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }

    e.preventDefault();
    // ST fork: the players shown (a hidden one isn't a slide), not every one configured
    const count = (e.currentTarget as HTMLElement).querySelectorAll(
      '.media-player-track > .media-player',
    ).length;
    const atEdge =
      (this._activeIndex === 0 && dx > 0) ||
      (this._activeIndex === count - 1 && dx < 0);
    this._dragOffset = atEdge ? dx * 0.2 : dx;
    this._navbarCard.requestUpdate();
  };

  private _onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== this._trackPointerId) return;
    this._trackPointerId = null;

    if (!this._isDragging) return;

    const el = e.currentTarget as HTMLElement;
    el.releasePointerCapture(e.pointerId);

    // ST fork: a short drag (48 px) or a flick switches, not 30% of the width
    const dt = Math.max(1, performance.now() - this._dragStartT);
    const flick =
      Math.abs(this._dragOffset) > 16 && Math.abs(this._dragOffset) / dt > 0.35;
    const threshold = flick ? 16 : Math.min(48, el.offsetWidth * 0.3);
    // ST fork: the players shown (a hidden one isn't a slide), not every one configured
    const count = (e.currentTarget as HTMLElement).querySelectorAll(
      '.media-player-track > .media-player',
    ).length;

    if (this._dragOffset < -threshold && this._activeIndex < count - 1) {
      this._activeIndex++;
    } else if (this._dragOffset > threshold && this._activeIndex > 0) {
      this._activeIndex--;
    }

    this._dragOffset = 0;
    this._isDragging = false;
    this._navbarCard.requestUpdate();
  };

  private _onPointerCancel = (e: PointerEvent) => {
    if (e.pointerId !== this._trackPointerId) return;
    this._trackPointerId = null;
    this._isDragging = false;
    this._dragOffset = 0;
    this._navbarCard.requestUpdate();
  };

  /**
   * Render a single media-player card.
   */
  private _renderSingle(
    player: MediaPlayerPlayerConfig,
    options: { isInsideNavbar: boolean },
  ) {
    const entity = this._resolveEntity(player);
    const state = this._navbarCard._hass.states[entity ?? ''];

    if (!(state && entity)) {
      return html`<ha-card class="media-player error">
        <ha-alert alert-type="error">Entity not found "${entity}"</ha-alert>
      </ha-card>`;
    }

    const deviceClass = this._navbarCard.isDesktop ? 'desktop' : 'mobile';

    // ST fork: in a wrapper (it's placed and styled; the card inside clips to the pill)
    return html`
      <div
        class="${classMap({
          'media-player-wrapper': true,
          'position-absolute': !options.isInsideNavbar,
          [(
            this.desktop_position ??
            DEFAULT_NAVBAR_CONFIG.media_player.desktop_position
          ).toString()]: true,
          [deviceClass]: true,
        })}">
        <ha-card
          class="${classMap({
            'media-player': true,
            [deviceClass]: true,
          })}"
          ${eventDetection({
            context: this._navbarCard,
            doubleTap: player.double_tap_action,
            hold: player.hold_action,
            tap: player.tap_action ?? { action: 'more-info', entity },
          })}>
          ${this._renderCardContent(player, entity, state)}
        </ha-card>
      </div>
    `;
  }

  /**
   * Render the multi-player carousel.
   */
  private _renderCarousel(
    players: MediaPlayerPlayerConfig[],
    options: { isInsideNavbar: boolean },
  ) {
    const deviceClass = this._navbarCard.isDesktop ? 'desktop' : 'mobile';
    const transition = this._isDragging ? 'none' : 'transform 0.3s ease-out';
    // ST fork: placed by --st-slide-w (a navbar's styles can narrow the slides) and --st-peek (the last one's offset);
    // unset, as upstream
    const atEnd =
      this._activeIndex === players.length - 1 && players.length > 1;
    const transform = `translateX(calc(${-this._activeIndex} * (var(--st-slide-w, 100%) + ${CAROUSEL_GAP}px) + ${atEnd ? 'var(--st-peek, 0px)' : '0px'} + ${this._dragOffset}px))`;

    return html`
      <div
        class="${classMap({
          'media-player-carousel': true,
          'at-end': this._activeIndex === players.length - 1 && players.length > 1,
          'position-absolute': !options.isInsideNavbar,
          [(
            this.desktop_position ??
            DEFAULT_NAVBAR_CONFIG.media_player.desktop_position
          ).toString()]: true,
          [deviceClass]: true,
        })}">
        <div
          class="media-player-viewport"
          @pointerdown=${this._onPointerDown}
          @pointermove=${this._onPointerMove}
          @pointerup=${this._onPointerUp}
          @pointercancel=${this._onPointerCancel}>
          <div
            class="media-player-track"
            style="transform: ${transform}; transition: ${transition}">
            ${players.map(p => this._renderSlide(p))}
          </div>
        </div>
        ${players.length > 1 ? this._renderNext(players) : nothing}
        <div class="media-player-dots">
          ${players.map(
            (_, i) =>
              html`<span
                class="${classMap({
                  active: i === this._activeIndex,
                  'media-player-dot': true,
                })}"></span>`,
          )}
        </div>
      </div>
    `;
  }

  /**
   * ST fork: the next player's artwork (or icon) as a round button beside the carousel; a tap moves on, wrapping round.
   * The count of the others at 3+. Hidden unless a navbar's styles show it.
   */
  private _renderNext(players: MediaPlayerPlayerConfig[]) {
    const next = players[(this._activeIndex + 1) % players.length];
    const entity = this._resolveEntity(next);
    const state = this._navbarCard._hass.states[entity ?? ''];
    const image =
      state?.attributes?.entity_picture_local ?? state?.attributes?.entity_picture;
    const icon = this._resolveIcon(next);
    return html`<button
      class="media-player-next"
      aria-label=${state?.attributes?.friendly_name ?? entity ?? ''}
      @pointerdown=${(e: PointerEvent) => e.stopPropagation()}
      @click=${(e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this._activeIndex = (this._activeIndex + 1) % players.length;
        this._dragOffset = 0;
        this._navbarCard.requestUpdate();
      }}>
      ${
        image && !icon
          ? html`<img class="media-player-next-image" src=${image} alt="" />`
          : html`<ha-icon class="media-player-next-image media-player-icon-fallback" icon=${icon ?? 'mdi:music'}></ha-icon>`
      }
      ${players.length > 2 ? html`<span class="media-player-next-count">${players.length - 1}</span>` : nothing}
    </button>`;
  }

  /**
   * Render a single slide inside the carousel.
   */
  private _renderSlide(player: MediaPlayerPlayerConfig) {
    const entity = this._resolveEntity(player);
    const state = this._navbarCard._hass.states[entity ?? ''];

    if (!(state && entity)) {
      return html`<ha-card class="media-player error">
        <ha-alert alert-type="error">Entity not found "${entity}"</ha-alert>
      </ha-card>`;
    }

    return html`
      <ha-card
        class="media-player"
        ${eventDetection({
          context: this._navbarCard,
          doubleTap: player.double_tap_action,
          hold: player.hold_action,
          tap: player.tap_action ?? { action: 'more-info', entity },
        })}>
        ${this._renderCardContent(player, entity, state)}
      </ha-card>
    `;
  }

  /**
   * Resolve the playback progress of a player, or null if unknown.
   *
   * HA only reports `media_position` when something changes (play, pause,
   * seek...), so while playing the position is extrapolated from
   * `media_position_updated_at` and the bar is animated with CSS from there.
   * The position is only recomputed when HA reports a new one, so unrelated
   * re-renders don't restart the animation.
   */
  private _getProgress(entity: string, state: HassEntity) {
    const {
      media_position: reported,
      media_duration: duration,
      media_position_updated_at: updatedAt,
    } = state.attributes;
    if (reported == null || !(duration > 0)) return null;

    const playing = state.state === 'playing';
    const key = `${reported}|${duration}|${updatedAt}|${state.state}`;
    let anchor = this._progressAnchors.get(entity);
    if (anchor?.key !== key) {
      anchor = { key, position: this._getPosition(state) };
      this._progressAnchors.set(entity, anchor);
    }
    return { duration, key, playing, position: anchor.position };
  }

  /**
   * Current playback position in seconds, extrapolated while playing.
   */
  private _getPosition(state: HassEntity): number {
    const {
      media_position: reported,
      media_duration: duration,
      media_position_updated_at: updatedAt,
    } = state.attributes;
    const elapsed =
      state.state === 'playing' && updatedAt
        ? (Date.now() - new Date(updatedAt).getTime()) / 1000
        : 0;
    return Math.min(reported + Math.max(0, elapsed), duration);
  }

  /**
   * Browsers restart CSS animations whenever the element is re-attached or
   * shown again (e.g. navigating between views), replaying from the position
   * computed at render time. Skip ahead to the actual playback position.
   */
  private _onProgressAnimationStart = (
    e: AnimationEvent,
    state: HassEntity,
    anchorPosition: number,
  ) => {
    const elapsed = this._getPosition(state) - anchorPosition;
    for (const animation of (e.target as HTMLElement).getAnimations?.() ?? []) {
      animation.currentTime = elapsed * 1000;
    }
  };

  /**
   * Render the content of a media-player card.
   */
  private _renderCardContent(
    player: MediaPlayerPlayerConfig,
    entity: string,
    state: HassEntity,
  ) {
    const image =
      state.attributes.entity_picture_local ?? state.attributes.entity_picture;
    const progress = this._getProgress(entity, state);
    const icon = this._resolveIcon(player);
    const title = this._resolveTitle(player, state);
    const subtitle = this._resolveSubtitle(player, state);
    const albumBg =
      this._navbarCard.config?.media_player?.album_cover_background ??
      DEFAULT_NAVBAR_CONFIG.media_player.album_cover_background;

    return html`
      <div
        class="media-player-bg"
        style=${albumBg ? `background-image: url(${image});` : ''}></div>
      ${
        progress != null
          ? html`<div class="media-player-progress-bar">
              ${keyed(
                progress.key,
                html`<div
                  class=${classMap({
                    'media-player-progress-bar-fill': true,
                    playing: progress.playing,
                  })}
                  style="--progress: ${progress.position / progress.duration}; animation-duration: ${progress.duration - progress.position}s"
                  @animationstart=${(e: AnimationEvent) =>
                    this._onProgressAnimationStart(
                      e,
                      state,
                      progress.position,
                    )}></div>`,
              )}
            </div>`
          : html``
      }
      ${
        image && !icon
          ? html`<img
              class="media-player-image"
              src=${image}
              alt=${title || ''} />`
          : html`<ha-icon
              class="media-player-image media-player-icon-fallback"
              icon=${icon ?? 'mdi:music'}></ha-icon>`
      }
      <div class="media-player-info">
        <span class="media-player-title">${title || ''}</span>
        <span class="media-player-artist">${subtitle || ''}</span>
      </div>
      <button
        class="navbar-icon-button media-player-button media-player-button-extra media-player-button-shuffle ${state.attributes.shuffle ? 'on' : ''}"
        @click=${(e: MouseEvent) => this._handleExtra(e, entity, 'shuffle')}
        @pointerdown=${preventEventDefault}
        @pointerup=${preventEventDefault}>
        <ha-icon icon="ios:shuffle"></ha-icon>
      </button>
      <button
        class="navbar-icon-button media-player-button media-player-button-extra media-player-button-prev"
        @click=${(e: MouseEvent) => this._handleExtra(e, entity, 'prev')}
        @pointerdown=${preventEventDefault}
        @pointerup=${preventEventDefault}>
        <ha-icon icon="ios:backward-fill"></ha-icon>
      </button>
      <button
        class="navbar-icon-button media-player-button media-player-button-play-pause primary"
        appearance="accent"
        variant="brand"
        @click=${(e: MouseEvent) => this._handlePlayPause(e, entity)}
        @pointerdown=${preventEventDefault}
        @pointerup=${preventEventDefault}>
        <ha-icon
          icon=${
            state.state === 'playing' ? 'ios:pause-fill' : 'ios:play-fill'
          }></ha-icon>
      </button>
      <button
        class="navbar-icon-button media-player-button media-player-button-skip"
        appearance="plain"
        variant="neutral"
        @click=${(e: MouseEvent) => this._handleSkipNext(e, entity)}
        @pointerdown=${preventEventDefault}
        @pointerup=${preventEventDefault}>
        <ha-icon icon="ios:forward-fill"></ha-icon>
      </button>
      <button
        class="navbar-icon-button media-player-button media-player-button-extra media-player-button-repeat ${state.attributes.repeat && state.attributes.repeat !== 'off' ? 'on' : ''}"
        @click=${(e: MouseEvent) => this._handleExtra(e, entity, 'repeat')}
        @pointerdown=${preventEventDefault}
        @pointerup=${preventEventDefault}>
        <ha-icon icon=${state.attributes.repeat === 'one' ? 'ios:repeat-1' : 'ios:repeat'}></ha-icon>
      </button>
    `;
  }
}
