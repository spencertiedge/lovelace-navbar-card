// The ST fork's own changes, checked on the built card in jsdom (run by the st-sync workflow before a release):
//   node st-tests/st-tests.mjs dist/navbar-card.js
import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const FILE = process.argv[2] ?? 'dist/navbar-card.js';
let fails = 0;
const ok = (name, c, extra = '') => { if (!c) fails++; console.log(c ? 'PASS' : 'FAIL', name, c ? '' : JSON.stringify(extra)); };

async function card(config, states, calls = []) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://ha.local/lovelace/home', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, errors = [];
  w.addEventListener('error', e => errors.push(e.message));
  w.matchMedia = q => ({ media: q, matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.Element.prototype.setPointerCapture = () => {}; w.Element.prototype.releasePointerCapture = () => {};
  for (const t of ['ha-card', 'ha-icon', 'ha-ripple', 'md-ripple', 'ha-alert']) w.eval(`customElements.define('${t}', class extends HTMLElement {})`);
  w.eval(`class HuiView extends HTMLElement {}; customElements.define('hui-view', HuiView);`);
  w.eval(fs.readFileSync(FILE, 'utf8').replace(/^export\s*\{[^}]*\};?\s*$/m, ''));
  const el = w.document.createElement('navbar-card');
  el.setConfig({ type: 'custom:navbar-card', ...config });
  w.document.body.append(el);
  el.hass = { states, entities: {}, devices: {}, areas: {}, themes: { darkMode: false }, language: 'en', locale: {}, user: { is_admin: true }, panels: {},
    callService: (d, s, data) => calls.push([d, s, data]), localize: k => k };
  await el.updateComplete; await new Promise(r => setTimeout(r, 50));
  return { w, el, r: el.shadowRoot, errors };
}

// 3 + 4: badges of several colours are strips of dots after the label, outside the button; CSS variables don't crash
{
  const { r, errors } = await card({ routes: [
    { url: '/lovelace/home', icon: 'mdi:home', label: 'Home' },
    { url: '/lovelace/b', icon: 'mdi:b', label: 'B', badge: { show: true, color: 'var(--purple-color),var(--amber-color)' } },
    { url: '/lovelace/c', icon: 'mdi:c', label: 'C', badge: { show: true, color: 'rgba(1, 2, 3, 0.5)' } },
    { url: '/lovelace/d', icon: 'mdi:d', label: 'D', badge: { show: true, count: '3' } },
    { url: '/lovelace/e', icon: 'mdi:e', label: 'E', badge: { show: true, color: 'red', icon: 'mdi:lock' } },
  ] }, {});
  const routes = [...r.querySelectorAll('.route')];
  const dots = i => [...routes[i].querySelectorAll('.badge.badge-multi .badge-dot')].map(d => d.style.backgroundColor || d.getAttribute('style'));
  ok('two colours: a strip of two dots', dots(1).join('+') === 'var(--purple-color)+var(--amber-color)', dots(1));
  ok('a colour with commas inside (rgba): one dot', dots(2).length === 1, dots(2));
  ok('the strip after the label, outside the button', routes.every(x => !x.querySelector('.button .badge-multi')) && routes[1].lastElementChild?.classList.contains('badge-multi'));
  ok('a counter badge without a colour: as upstream (in the button)', !!routes[3].querySelector('.button .badge') && !routes[3].querySelector('.badge-multi'));
  ok('an icon badge with a colour: upstream\'s coloured icon badge, not a strip', !!routes[4].querySelector('.button .badge.with-icon') && !routes[4].querySelector('.badge-multi'));
  ok('no crash on CSS-variable colours', !errors.length, errors);
  const css = [...r.querySelectorAll('style')].map(s => s.textContent).join('\n');
  ok('2: tabs leave room for the strip (overflow visible, padding-bottom 12px)', /overflow: visible;\s*padding-bottom: 12px;/.test(css));
}

