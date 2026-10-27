'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const elements = new Map(), handlers = {}, storage = new Map(), timers = new Map(), documentEvents = {};
  let timerId = 0;
  class Element {
    constructor() {
      this.children = []; this.events = {}; this.dataset = {}; this.value = '';
      this.textContent = ''; this.clientWidth = 360; this.scrollHeight = 100;
      this.scrollTop = 0; this.clientHeight = 100; this.classes = new Set();
      this.style = { setProperty() {}, removeProperty() {} };
      this.classList = { add: (c) => this.classes.add(c), remove: (c) => this.classes.delete(c),
        contains: (c) => this.classes.has(c), toggle: (c, force) => (force ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c) };
    }
    set innerHTML(value) {
      this.html = value; this.children = [];
      for (const match of value.matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element());
    }
    get innerHTML() { return this.html || ''; }
    appendChild(e) { this.children.push(e); }
    append(...items) { this.children.push(...items); }
    replaceChildren() { this.children = []; }
    remove() { this.removed = true; }
    addEventListener(name, fn) { this.events[name] = fn; }
    setAttribute(name, value) { this[name] = value; }
    querySelectorAll() { return this.children; }
    getBoundingClientRect() { return { left: 6, right: 64, top: 64, bottom: 104, width: 340, height: 40 }; }
    focus() {}
  }
  const html = fs.readFileSync(path.resolve(__dirname, '../public/index.html'), 'utf8');
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], new Element());
  const socket = { connected: true, on: (event, fn) => { handlers[event] = fn; }, emit() {}, disconnect() { this.connected = false; } };
  const ctx = vm.createContext({ io: () => socket,
    document: { getElementById: (id) => { assert(elements.has(id), `Missing element: ${id}`); return elements.get(id); }, createElement: () => new Element(), createTextNode: (text) => ({ textContent: text }), addEventListener: (event, fn) => { documentEvents[event] = fn; }, hidden: false },
    window: { innerWidth: 390, innerHeight: 844, addEventListener() {}, matchMedia: () => ({ matches: true }) },
    location: { href: 'http://localhost:3127/?room=TEST' }, URL, console,
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (k, v) => storage.set(k, v) },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id), setInterval() {}, requestAnimationFrame: (f) => { f(); return 1; },
    fetch: () => Promise.resolve(), navigator: {}, getComputedStyle: () => ({ gap: '6px' }),
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../public/app.js'), 'utf8'), ctx);
  const data = () => ({ public: { code: 'TEST', phase: 'playing', round: 1, totalRounds: 3, currentIdx: 0, startPlayerIdx: 0,
    mustShow: false, settings: { hostOnly: true }, results: [], players: [0, 1, 2].map((idx) => ({ idx, name: idx ? 'B' : '<b>A</b>', handCount: 2, scorePileCount: 0, chips: 0, totalScore: 0, scoutShowUsed: false, connected: true, isHost: idx === 0 })),
    currentShow: { ownerIdx: 1, type: 'set', length: 1, top: 3, cards: [{ value: 3, other: 7 }] } },
    private: { yourIdx: 0, canScout: true, scoutShowUsed: false, hand: [{ id: 1, a: 1, b: 2, up: 'a', value: 1 }] } });
  return { ctx, elements, handlers, data, socket, timers, documentEvents };
}

test('invite code is prefilled and stats no longer show combo token', () => {
  const { elements } = setup();
  assert.equal(elements.get('code-input').value, 'TEST');
  assert.equal(elements.has('my-ss-token'), false);
});

test('unrelated state update preserves active scout interaction', () => {
  const { ctx, handlers, data, elements } = setup();
  handlers.state(data());
  vm.runInContext('startScout(true)', ctx);
  handlers.state(data());
  assert.equal(vm.runInContext('S.scout.step', ctx), 'pick');
  vm.runInContext("S.scout.step = 'insert'; S.scout.card = {a:3,b:7}; S.scout.up = 'a'", ctx);
  handlers.state(data());
  assert.equal(vm.runInContext('S.scout.step', ctx), 'insert');
  elements.get('hand').events.scroll();
  assert.equal(elements.get('insert-marks').children.length, 2);
});

