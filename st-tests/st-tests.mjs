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
  if (!w.PointerEvent) w.PointerEvent = w.MouseEvent; // older jsdom (CI) has no PointerEvent
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

// popup_style: native - the popup as the system's menu: a tap's popup a <select> over its route (the tap itself opens
// it - iOS's web view has no showPicker for a <select>), a hold's shown with showPicker; sections as headings
{
  const calls = [];
  const items = [
    { url: '/lovelace/home', icon: 'mdi:home', label: 'Home', selected: true },
    { url: '/lovelace/b', icon: 'mdi:b', label: 'Basement' },
    { url: '/lovelace/lights', icon: 'mdi:l', label: 'Lights', section: 'Pages' },
    { icon: 'mdi:s', label: 'Search', section: 'Other', tap_action: { action: 'perform-action', perform_action: 'script.x' } },
  ];
  const cfg = { popup_style: 'native', routes: [
    { url: '/lovelace/home', icon: 'mdi:home', label: 'Home', selected: true },
    { icon: 'mdi:menu', label: 'Pages', tap_action: { action: 'open-popup' }, popup: items },
    { url: '/lovelace/c', icon: 'mdi:c', label: 'Floor', hold_action: { action: 'open-popup' }, popup: items },
  ] };
  const { w, el, r, errors } = await card(cfg, {}, calls);
  let picked = 0;
  w.HTMLSelectElement.prototype.showPicker = function () { picked++; };
  const routes = [...r.querySelectorAll('.route')];
  const sel = [...routes[1].children].find(c => c.matches('select.st-native-select'));
  ok('native: a tap\'s popup is a <select> over its route (the tap opening the system menu)', !!sel && !routes[0].querySelector('select') && !routes[2].querySelector('select'), [!!sel]);
  sel.dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, composed: true }));
  sel.dispatchEvent(new w.PointerEvent('pointerup', { bubbles: true, composed: true }));
  sel.dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true }));
  await el.updateComplete; await new Promise(res => setTimeout(res, 30));
  ok('…the tap not the card\'s popup too, nor showPicker', !r.querySelector('.navbar-popup') && picked === 0, [picked]);
  const groups = [...sel.querySelectorAll('optgroup')].map(g => `${g.label}:${g.querySelectorAll('option').length}`);
  ok('…its items as the finger goes down, the sectioned ones under headings', sel.options.length === 4 && groups.join() === 'Pages:1,Other:1', [sel.options.length, groups]);
  ok('…the current one chosen (the system\'s checkmark)', sel.options[sel.selectedIndex]?.textContent === 'Home');
  const actions = []; w.addEventListener('hass-action', e => actions.push(e.detail));
  sel.value = '1'; sel.dispatchEvent(new w.Event('change'));
  ok('…choosing a page goes there', w.location.pathname === '/lovelace/b', w.location.pathname);
  sel.value = '3'; sel.dispatchEvent(new w.Event('change'));
  await new Promise(res => setTimeout(res, 30));
  ok('…choosing an action runs it (Home Assistant\'s action)', actions.some(a => JSON.stringify(a).includes('script.x')), actions);
  // none current: no blank first row (iOS's menu shows a hidden placeholder anyway, checkmarked), none chosen
  {
    const c = await card({ popup_style: 'native', routes: [
      { url: '/lovelace/home', icon: 'mdi:home', label: 'Home' },
      { icon: 'mdi:menu', label: 'Pages', tap_action: { action: 'open-popup' }, popup: [
        { url: '/lovelace/x', icon: 'mdi:x', label: 'X', selected: false },
        { url: '/lovelace/y', icon: 'mdi:y', label: 'Y', selected: false } ] } ] }, {}, []);
    const s2 = c.r.querySelector('select.st-native-select');
    s2.dispatchEvent(new c.w.PointerEvent('pointerdown', { bubbles: true, composed: true }));
    ok('…none current: just its items, none chosen (no blank checkmarked row)', s2.options.length === 2 && s2.selectedIndex === -1 && s2.options[0].textContent === 'X', [s2.options.length, s2.selectedIndex]);
    s2.value = '0'; s2.dispatchEvent(new c.w.Event('change'));
    ok('…and the first one still goes there', c.w.location.pathname === '/lovelace/x', c.w.location.pathname);
  }
  // a hold's popup: showPicker - iOS opens a menu only straight after a tap or a lift: opened as the finger lifts
  const hold = async () => {
    routes[2].dispatchEvent(new w.PointerEvent('pointerdown', { bubbles: true, composed: true }));
    await new Promise(res => setTimeout(res, 700));
  };
  w.HTMLSelectElement.prototype.showPicker = function () { if (!w.__lifted) throw new w.DOMException('no activation', 'NotAllowedError'); picked++; };
  picked = 0; w.__lifted = false;
  await hold();
  const hsel = r.querySelector('select.st-native-popup');
  ok('…a hold\'s: not allowed yet (the finger still down): waits', picked === 0 && !!hsel && hsel.options.length === 4, [picked, hsel?.options.length]);
  w.__lifted = true; w.dispatchEvent(new w.Event('pointerup'));
  ok('…opened as the finger lifts', picked === 1);
  // no showPicker at all: the card's own popup
  delete w.HTMLSelectElement.prototype.showPicker;
  await hold();
  await el.updateComplete; await new Promise(res => setTimeout(res, 30));
  ok('…where the system can\'t: the card\'s own popup', r.querySelectorAll('.navbar-popup .popup-item').length === 4);
  ok('no script errors (native popup)', !errors.length, errors);
}