// 1 + 5: the player in its wrapper; shuffle / previous / play-pause / next / repeat, Cupertino icons, service calls
{
  const calls = [];
  const states = { 'media_player.a': { state: 'playing', attributes: { media_title: 'A', shuffle: false, repeat: 'all' } } };
  const { w, r, errors } = await card({ routes: [{ url: '/lovelace/home', icon: 'mdi:home' }], media_player: { players: [{ entity: 'media_player.a' }] } }, states, calls);
  ok('1: the single player in .media-player-wrapper', !!r.querySelector('.media-player-wrapper > ha-card.media-player'));
  const icons = [...r.querySelectorAll('.media-player button.media-player-button ha-icon')].map(i => i.getAttribute('icon'));
  ok('5: buttons + Cupertino icons in order', icons.join() === 'ios:shuffle,ios:backward-fill,ios:pause-fill,ios:forward-fill,ios:repeat', icons);
  const tap = c => r.querySelector(`.media-player-button-${c}`).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  tap('shuffle'); tap('prev'); tap('repeat');
  ok('5: shuffle on, previous, repeat all -> one', JSON.stringify(calls) === JSON.stringify([['media_player', 'shuffle_set', { entity_id: 'media_player.a', shuffle: true }],
    ['media_player', 'media_previous_track', { entity_id: 'media_player.a' }], ['media_player', 'repeat_set', { entity_id: 'media_player.a', repeat: 'one' }]]), calls);
  const css = [...r.querySelectorAll('style')].map(s => s.textContent).join('\n');
  ok('5 + 7: extra buttons and the next bubble hidden by default', /media-player-button-extra \{\s*display: none;/.test(css) && /\.media-player-next \{\s*display: none;/.test(css));
  ok('no script errors (player)', !errors.length, errors);
}

// 6 + 7: carousel - shown players counted, peek variables, a short drag switches, the next bubble
{
  const mp = (t, pic) => ({ state: 'playing', attributes: { media_title: t, entity_picture: pic } });
  const states = { 'media_player.a': mp('A', '/a.jpg'), 'media_player.b': mp('B', '/b.jpg'), 'media_player.c': { state: 'off', attributes: {} } };
  const { w, el, r, errors } = await card({ routes: [{ url: '/lovelace/home', icon: 'mdi:home' }],
    media_player: { players: [{ entity: 'media_player.a' }, { entity: 'media_player.b' }, { entity: 'media_player.c' }] } }, states);
  ok('6: two shown players in the carousel', r.querySelectorAll('.media-player-track > .media-player').length === 2);
  ok('6: placed by --st-slide-w / --st-peek', /var\(--st-slide-w, 100%\)/.test(r.querySelector('.media-player-track').getAttribute('style')));
  ok('7: the next player\'s artwork in the bubble', r.querySelector('.media-player-next img')?.getAttribute('src') === '/b.jpg');
  Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 500; } });
  const vp = r.querySelector('.media-player-viewport');
  vp.dispatchEvent(new w.MouseEvent('pointerdown', { clientX: 300, button: 0, bubbles: true }));
  await new Promise(res => setTimeout(res, 400));
  vp.dispatchEvent(new w.MouseEvent('pointermove', { clientX: 240, bubbles: true, cancelable: true }));
  vp.dispatchEvent(new w.MouseEvent('pointerup', { clientX: 240, bubbles: true }));
  await el.updateComplete;
  ok('6: a slow 60 px drag switches (48 px is enough)', r.querySelector('.media-player-carousel').classList.contains('at-end'));
  ok('no script errors (carousel)', !errors.length, errors);
}

// popup_style: native - the popup as the system's menu (a <select> over the button, showPicker), sections as headings
{
  const calls = [];
  const cfg = { popup_style: 'native', routes: [
    { url: '/lovelace/home', icon: 'mdi:home', label: 'Home', selected: true },
    { icon: 'mdi:menu', label: 'Pages', tap_action: { action: 'open-popup' }, popup: [
      { url: '/lovelace/home', icon: 'mdi:home', label: 'Home', selected: true },
      { url: '/lovelace/b', icon: 'mdi:b', label: 'Basement' },
      { url: '/lovelace/lights', icon: 'mdi:l', label: 'Lights', section: 'Pages' },
      { icon: 'mdi:s', label: 'Search', section: 'Other', tap_action: { action: 'perform-action', perform_action: 'script.x' } },
    ] },
  ] };
  const { w, el, r, errors } = await card(cfg, {}, calls);
  let picked = 0;
  w.HTMLSelectElement.prototype.showPicker = function () { picked++; };
  const route = [...r.querySelectorAll('.route')][1];
  route.querySelector('.button').dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true }));
  await el.updateComplete; await new Promise(res => setTimeout(res, 30));
  const sel = r.querySelector('select.st-native-popup');
  ok('native: a tap opens the system menu (a <select> shown with showPicker), not the card\'s popup', picked === 1 && !!sel && !r.querySelector('.navbar-popup'), [picked, !!sel]);
  const groups = sel ? [...sel.querySelectorAll('optgroup')].map(g => `${g.label}:${g.querySelectorAll('option').length}`) : [];
  ok('…its items, the sectioned ones under headings', sel && sel.options.length === 4 && groups.join() === 'Pages:1,Other:1', [sel?.options.length, groups]);
  ok('…the current one chosen (the system\'s checkmark)', sel?.options[sel.selectedIndex]?.textContent === 'Home');
  const actions = []; w.addEventListener('hass-action', e => actions.push(e.detail));
  sel.value = '1'; sel.dispatchEvent(new w.Event('change'));
  ok('…choosing a page goes there', w.location.pathname === '/lovelace/b', w.location.pathname);
  sel.value = '3'; sel.dispatchEvent(new w.Event('change'));
  await new Promise(res => setTimeout(res, 30));
  ok('…choosing an action runs it (Home Assistant\'s action)', actions.some(a => a?.config?.tap_action?.perform_action === 'script.x' || JSON.stringify(a).includes('script.x')), actions);
  // a hold's popup: iOS opens a menu only straight after a tap or a lift - opened as the finger lifts
  w.HTMLSelectElement.prototype.showPicker = function () { if (!w.__lifted) throw new w.DOMException('no activation', 'NotAllowedError'); picked++; };
  picked = 0; w.__lifted = false;
  route.querySelector('.button').dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true }));
  await new Promise(res => setTimeout(res, 20));
  ok('…not allowed yet (a hold, the finger still down): waits', picked === 0);
  w.__lifted = true; w.dispatchEvent(new w.Event('pointerup'));
  ok('…opened as the finger lifts', picked === 1);
  // no showPicker at all: the card's own popup
  delete w.HTMLSelectElement.prototype.showPicker;
  route.querySelector('.button').dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true }));
  await el.updateComplete; await new Promise(res => setTimeout(res, 30));
  ok('…where the system can\'t: the card\'s own popup', r.querySelectorAll('.navbar-popup .popup-item').length === 4);
  ok('no script errors (native popup)', !errors.length, errors);
}

console.log(`\n${fails} failure(s)`);
process.exit(fails ? 1 : 0);