test('ties, round results and nickname escaping render together', () => {
  const { handlers, data, elements } = setup();
  const state = data(); state.public.phase = 'gameEnd';
  state.public.players.forEach((p) => { p.totalScore = 3; });
  state.public.results = [{ round: 1, detail: [{ idx: 0, name: '<b>A</b>', captured: 1, chips: 0, penalty: 0, roundScore: 1, totalScore: 1 }] }];
  handlers.state(state);
  const html = elements.get('modal').innerHTML;
  assert(html.includes('并列获胜'));
  assert(html.includes('逐轮战绩'));
  assert(html.includes('&lt;b&gt;A&lt;/b&gt;'));
  assert(!html.includes('<b>A</b>'));
  assert.equal((html.match(/🏆/g) || []).length, 3);
});

test('disconnect disables gameplay and clears incomplete actions', () => {
  const { handlers, data, elements, ctx, socket } = setup(); handlers.state(data());
  socket.connected = false; handlers.disconnect();
  assert.equal(elements.get('actions').children.length, 0);
  assert.equal(elements.get('chat-send').disabled, true);
  assert.equal(vm.runInContext('S.sessionActive', ctx), false);
});

test('long press previews full card, suppresses selection, and cancels on release or movement', () => {
  const { ctx, elements, handlers, data, timers, documentEvents } = setup();
  handlers.state(data());
  const hand = elements.get('hand'), card = hand.children[0], preview = elements.get('card-preview');
  card.getBoundingClientRect = () => ({ left: 80, top: 400, width: 58, height: 82 });
  const event = { isPrimary: true, button: 0, pointerId: 1, clientX: 10, clientY: 10, target: { closest: () => card } };
  hand.events.pointerdown(event);
  timers.get(vm.runInContext('cardHold.timer', ctx))();
  assert.equal(preview.classList.contains('hidden'), false);
  assert.equal(preview.children[0].dataset.value, 1);
  assert.equal(preview.children[0].dataset.other, 2);
  assert.equal(preview.style.width, '58px');
  assert(Math.abs(parseFloat(preview.style.left) - 75.65) < 0.01);
  assert(Math.abs(parseFloat(preview.style.top) - 297.7) < 0.01);
  documentEvents.pointerup();
  assert.equal(preview.classList.contains('hidden'), true);
  let suppressed = false;
  hand.events.click({ preventDefault() {}, stopImmediatePropagation() { suppressed = true; } });
  assert.equal(suppressed, true);
  hand.events.pointerdown(event);
  const timer = vm.runInContext('cardHold.timer', ctx);
  documentEvents.pointermove({ pointerId: 1, clientX: 40, clientY: 10 });
  assert.equal(timers.has(timer), false);
  assert.equal(vm.runInContext('suppressCardClick', ctx), false);
});

test('opponent seating is relative to self and stays stable across turns', () => {
  const { ctx, elements, handlers, data } = setup();
  const state = data();
  state.public.players = Array.from({ length: 5 }, (_, idx) => ({ ...state.public.players[0], idx, name: `P${idx}`, connected: idx !== 3, scoutShowUsed: idx === 4 }));
  state.private.yourIdx = 2;
  state.public.currentIdx = 3;
  state.public.currentShow.ownerIdx = 3;
  handlers.state(state);
  let cards = elements.get('opponents').children;
  assert.deepEqual(cards.map((c) => c.children[0].children[1].textContent), ['P3', 'P4', 'P0', 'P1']);
  assert(cards[0].className.includes('seat-west active offline'));
  assert.equal(cards[0].children[3].children.length, 3);
  assert.equal(cards[1].children[0].children[2].className, 'combo-star used');
  state.public.currentIdx = 2; handlers.state(state);
  cards = elements.get('opponents').children;
  assert.deepEqual(cards.map((c) => c.children[0].children[1].textContent), ['P3', 'P4', 'P0', 'P1']);
  assert.equal(elements.get('myarea').classList.contains('my-turn'), true);
  state.public.phase = 'orient'; handlers.state(state);
  assert.equal(elements.get('myarea').classList.contains('my-turn'), false);
  assert.equal(vm.runInContext('S.me.yourIdx', ctx), 2);
});

