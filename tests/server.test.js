'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
  let connected;
  const sockets = new Map();
  class Server {
    constructor() { this.sockets = { sockets }; }
    on(event, handler) { connected = handler; }
  }
  const express = () => ({ use() {}, get() {} });
  express.static = () => {};
  const context = vm.createContext({
    require(name) {
      if (name === 'express') return express;
      if (name === 'socket.io') return { Server };
      if (name === 'http') return { createServer: () => ({ listen() {} }) };
      return require(name);
    },
    __dirname: path.resolve(__dirname, '..'), process, console,
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8'), context);
  function client(id) {
    const handlers = {}, events = [];
    const socket = { id, events,
      on(event, fn) { handlers[event] = fn; },
      emit(event, data) { events.push({ event, data }); },
      disconnect() { sockets.delete(id); handlers.disconnect(); },
      action(event, payload = {}) {
        let result;
        handlers[event](payload, (value) => { result = value; });
        return result;
      },
      state() { return events.filter((e) => e.event === 'state').at(-1)?.data; },
    };
    sockets.set(id, socket); connected(socket); return socket;
  }
  const room = () => vm.runInContext("rooms.get('TEST')", context);
  const a = client('a'), b = client('b');
  const joined = a.action('join', { room: 'TEST', name: '<b>A</b>' });
  b.action('join', { room: 'TEST', name: 'B' });
  function start() {
    a.action('ready'); b.action('ready');
    assert.equal(a.action('startGame').ok, true);
  }
  return { a, b, client, room, context, joined, start };
}

test('only host can start and host never needs to ready', () => {
  const { a, b, room } = setup();
  assert.equal(a.action('startGame').ok, false);
  assert.equal(a.action('ready').ok, false);
  b.action('ready');
  assert.equal(b.action('startGame').ok, false);
  assert.equal(room().players[0].ready, false);
  assert.equal(a.action('startGame').ok, true);
  assert.equal(room().phase, 'orient');
});

test('takeover disables old connection without losing lobby seat', () => {
  const { a, b, client, joined, room } = setup();
  const fresh = client('fresh');
  fresh.action('join', { room: 'TEST', playerId: joined.playerId });
  assert.equal(room().players.length, 2);
  assert(a.events.some((e) => e.event === 'sessionReplaced'));
  fresh.action('ready'); b.action('ready'); fresh.action('startGame');
  assert.doesNotThrow(() => { a.action('flipHand'); a.action('confirmHand'); });
  assert.equal(room().players[0].confirmed, false);
  fresh.action('confirmHand');
  const before = JSON.stringify(room().players[0].hand);
  fresh.action('flipHand');
  assert.equal(JSON.stringify(room().players[0].hand), before);
});

test('exit clears indexed table, and departed socket loses room access', () => {
  const { a, b, room, start } = setup(); start();
  a.action('confirmHand'); b.action('confirmHand');
  a.action('show', { indices: [0] });
  a.action('leaveGame');
  assert.equal(room().phase, 'gameEnd');
  assert.equal(room().currentShow, null);
  assert.equal(room().currentIdx, 0);
  assert.equal(a.action('chat', { text: 'old' }).ok, false);
  assert.equal(b.action('rematch'), undefined);
});

test('history is separate from action snapshots and restored on join', () => {
  const { a, b, client, joined, start } = setup();
  a.action('chat', { text: 'hello' }); start();
  const state = b.state();
  assert.equal('chat' in state.public, false);
  assert.equal('logs' in state.public, false);
  assert(b.events.some((e) => e.event === 'gameLog'));
  const fresh = client('fresh'); fresh.action('join', { room: 'TEST', playerId: joined.playerId });
  const history = fresh.events.find((e) => e.event === 'history').data;
  assert.equal(history.chat[0].text, 'hello');
  assert(history.logs.length > 0);
});

test('complete game: scoring, round readiness, results and rematch reset', () => {
  const { a, b, room, start } = setup(); start();
  function finishRound() {
    a.action('confirmHand'); b.action('confirmHand');
    const r = room(), current = r.currentIdx === 0 ? a : b;
    r.players[r.currentIdx].hand = [{ id: 100, a: 1, b: 9, up: 'b' }];
    assert.equal(current.action('show', { indices: [0] }).ok, true);
  }
  finishRound(); assert.equal(room().phase, 'roundEnd');
  assert.equal(room().results.length, 1);
  assert.equal(a.action('nextRound').ok, false);
  a.action('ready'); assert.equal(room().round, 1);
  b.action('ready'); assert.equal(room().round, 1);
  assert.equal(b.action('nextRound').ok, false);
  assert.equal(a.action('nextRound').ok, true);
  assert.equal(room().round, 2);
  assert.equal(room().players.every((p) => !p.ready), true);
  finishRound(); assert.equal(room().phase, 'gameEnd');
  assert.equal(room().results.length, 2);
  a.action('ready'); b.action('ready');
  assert.equal(b.action('rematch').ok, false);
  assert.equal(a.action('rematch').ok, true);
  assert.equal(room().results.length, 0);
  assert.equal(room().round, 1);
  assert(room().players.every((p) => p.totalScore === 0));
});

test('scout+show keeps same turn and requires show; invalid show changes nothing', () => {
  const { a, b, client, room } = setup();
  const c = client('c'); c.action('join', { room: 'TEST', name: 'C' });
  for (const s of [a, b, c]) s.action('ready');
  a.action('startGame'); for (const s of [a, b, c]) s.action('confirmHand');
  const r = room();
  r.players[0].hand = [{ id: 1, a: 1, b: 2, up: 'a' }, { id: 2, a: 2, b: 3, up: 'a' }];
  a.action('show', { indices: [0] });
  assert.equal(b.action('scout', { edge: 'left', up: 'b', insertIndex: 0, scoutShow: true }).ok, true);
  assert.equal(r.currentIdx, 1); assert.equal(r.mustShow, true);
  assert.equal(r.players[1].scoutShowUsed, true);
  assert.equal(b.action('scout').ok, false);
  const before = JSON.stringify(r.players[1].hand);
  assert.equal(b.action('show', { indices: [0, 2] }).ok, false);
  assert.equal(JSON.stringify(r.players[1].hand), before);
  assert.equal(b.action('show', { indices: [0] }).ok, true);
});

test('disconnect cancels readiness and reconnect restores identity without readiness', () => {
  const { a, b, client, joined, room } = setup();
  a.action('ready'); b.action('ready');
  a.disconnect();
  // Lobby disconnect removes the seat; in-game disconnect retains it instead.
  assert.equal(room().players.length, 1);
  const host = client('host'); host.action('join', { room: 'TEST', name: 'C' });
  b.action('ready'); host.action('ready'); b.action('startGame');
  const pid = room().players[1].id;
  host.disconnect();
  assert.equal(room().players[1].connected, false);
  assert.equal(room().players[1].ready, false);
  const fresh = client('fresh');
  assert.equal(fresh.action('join', { room: 'TEST', playerId: pid }).ok, true);
  assert.equal(room().players[1].connected, true);
});

test('all player counts receive independent random card orientations', () => {
  for (const n of [2, 3, 4, 5]) {
    const { a, b, client, room, context } = setup();
    const clients = [a, b];
    for (let i = 2; i < n; i++) {
      const c = client(`extra${i}`); c.action('join', { room: 'TEST', name: 'C' }); clients.push(c);
    }
    vm.runInContext('let randomCounter = 0; Math.random = () => randomCounter++ % 2 ? 0.75 : 0.25', context);
    clients.forEach((c) => c.action('ready')); a.action('startGame');
    const cards = room().players.flatMap((p) => p.hand);
    assert.equal(cards.length, { 2: 22, 3: 45, 4: 44, 5: 45 }[n]);
    assert.equal(new Set(cards.map((c) => c.id)).size, cards.length);
    assert(cards.some((c) => c.up === 'a')); assert(cards.some((c) => c.up === 'b'));
  }
});
