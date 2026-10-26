'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查：云平台（Render 等）用它判断服务是否就绪
app.get('/healthz', (req, res) => {
  res.status(200).type('text/plain').send('ok');
});

/* ------------------------------------------------------------------ *
 * 牌库与牌型判断
 * ------------------------------------------------------------------ */

// 45 张牌：1..10 之间所有两个不同数字的无序组合，每张牌正反两个数字。
function makeDeck() {
  const deck = [];
  let id = 0;
  for (let a = 1; a <= 10; a++) {
    for (let b = a + 1; b <= 10; b++) {
      deck.push({ id: id++, a, b });
    }
  }
  return deck; // 长度 45
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 牌当前朝向的生效数字：up === 'b' 则取 b，否则取 a
function activeValue(card) {
  return card.up === 'b' ? card.b : card.a;
}

// 牌背面（非当前朝向）的数字
function otherValue(card) {
  return card.up === 'b' ? card.a : card.b;
}

// 判定一组数字是否是合法牌型（同数 set / 顺子 run），并给出类型与最大数字。
function classify(values) {
  const n = values.length;
  if (n === 0) return { valid: false, type: null, top: 0 };
  if (n === 1) return { valid: true, type: 'set', top: values[0] };

  const allSame = values.every((v) => v === values[0]);
  if (allSame) return { valid: true, type: 'set', top: values[0] };

  let asc = true;
  let desc = true;
  for (let i = 1; i < n; i++) {
    if (values[i] !== values[i - 1] + 1) asc = false;
    if (values[i] !== values[i - 1] - 1) desc = false;
  }
  if (asc || desc) return { valid: true, type: 'run', top: Math.max(...values) };
  return { valid: false, type: null, top: 0 };
}

// 比较：张数多者胜；张数相同比最大数字；再相同则「同数」胜过「顺子」。
function showBeats(newShow, curShow) {
  if (newShow.length !== curShow.length) return newShow.length > curShow.length;
  if (newShow.type !== curShow.type) return newShow.type === 'set'; // 同张数：同数 > 顺子
  return newShow.top > curShow.top;
}

/* ------------------------------------------------------------------ *
 * 房间与状态
 * ------------------------------------------------------------------ */

const rooms = new Map();

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function newRoom(code) {
  return {
    code,
    hostId: null,
    players: [], // {id, name, socketId, connected, hand, scorePile, chips, totalScore, roundScore, scoutShowUsed, confirmed}
    phase: 'lobby', // lobby | orient | playing | roundEnd | gameEnd
    round: 0,
    totalRounds: 0,
    startPlayerIdx: 0,
    currentIdx: 0,
    currentShow: null, // {ownerIdx, cards:[...], type, top, length}
    mustShow: false,
    lastRound: null, // 上轮结算明细
    abandoned: false, // 是否因玩家退出而结束
    eventSeq: 0, // 音效事件序号
    lastEvent: null, // { type: 'show'|'scout'|'score', seq }
  };
}

function getRoom(code) {
  return rooms.get(code);
}

function playerBySocket(room, socketId) {
  return room.players.find((p) => p.socketId === socketId);
}

function playerById(room, pid) {
  return room.players.find((p) => p.id === pid);
}

// 根据当前 socket 动态查找玩家索引（避免玩家离开后索引失真）
function playerIndexBySocket(room, socketId) {
  const p = playerBySocket(room, socketId);
  return p ? room.players.indexOf(p) : -1;
}

const DEAL_SIZE = { 2: 11, 3: 15, 4: 11, 5: 9 };

function startRound(room) {
  const n = room.players.length;
  room.round += 1;
  room.totalRounds = n;
  room.phase = 'orient';
  room.currentShow = null;
  room.mustShow = false;
  room.lastRound = null;

  let deck = shuffle(makeDeck());
  // 4 人局移除 1 张随机牌（洗牌后直接丢掉最后一张），凑成 44 张平均分配。
  if (n === 4) deck = deck.slice(0, 44);
  // 2 人局只用 22 张，其余弃置。
  const per = DEAL_SIZE[n] || 15;

  const hands = room.players.map(() => []);
  let c = 0;
  for (let i = 0; i < per; i++) {
    for (let p = 0; p < n; p++) {
      if (c < deck.length) {
        const card = deck[c++];
        card.up = 'a'; // 发牌时统一朝向
        hands[p].push(card);
      }
    }
  }

  room.players.forEach((p, i) => {
    p.hand = hands[i];
    p.scorePile = [];
    p.chips = n === 2 ? 3 : 0; // 2 人变体每人 3 个筹码，3-5 人局从 0 开始
    p.scoutShowUsed = false;
    p.confirmed = false;
    p.roundScore = 0;
  });
}

/* ------------------------------------------------------------------ *
 * 状态广播
 * ------------------------------------------------------------------ */

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    totalRounds: room.totalRounds,
    startPlayerIdx: room.startPlayerIdx,
    currentIdx: room.currentIdx,
    mustShow: room.mustShow,
    abandoned: room.abandoned,
    lastEvent: room.lastEvent,
    players: room.players.map((p, i) => ({
      idx: i,
      name: p.name,
      handCount: p.hand.length,
      chips: p.chips,
      scorePileCount: p.scorePile.length,
      totalScore: p.totalScore,
      roundScore: p.roundScore,
      scoutShowUsed: p.scoutShowUsed,
      confirmed: p.confirmed,
      connected: p.connected,
      isHost: p.id === room.hostId,
    })),
    currentShow: room.currentShow
      ? {
          ownerIdx: room.currentShow.ownerIdx,
          type: room.currentShow.type,
          top: room.currentShow.top,
          length: room.currentShow.length,
          cards: room.currentShow.cards.map((c) => ({ value: activeValue(c), other: otherValue(c) })),
        }
      : null,
    lastRound: room.lastRound,
  };
}

