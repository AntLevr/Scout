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
    addEventListener(name, fn) { this.events[name] = fn; }
    setAttribute(name, value) { this[name] = value; }
    querySelectorAll() { return this.children; }
    getBoundingClientRect() { return { left: 6, right: 64, top: 64, width: 340, height: 40 }; }
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