// popup_style: menu - the card's own popup as iOS's menu: opens on the press, drag along it (a haptic tick per row),
// lift to choose; rows with a detail line and their icon, the current one checked
{
  const items = [
    { url: '/lovelace/home', icon: 'mdi:home', label: 'Home', detail: '[[[ return states["sensor.n"].state + " on" ]]]' },
    { url: '/lovelace/b', icon: 'mdi:b', label: 'Basement', section: 'Floors' },
    { icon: 'mdi:s', label: 'Search', section: 'Other', tap_action: { action: 'perform-action', perform_action: 'script.x' } },
  ];
  const { w, el, r, errors } = await card({ popup_style: 'menu', routes: [
    { url: '/lovelace/home', icon: 'mdi:home', label: 'Home', selected: true },
    { icon: 'mdi:menu', label: 'Pages', tap_action: { action: 'open-popup' }, popup: items },
    { url: '/lovelace/c', icon: 'mdi:c', label: 'Floor', hold_action: { action: 'open-popup' }, popup: items },
  ] }, { 'sensor.n': { state: '3', attributes: {} } });
  const ticks = []; w.addEventListener('haptic', e => ticks.push(e.detail));
  const actions = []; w.addEventListener('hass-action', e => actions.push(e.detail));
  // (jsdom lays nothing out: the button at the bottom, rows 50px apart above it)
  const gbr = w.HTMLElement.prototype.getBoundingClientRect;
  w.HTMLElement.prototype.getBoundingClientRect = function () {
    const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
    if (this.classList.contains('st-menu-row')) return box(20, 400 + 50 * Number(this.dataset.i), 260, 50);
    if (this.classList.contains('st-menu')) return box(12, 390, 280, 170);
    if (this.classList.contains('route')) return box(100, 700, 60, 60);
    if (this.classList.contains('navbar')) return box(0, 690, 400, 80);
    return gbr.call(this);
  };
  // (and the menu its size: 280×170)
  for (const [k, v] of [['offsetWidth', 280], ['offsetHeight', 170]])
    Object.defineProperty(w.HTMLElement.prototype, k, { configurable: true, get() { return this.classList?.contains('st-menu') ? v : 0; } });
  // (a browser's animate(): it throws on an easing it can't read, as WebKit does on linear(NaN, …))
  const anims = [];
  w.HTMLElement.prototype.animate = function (frames, opts) {
    if (/NaN/.test(opts?.easing ?? '')) throw new w.TypeError(`bad easing ${opts.easing.slice(0, 30)}`);
    const an = { el: this, frames, opts, cancel() { an.cancelled = true; } };
    anims.push(an);
    return an;
  };
  w.HTMLElement.prototype.getAnimations = function () { return anims.filter(an => an.el === this && !an.cancelled); };
  const routes = [...r.querySelectorAll('.route')];
  const ev = (t, x, y, target = w) => target.dispatchEvent(new w.PointerEvent(t, { bubbles: true, composed: true, clientX: x, clientY: y }));
  const settle = async (ms = 30) => { await el.updateComplete; await new Promise(res => setTimeout(res, ms)); };
  ok('menu: routes that open one take the touch (no page scroll, no callout)', routes[1].classList.contains('st-menu-route') && routes[2].classList.contains('st-menu-route') && !routes[0].classList.contains('st-menu-route'));
  ev('pointerdown', 130, 730, routes[1]); await settle();
  const rows = () => [...r.querySelectorAll('.st-menu .st-menu-row')];
  ok('menu: opens as the finger goes down (a tap\'s)', rows().length === 3 && !r.querySelector('select'), rows().length);
  ok('…each row: label, detail (templated), icon', rows()[0].querySelector('.st-menu-label')?.textContent === 'Home' && rows()[0].querySelector('.st-menu-detail')?.textContent === '3 on' && rows()[0].querySelector('ha-icon')?.getAttribute('icon') === 'mdi:home' && !rows()[1].querySelector('.st-menu-detail'));
  ok('…sections under headings, a line between', [...r.querySelectorAll('.st-menu-section')].map(x => x.textContent).join() === 'Floors,Other' && r.querySelectorAll('.st-menu-gap').length === 2);
  ok('…the current one checked, the others not', !!rows()[0].querySelector('.st-menu-check svg') && !rows()[1].querySelector('.st-menu-check svg'));
  ok('…its glass grows from the button\'s capsule', anims.some(an => an.el.classList.contains('st-menu') && /^inset\(\d+px \d+px \d+px \d+px round 30px\)/.test(an.frames[0].clipPath)), anims.map(an => an.frames[0]));
  ok('…over its button, sharing its bottom edge (a bottom bar)', parseFloat(r.querySelector('.st-menu').style.top) + parseFloat(r.querySelector('.st-menu').style.height) === 760, r.querySelector('.st-menu').style.top);
  ok('…and its left edge (a button in the left third)', r.querySelector('.st-menu').style.left === '100px', r.querySelector('.st-menu').style.left);
  ok('…nothing of the opening kept once it ends (the rows\' blur stayed drawn on the phone)', anims.filter(an => an.opts?.fill).every(an => an.opts.fill === 'backwards'), anims.map(an => an.opts?.fill));
  ok('…grown out of its button (its rows from the button)', /px/.test(r.querySelector('.st-menu-body').style.transformOrigin) && /px/.test(r.querySelector('.st-menu-shadow').style.width) && r.querySelector('.st-menu').classList.contains('visible'));
  ev('pointermove', 130, 425); ev('pointermove', 130, 430); ev('pointermove', 130, 475);
  ok('menu: dragged along it, the row under the finger lit, a tick per new row', rows()[1].classList.contains('active') && ticks.join() === 'selection,selection', ticks);
  ev('pointerup', 130, 475); routes[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true }));
  await settle(300);
  ok('…lifted on a row: chosen (goes there), closed', w.location.pathname === '/lovelace/b' && !r.querySelector('.st-menu'), w.location.pathname);
  // a tap: lifted on the button - left open to tap; the click after it doesn't open it again (or close it)
  ev('pointerdown', 130, 730, routes[1]); await settle();
  ev('pointerup', 130, 730); routes[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true, composed: true })); await settle();
  ok('menu: a tap leaves it open', !!r.querySelector('.st-menu.visible'));
  ev('pointerdown', 130, 525, r.querySelector('.st-menu')); await settle();
  ok('…a finger put on a row lights it (no tick there)', rows()[2].classList.contains('active') && ticks.length === 2, ticks);
  ev('pointerup', 130, 525); await settle(300);
  ok('…lifted there: its action runs', actions.some(a => JSON.stringify(a).includes('script.x')) && !r.querySelector('.st-menu'), actions);
  ev('pointerdown', 130, 730, routes[1]); ev('pointerup', 130, 730); await settle();
  ev('pointerdown', 380, 100, r.querySelector('.st-menu-backdrop')); ev('pointerup', 380, 100); await settle(400);
  ok('menu: a tap outside closes it', !r.querySelector('.st-menu') && !r.querySelector('.st-menu-backdrop'));
  // a hold's: opens as the hold fires, the finger still down, then follows it the same
  ev('pointerdown', 130, 730, routes[2]); await settle(700);
  ok('menu: a hold\'s opens with the finger still down (the hold\'s own haptic as it does)', rows().length === 3 && ticks.length === 3, ticks);
  ev('pointermove', 130, 425);
  ok('…followed: the row under it lit, ticked', rows()[0].classList.contains('active') && ticks.length === 4, ticks);
  const before = w.location.pathname;
  ev('pointerup', 380, 100); await settle(300);
  ok('…lifted off it, away from the button: closed, nothing chosen', !r.querySelector('.st-menu') && w.location.pathname === before);
  w.HTMLElement.prototype.getBoundingClientRect = gbr;
  ok('no script errors (menu)', !errors.length, errors);
}

console.log(`\n${fails} failure(s)`);
process.exit(fails ? 1 : 0);