test('scout highlights edges and flips the enlarged source without a duplicate preview', () => {
  const { ctx, elements, handlers, data } = setup();
  const state = data();
  state.public.currentShow.cards = [{ value: 3, other: 7 }, { value: 3, other: 8 }, { value: 3, other: 9 }];
  state.public.currentShow.length = 3;
  handlers.state(state);
  vm.runInContext('startScout(false)', ctx);
  let cards = elements.get('table').children[0].children[1].children;
  assert(cards[0].className.includes('show-edge'));
  assert(cards[1].className.includes('scout-unavailable'));
  assert(cards[2].className.includes('show-edge'));
  vm.runInContext("S.scout.step = 'insert'; S.scout.edge = 'left'; S.scout.card = {a:3,b:7}; S.scout.up = 'a'; renderTable(S.room); renderActions(S.room,S.me)", ctx);
  cards = elements.get('table').children[0].children[1].children;
  assert(cards[0].className.includes('scout-chosen'));
  assert(cards[1].className.includes('scout-unavailable'));
  assert(cards[2].className.includes('scout-unavailable'));
  assert.equal(cards[0].dataset.value, 3);
  assert.equal(elements.get('actions').children.some((e) => e.className?.startsWith('card')), false);
  assert.equal(elements.get('actions').children.some((e) => e.textContent.includes('翻转')), false);
  cards[0].events.click();
  cards = elements.get('table').children[0].children[1].children;
  assert.equal(cards[0].dataset.value, 7);
  assert.equal(cards[0].dataset.other, 3);
  assert.equal(state.public.currentShow.cards[0].value, 3);
  vm.runInContext('cancelScout()', ctx);
  cards = elements.get('table').children[0].children[1].children;
  assert.equal(cards[0].dataset.value, 3);
  assert.equal(cards[0].className.includes('scout-chosen'), false);
});

test('host has no ready button; guest readiness controls start and button colors', () => {
  const { ctx, elements, handlers, data } = setup();
  const state = data(); state.public.phase = 'lobby';
  vm.runInContext('S.joined = true', ctx);
  handlers.state(state);
  assert.equal(elements.has('host-only'), false);
  assert.equal(elements.get('btn-ready').classList.contains('hidden'), true);
  assert.equal(elements.get('btn-start').disabled, true);
  state.public.players[1].ready = true; state.public.players[2].ready = true;
  handlers.state(state);
  assert.equal(elements.get('btn-start').disabled, false);
  state.private.yourIdx = 1; state.public.players[1].ready = false;
  handlers.state(state);
  assert.equal(elements.get('btn-ready').classList.contains('hidden'), false);
  assert.equal(elements.get('btn-ready').classList.contains('btn-gold'), true);
  state.public.players[1].ready = true; handlers.state(state);
  assert.equal(elements.get('btn-ready').classList.contains('btn-primary'), true);
  assert.equal(elements.get('btn-ready').classList.contains('btn-gold'), false);
  state.public.phase = 'gameEnd'; handlers.state(state);
  assert(elements.get('modal').innerHTML.includes('class="btn btn-primary" id="btn-rematch-ready"'));
  state.private.yourIdx = 0; handlers.state(state);
  assert(!elements.get('modal').innerHTML.includes('id="btn-rematch-ready"'));
  assert.equal(elements.get('btn-rematch').disabled, false);
});