function privateState(room, playerIdx) {
  const p = room.players[playerIdx];
  return {
    yourIdx: playerIdx,
    hand: p.hand.map((c) => ({ id: c.id, a: c.a, b: c.b, up: c.up, value: activeValue(c) })),
    scoutShowUsed: p.scoutShowUsed,
    canScout: room.currentShow !== null && !room.mustShow && (room.players.length !== 2 || p.chips > 0),
    isTwoPlayer: room.players.length === 2,
  };
}

function broadcast(room) {
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (!p.socketId) continue;
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) {
      sock.emit('state', { public: publicState(room), private: privateState(room, i) });
    }
  }
}

function error(socket, message) {
  socket.emit('error', { message });
}

/* ------------------------------------------------------------------ *
 * 回合推进与结算
 * ------------------------------------------------------------------ */

function endRound(room, kind, winnerIdx) {
  room.phase = 'roundEnd';
  room.lastEvent = { type: 'score', seq: ++room.eventSeq, targetIdx: winnerIdx };
  const detail = room.players.map((p, i) => {
    let penalty = p.hand.length;
    if ((kind === 'survived' || kind === 'twoPlayerStuck') && i === winnerIdx) penalty = 0; // 表演存活者手牌不扣分
    if (kind === 'wentOut' && i === winnerIdx) penalty = 0; // 出完牌者无手牌
    const roundScore = p.scorePile.length + p.chips - penalty;
    p.roundScore = roundScore;
    p.totalScore += roundScore;
    return {
      idx: i,
      name: p.name,
      captured: p.scorePile.length,
      chips: p.chips,
      handLeft: p.hand.length,
      penalty,
      roundScore,
      totalScore: p.totalScore,
    };
  });

  room.lastRound = {
    kind,
    winnerIdx,
    detail,
  };

  const n = room.players.length;
  room.startPlayerIdx = (room.startPlayerIdx + 1) % n; // 下一轮换起始玩家
  if (room.round >= n) {
    room.phase = 'gameEnd';
  }
  broadcast(room);
}

function nextTurn(room) {
  const n = room.players.length;
  room.currentIdx = (room.currentIdx + 1) % n;
  // 表演存活一圈回到其主人手里 => 本轮结束
  if (room.currentShow && room.currentShow.ownerIdx === room.currentIdx) {
    endRound(room, 'survived', room.currentIdx);
    return;
  }
  room.mustShow = room.currentShow === null;
}

// 该玩家是否存在任一合法且能压过当前表演的连续组合
function canBeatCurrentShow(room, idx) {
  const hand = room.players[idx].hand;
  const cur = room.currentShow;
  for (let a = 0; a < hand.length; a++) {
    for (let b = a; b < hand.length; b++) {
      const values = [];
      for (let k = a; k <= b; k++) values.push(activeValue(hand[k]));
      const cls = classify(values);
      if (cls.valid) {
        const cand = { length: b - a + 1, type: cls.type, top: cls.top };
        if (showBeats(cand, { length: cur.length, type: cur.type, top: cur.top })) return true;
      }
    }
  }
  return false;
}