test('clicking the table around a selected scout card returns to picking without losing combo mode', () => {
  const { ctx, elements, handlers, data } = setup(); handlers.state(data());
  vm.runInContext("startScout(true); S.scout.step = 'insert'; S.scout.card = {a:3,b:7}; S.scout.up = 'b'; S.scout.edge = 'left'", ctx);
  elements.get('table').events.click({ target: { closest: () => ({}) } });
  assert.equal(vm.runInContext('S.scout.step', ctx), 'insert');
  elements.get('table').events.click({ target: { closest: () => null } });
  assert.equal(vm.runInContext('S.scout.step', ctx), 'pick');
  assert.equal(vm.runInContext('S.scout.scoutShow', ctx), true);
  assert.equal(vm.runInContext('S.scout.card', ctx), null);
  assert.equal(elements.get('insert-marks').children.length, 0);
});

test('lobby fullscreen button toggles fullscreen and follows external exit', () => {
  const { ctx, elements, documentEvents } = setup();
  let enters = 0, exits = 0;
  ctx.document.documentElement = { requestFullscreen() { enters++; return Promise.resolve(); } };
  ctx.document.exitFullscreen = () => { exits++; return Promise.resolve(); };
  elements.get('btn-lobby-fullscreen').events.click(); assert.equal(enters, 1);
  ctx.document.fullscreenElement = {};
  documentEvents.fullscreenchange();
  assert.equal(elements.get('btn-lobby-fullscreen').title, '退出全屏');
  elements.get('btn-lobby-fullscreen').events.click(); assert.equal(exits, 1);
  ctx.document.fullscreenElement = null; documentEvents.fullscreenchange();
  assert.equal(elements.get('btn-lobby-fullscreen').title, '全屏');
  assert.equal(elements.get('btn-lobby-fullscreen')['aria-pressed'], 'false');
});

test('lobby broadcasts preserve rules and scroll, closing rules reveals pending settlement', () => {
  const { ctx, handlers, data, elements } = setup();
  const state = data(); state.public.phase = 'lobby';
  vm.runInContext('S.joined = true', ctx); handlers.state(state);
  vm.runInContext('openRules()', ctx);
  const html = elements.get('modal').innerHTML;
  elements.get('modal').scrollTop = 77;
  state.public.players.push({ ...state.public.players[1], idx: 3, name: '新玩家' });
  handlers.state(state);
  assert.equal(elements.get('overlay').classList.contains('hidden'), false);
  assert.equal(elements.get('modal').innerHTML, html);
  assert.equal(elements.get('modal').scrollTop, 77);
  state.public.phase = 'gameEnd'; handlers.state(state);
  assert.equal(elements.get('modal').innerHTML, html);
  vm.runInContext('closeOverlay()', ctx);
  assert(elements.get('modal').innerHTML.includes('游戏结束'));
  assert.equal(elements.get('overlay').classList.contains('hidden'), false);
});

test('settlement player badges and readiness count update on broadcast', () => {
  const { handlers, data, elements } = setup();
  const state = data(); state.public.phase = 'roundEnd';
  state.public.lastRound = { kind: 'survived', winnerIdx: 0, detail: state.public.players.map((p) => ({ ...p, captured: 0, penalty: 0 })) };
  handlers.state(state);
  let html = elements.get('modal').innerHTML;
  assert(html.includes('ready-host')); assert(html.includes('ready-no'));
  assert(html.includes('已准备 0/2'));
  state.public.players[1].ready = true; handlers.state(state);
  html = elements.get('modal').innerHTML;
  assert(html.includes('ready-yes')); assert(html.includes('已准备 1/2'));
  state.public.players[2].connected = false; handlers.state(state);
  assert(elements.get('modal').innerHTML.includes('ready-offline'));
});