// 2 人局：无筹码且无法压过当前表演 => 对手获胜
function checkTwoPlayerStuck(room) {
  if (room.players.length !== 2 || room.phase !== 'playing') return;
  if (!room.currentShow) return; // 无表演时单张即可表演，不会卡死
  const idx = room.currentIdx;
  const p = room.players[idx];
  if (p.chips > 0) return;
  if (canBeatCurrentShow(room, idx)) return;
  const opp = (idx + 1) % 2;
  endRound(room, 'twoPlayerStuck', opp);
}

/* ------------------------------------------------------------------ *
 * 动作：表演
 * ------------------------------------------------------------------ */

function doShow(room, playerIdx, indices) {
  const p = room.players[playerIdx];
  const n = p.hand.length;
  if (!Array.isArray(indices) || indices.length === 0) return { ok: false, msg: '请选择要打出的牌' };
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= n) return { ok: false, msg: '选中的牌不存在' };
  }
  const sorted = indices.slice().sort((a, b) => a - b);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k] !== sorted[k - 1] + 1) return { ok: false, msg: '只能打出相邻的手牌' };
  }

  const cards = sorted.map((i) => p.hand[i]);
  const values = cards.map(activeValue);
  const cls = classify(values);
  if (!cls.valid) return { ok: false, msg: '这不是合法的组合（需为顺子或同数）' };

  const newShow = { length: cards.length, type: cls.type, top: cls.top };

  if (room.currentShow) {
    if (!showBeats(newShow, room.currentShow)) {
      return { ok: false, msg: '必须打出更强的组合才能压过当前表演' };
    }
    // 收走被压过的表演，作为得分牌
    p.scorePile.push(...room.currentShow.cards);
    room.currentShow = null;
  }

  // 移出手牌（从后往前删）
  for (let k = sorted.length - 1; k >= 0; k--) p.hand.splice(sorted[k], 1);

  room.currentShow = {
    ownerIdx: playerIdx,
    cards,
    type: cls.type,
    top: cls.top,
    length: cards.length,
  };
  room.mustShow = false;
  room.lastEvent = { type: 'show', seq: ++room.eventSeq, targetIdx: playerIdx };

  if (p.hand.length === 0) {
    endRound(room, 'wentOut', playerIdx);
    return { ok: true };
  }

  nextTurn(room);
  checkTwoPlayerStuck(room);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 动作：挖角（取当前表演最左/最右一张牌）
 * ------------------------------------------------------------------ */