test('both round and final settlements display the last public show above results', () => {
  const { handlers, data, elements } = setup();
  const state = data(); state.public.phase = 'roundEnd';
  state.public.lastRound = { kind: 'survived', winnerIdx: 0, detail: state.public.players.map((p) => ({ ...p, captured: 0, penalty: 0 })) };
  handlers.state(state);
  let cards = elements.get('settlement-show').children[1].children;
  assert.equal(cards[0].dataset.value, 3);
  assert.equal(cards[0].dataset.other, 7);
  assert(elements.get('settlement-show').children[0].textContent.includes('B'));
  assert(elements.get('modal').innerHTML.indexOf('id="settlement-show"') < elements.get('modal').innerHTML.indexOf('<h2>'));
  state.public.phase = 'gameEnd'; handlers.state(state);
  assert.equal(elements.get('settlement-show').children[1].children.length, 1);
  state.public.abandoned = true; state.public.currentShow = null; handlers.state(state);
  assert.equal(elements.get('settlement-show').children.length, 0);
});

test('live chat bubbles expire, replace per player and do not replay history', () => {
  const { ctx, handlers, data, timers, elements } = setup(); handlers.state(data());
  const old = { id: 'old', seat: 2, name: 'B', text: 'old', time: 1 };
  handlers.history({ chat: [old], logs: [] });
  assert.equal(vm.runInContext('chatBubbles.size', ctx), 0);
  const message = { id: 'new', seat: 2, name: 'B', text: '你好😀', time: 2 };
  handlers.chatHistory([old, message]);
  assert.equal(vm.runInContext('chatBubbles.size', ctx), 1);
  const first = vm.runInContext('chatBubbles.get(1)', ctx);
  assert.equal(first.node.textContent, '你好😀');
  assert.equal(first.node.style.top, '64px');
  handlers.chatHistory([old, message, { ...message, id: 'newer', text: '👏' }]);
  assert.equal(first.node.removed, true); assert.equal(timers.has(first.timer), false);
  const current = vm.runInContext('chatBubbles.get(1)', ctx);
  timers.get(current.timer)();
  assert.equal(vm.runInContext('chatBubbles.size', ctx), 0);
  assert.equal(current.node.removed, true);
});

test('emoji picker inserts at cursor without sending and respects message length', () => {
  const { elements, socket } = setup();
  let sends = 0; socket.emit = () => { sends++; };
  const input = elements.get('chat-input');
  input.value = '你好'; input.selectionStart = 1; input.selectionEnd = 1;
  elements.get('emoji-picker').children[0].events.click();
  assert.equal(input.value, '你😀好');
  assert.equal(sends, 0);
  input.value = 'x'.repeat(200); input.selectionStart = 200; input.selectionEnd = 200;
  elements.get('emoji-picker').children[1].events.click();
  assert.equal(input.value.length, 200);
});

test('BGM starts only on request, loops gently, shares controls and stops cleanly', async () => {
  const { ctx, elements } = setup();
  let starts = 0, stops = 0, buffers = 0;
  ctx.fetch = async (url) => { assert.equal(url, '/audio/ocean-loop.wav'); return { ok: true, arrayBuffer: async () => new ArrayBuffer(16) }; };
  class AudioContext {
    constructor() { this.destination = {}; }
    resume() { return Promise.resolve(); }
    suspend() { return Promise.resolve(); }
    decodeAudioData(bytes) {
      assert.equal(bytes.byteLength, 16); buffers++;
      return Promise.resolve({ duration: 138 });
    }
    createBufferSource() { return { connect() {}, disconnect() {}, start() { starts++; }, stop() { stops++; } }; }
    createGain() { return { gain: {}, connect() {}, disconnect() {} }; }
  }
  ctx.window.AudioContext = AudioContext;
  assert.equal(starts, 0);
  await elements.get('btn-lobby-bgm').events.click();
  assert.equal(starts, 1); assert.equal(buffers, 1);
  assert.equal(vm.runInContext('bgm.source.loop', ctx), true);
  assert.equal(elements.get('btn-bgm')['aria-pressed'], 'true');
  await elements.get('btn-bgm').events.click();
  assert.equal(stops, 1);
  assert.equal(elements.get('btn-lobby-bgm')['aria-pressed'], 'false');
  await elements.get('btn-bgm').events.click();
  assert.equal(buffers, 1); assert.equal(starts, 2);
});