function doScout(room, playerIdx, opts) {
  if (!room.currentShow) return { ok: false, msg: '当前没有可挖角的表演' };
  const p = room.players[playerIdx];

  if (room.players.length === 2) {
    // 2 人变体：挖角需消耗自己 1 个筹码
    if (p.chips <= 0) return { ok: false, msg: '没有筹码可用来挖角' };
  }

  const edge = opts.edge === 'right' ? 'right' : 'left';
  const card =
    edge === 'left' ? room.currentShow.cards.shift() : room.currentShow.cards.pop();

  // 选择朝向
  card.up = opts.up === 'b' ? 'b' : 'a';

  // 插入位置
  let insertIndex = Number.isInteger(opts.insertIndex) ? opts.insertIndex : p.hand.length;
  insertIndex = Math.max(0, Math.min(p.hand.length, insertIndex));
  p.hand.splice(insertIndex, 0, card);

  // 表演主人（被挖角者）获得 1 个筹码（= 1 分，所有人数通用）
  room.players[room.currentShow.ownerIdx].chips += 1;
  if (room.players.length === 2) {
    p.chips -= 1; // 2 人局：挖角者额外消耗 1 个筹码
  }
  room.lastEvent = { type: 'scout', seq: ++room.eventSeq, targetIdx: playerIdx };

  const scoutShow = !!opts.scoutShow;

  // 表演被拿空
  if (room.currentShow.cards.length === 0) {
    room.currentShow = null;
    // 2 人局：拿空后当前玩家继续（按变体规则本轮仍可继续），否则换人
  } else {
    // 更新表演描述（类型/最大/张数），场上展示与比较都基于最新牌
    const vals = room.currentShow.cards.map(activeValue);
    const cls = classify(vals);
    room.currentShow.type = cls.type;
    room.currentShow.top = cls.top;
    room.currentShow.length = room.currentShow.cards.length;
  }

  if (scoutShow && !p.scoutShowUsed && room.players.length !== 2) {
    p.scoutShowUsed = true;
    // 挖角后能否表演：无当前表演则单张即可；有表演则需能压过
    const canShow = (room.currentShow === null) || canBeatCurrentShow(room, playerIdx);
    if (canShow) {
      room.mustShow = true; // 该玩家必须立即表演
      return { ok: true, scoutShowTriggered: true };
    }
    // 挖角后仍无法表演：退还 token，按普通挖角结束回合
    p.scoutShowUsed = false;
    nextTurn(room);
    return { ok: true };
  }

  if (room.players.length === 2) {
    // 2 人局：挖角后该玩家再次行动（不换人）
    if (room.currentShow === null) room.mustShow = true;
    else room.mustShow = false;
    checkTwoPlayerStuck(room);
    return { ok: true };
  }

  nextTurn(room);
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * 客户端查卡：挖角前获取当前表演某侧卡牌的完整两面
 * ------------------------------------------------------------------ */

function scoutPreview(room, playerIdx, edge) {
  if (!room.currentShow) return { ok: false };
  const cards = room.currentShow.cards;
  if (cards.length === 0) return { ok: false };
  const card = edge === 'right' ? cards[cards.length - 1] : cards[0];
  return { ok: true, edge: edge === 'right' ? 'right' : 'left', card: { a: card.a, b: card.b, value: activeValue(card) } };
}

/* ------------------------------------------------------------------ *
 * Socket 连接
 * ------------------------------------------------------------------ */

io.on('connection', (socket) => {
  let joinedRoom = null;
  let joinedIdx = -1;

  socket.on('join', (payload, ack) => {
    const code = String(payload && payload.room || '').trim().toUpperCase();
    const name = String(payload && payload.name || '').trim().slice(0, 12) || '玩家';
    let room = rooms.get(code);
    if (!room) {
      room = newRoom(code);
      rooms.set(code, room);
    }

    // 断线重连：凭 playerId 找回座位
    const pid = payload && payload.playerId;
    if (pid) {
      const existing = playerById(room, pid);
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        joinedRoom = room;
        joinedIdx = room.players.indexOf(existing);
        if (typeof ack === 'function') ack({ ok: true, code: room.code, playerId: existing.id, idx: joinedIdx });
        broadcast(room);
        return;
      }
    }

    if (room.phase !== 'lobby') {
      if (typeof ack === 'function') ack({ ok: false, message: '游戏已开始，无法中途加入' });
      return;
    }
    if (room.players.length >= 5) {
      if (typeof ack === 'function') ack({ ok: false, message: '房间已满（最多 5 人）' });
      return;
    }

    const player = {
      id: crypto.randomUUID(),
      name,
      socketId: socket.id,
      connected: true,
      hand: [],
      scorePile: [],
      chips: 0,
      totalScore: 0,
      roundScore: 0,
      scoutShowUsed: false,
      confirmed: false,
    };
    if (!room.hostId) room.hostId = player.id;
    room.players.push(player);
    joinedRoom = room;
    joinedIdx = room.players.length - 1;

    if (typeof ack === 'function') ack({ ok: true, code: room.code, playerId: player.id, idx: joinedIdx });
    broadcast(room);
  });

  socket.on('startGame', (payload, ack) => {
    const room = joinedRoom;
    if (!room) return;
    const p = playerBySocket(room, socket.id);
    if (!p) return;
    if (room.phase !== 'lobby') return;
    const n = room.players.length;
    if (n < 2) {
      if (typeof ack === 'function') ack({ ok: false, message: '至少需要 2 名玩家' });
      return;
    }
    room.startPlayerIdx = room.players.findIndex((x) => x.id === room.hostId);
    if (room.startPlayerIdx < 0) room.startPlayerIdx = 0;
    room.currentIdx = room.startPlayerIdx;
    room.round = 0;
    room.players.forEach((x) => (x.totalScore = 0));
    startRound(room);
    if (typeof ack === 'function') ack({ ok: true });
    broadcast(room);
  });

  socket.on('flipHand', () => {
    const room = joinedRoom;
    if (!room) return;
    const idx = playerIndexBySocket(room, socket.id);
    if (room.phase !== 'orient') return;
    const p = room.players[idx];
    p.hand.forEach((c) => {
      c.up = c.up === 'b' ? 'a' : 'b';
    });
    broadcast(room);
  });

  socket.on('confirmHand', () => {
    const room = joinedRoom;
    if (!room) return;
    const idx = playerIndexBySocket(room, socket.id);
    if (room.phase !== 'orient') return;
    room.players[idx].confirmed = true;
    if (room.players.every((p) => p.confirmed)) {
      room.phase = 'playing';
      room.currentIdx = room.startPlayerIdx;
      room.mustShow = true;
    }
    broadcast(room);
  });

  socket.on('show', (payload, ack) => {
    const room = joinedRoom;
    if (!room) return;
    const idx = playerIndexBySocket(room, socket.id);
    if (room.phase !== 'playing') return;
    if (room.currentIdx !== idx) {
      if (typeof ack === 'function') ack({ ok: false, message: '还没轮到你' });
      return;
    }
    const r = doShow(room, idx, payload && payload.indices);
    if (!r.ok) {
      if (typeof ack === 'function') ack({ ok: false, message: r.msg });
      error(socket, r.msg);
      return;
    }
    if (typeof ack === 'function') ack({ ok: true });
    broadcast(room);
  });

  socket.on('scoutPreview', (payload, ack) => {
    const room = joinedRoom;
    if (!room) return;
    const idx = playerIndexBySocket(room, socket.id);
    if (room.phase !== 'playing' || room.currentIdx !== idx) return;
    const r = scoutPreview(room, idx, payload && payload.edge);
    if (typeof ack === 'function') ack(r);
  });

  socket.on('scout', (payload, ack) => {
    const room = joinedRoom;
    if (!room) return;
    const idx = playerIndexBySocket(room, socket.id);
    if (room.phase !== 'playing') return;
    if (room.currentIdx !== idx) {
      if (typeof ack === 'function') ack({ ok: false, message: '还没轮到你' });
      return;
    }
    if (room.mustShow) {
      if (typeof ack === 'function') ack({ ok: false, message: '本轮必须先表演（无当前表演）' });
      return;
    }
    if (!room.currentShow) {
      if (typeof ack === 'function') ack({ ok: false, message: '当前没有可挖角的表演' });
      return;
    }
    const r = doScout(room, idx, payload || {});
    if (!r.ok) {
      if (typeof ack === 'function') ack({ ok: false, message: r.msg });
      error(socket, r.msg);
      return;
    }
    if (typeof ack === 'function') ack({ ok: true });
    broadcast(room);
  });

  socket.on('nextRound', (payload, ack) => {
    const room = joinedRoom;
    if (!room) return;
    const p = playerBySocket(room, socket.id);
    if (!p) return;
    if (room.phase === 'gameEnd') {
      if (typeof ack === 'function') ack({ ok: false, message: '游戏已结束' });
      return;
    }
    if (room.phase !== 'roundEnd') return;
    startRound(room);
    if (typeof ack === 'function') ack({ ok: true });
    broadcast(room);
  });

  socket.on('rematch', (payload, ack) => {
    const room = joinedRoom;
    if (!room) return;
    const p = playerBySocket(room, socket.id);
    if (!p) return;
    if (room.phase !== 'gameEnd') return;
    room.round = 0;
    room.players.forEach((x) => (x.totalScore = 0));
    room.startPlayerIdx = room.players.findIndex((x) => x.id === room.hostId);
    if (room.startPlayerIdx < 0) room.startPlayerIdx = 0;
    room.currentIdx = room.startPlayerIdx;
    startRound(room);
    if (typeof ack === 'function') ack({ ok: true });
    broadcast(room);
  });

  socket.on('leaveGame', (payload, ack) => {
    const room = joinedRoom;
    if (!room) { if (typeof ack === 'function') ack({ ok: true }); return; }
    const p = playerBySocket(room, socket.id);
    if (!p) { if (typeof ack === 'function') ack({ ok: true }); return; }

    const wasInGame = room.phase !== 'lobby';
    room.players = room.players.filter((x) => x.id !== p.id);

    if (room.players.length === 0) {
      rooms.delete(room.code);
      if (typeof ack === 'function') ack({ ok: true });
      return;
    }

    if (room.hostId === p.id) room.hostId = room.players[0].id;

    if (wasInGame) {
      // 对局中主动退出：结束本局，剩余玩家进入结算
      room.phase = 'gameEnd';
      room.lastRound = null;
      room.abandoned = true;
    }

    if (typeof ack === 'function') ack({ ok: true });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = joinedRoom;
    if (!room) return;
    const p = playerBySocket(room, socket.id);
    if (p) p.connected = false;
    // 大厅中离开则移除；游戏中保留座位以便重连
    if (room.phase === 'lobby' && p) {
      room.players = room.players.filter((x) => x.id !== p.id);
      if (room.hostId === p.id && room.players.length > 0) room.hostId = room.players[0].id;
      if (room.players.length === 0) rooms.delete(room.code);
    }
    broadcast(room);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🎪 马戏星探 Scout 线上联机版已启动');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  console.log('  好友联机:   用内网穿透工具（如 Cloudflare Tunnel）暴露本端口后分享公网地址');
  console.log('');
});
