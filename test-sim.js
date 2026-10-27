'use strict';
// 集成测试：验证 3 人局与 2 人局的关键流程
const { io } = require('socket.io-client');
const URL = process.env.SCOUT_TEST_URL || 'http://localhost:3000';

function connect() {
  const s = io(URL, { transports: ['websocket'], forceNew: true });
  return new Promise((res) => s.on('connect', () => res(s)));
}
function ack(s, ev, payload) {
  return new Promise((res) => s.emit(ev, payload, (r) => res(r)));
}
function attach(s) { s.state = null; s.on('state', (d) => { s.state = d; }); }
function waitFor(s, pred, what, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (s.state && pred(s.state)) { clearInterval(iv); resolve(s.state); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); reject(new Error('timeout: ' + what)); }
    }, 20);
  });
}

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) { pass++; console.log('  ✔ ' + msg); } else { fail++; console.log('  ✘ ' + msg); } }

function classify(values) {
  const n = values.length;
  if (n === 1) return { valid: true, type: 'set', top: values[0] };
  if (values.every((v) => v === values[0])) return { valid: true, type: 'set', top: values[0] };
  let asc = true, desc = true;
  for (let i = 1; i < n; i++) { if (values[i] !== values[i - 1] + 1) asc = false; if (values[i] !== values[i - 1] - 1) desc = false; }
  if (asc || desc) return { valid: true, type: 'run', top: Math.max(...values) };
  return { valid: false };
}

// 在手牌中寻找最长（≥minLen）的合法连续组合
function findCombo(hand, minLen = 2) {
  for (let len = hand.length; len >= minLen; len--) {
    for (let start = 0; start + len <= hand.length; start++) {
      const vals = hand.slice(start, start + len).map((c) => c.value);
      if (classify(vals).valid) return { indices: Array.from({ length: len }, (_, i) => start + i), len };
    }
  }
  return null;
}

(async () => {
  /* ---------- 3 人局 ---------- */
  let [c0, c1, c2] = await Promise.all([connect(), connect(), connect()]);
  [c0, c1, c2].forEach(attach);
  const code = 'T' + String(Date.now()).slice(-3).replace(/\d/g, (d) => 'ABCDEFGHIJ'[d]);
  check((await ack(c0, 'join', { room: code, name: 'A' })).ok, '3人局：A 加入');
  check((await ack(c1, 'join', { room: code, name: 'B' })).ok, '3人局：B 加入');
  check((await ack(c2, 'join', { room: code, name: 'C' })).ok, '3人局：C 加入');
  for (const s of [c0, c1, c2]) await ack(s, 'ready', {});
  check((await ack(c0, 'startGame', {})).ok, '3人局：开始');
  await waitFor(c0, (s) => s.public.phase === 'orient', 'orient');
  check(c0.state.private.hand.length === 15, '3人局每人 15 张');
  c0.emit('confirmHand'); c1.emit('confirmHand'); c2.emit('confirmHand');
  await waitFor(c0, (s) => s.public.phase === 'playing', 'playing');
  await Promise.all([c0, c1, c2].map((s) => waitFor(s, (d) => d.public.phase === 'playing', 'playing')));
  const initial = [c0, c1, c2], p0 = c0.state.public.startPlayerIdx, p1 = (p0 + 1) % 3, p2 = (p0 + 2) % 3;
  [c0, c1, c2] = [initial[p0], initial[p1], initial[p2]];
  check(c0.state.public.currentIdx === p0 && c0.state.public.mustShow, '起始玩家0须表演');

  check(!(await ack(c0, 'show', { indices: [0, 2] })).ok, '不相邻出牌被拒绝');

  // 找最长合法组合（≥2），用于后续「存活」测试
  const combo = findCombo(c0.state.private.hand, 3) || findCombo(c0.state.private.hand, 2);
  const comboLen = combo ? combo.len : 1;
  const showIdx = combo ? combo.indices : [0];
  const showAck = await ack(c0, 'show', { indices: showIdx });
  check(showAck.ok, `玩家0 打出 ${showIdx.length} 张合法组合`);
  await waitFor(c0, (s) => s.public.currentIdx === p1, '轮到玩家1');
  check(c0.state.public.currentShow.ownerIdx === p0 && c0.state.public.currentShow.length === showIdx.length, '当前表演属于玩家0');

  // 玩家1 挖角（若表演被拿空则结束，否则继续）
  const sc1 = await ack(c1, 'scout', { edge: 'left', up: 'a', insertIndex: 0 });
  check(sc1.ok, '玩家1 挖角成功');
  await waitFor(c0, (s) => s.public.currentIdx === p2, '轮到玩家2');
  check(c0.state.public.players[p0].chips === 1, '玩家0 获 1 筹码');
  check(c0.state.public.players[p1].handCount === 16, '玩家1 手牌 16 张');

  if (comboLen >= 3) {
    // 表演还剩 ≥2 张，玩家2 再挖角后仍剩 ≥1 张 => 回到玩家0 => 存活结束
    const sc2 = await ack(c2, 'scout', { edge: 'left', up: 'a', insertIndex: 0 });
    check(sc2.ok, '玩家2 挖角成功');
    await waitFor(c0, (s) => s.public.phase === 'roundEnd', '存活结束');
    check(c0.state.public.lastRound.kind === 'survived' && c0.state.public.lastRound.winnerIdx === p0, '存活者=玩家0（手牌不扣分）');
    const w = c0.state.public.lastRound.detail[p0];
    check(w.penalty === 0, '存活者手牌 penalty=0');
  } else if (comboLen === 2) {
    // 2 张组合：玩家2 挖角后表演被拿空 => 回到玩家0 且必须表演
    const sc2 = await ack(c2, 'scout', { edge: 'left', up: 'a', insertIndex: 0 });
    check(sc2.ok, '玩家2 挖角成功（拿空表演）');
    await waitFor(c0, (s) => s.public.currentIdx === p0 && s.public.currentShow === null, '回到玩家0且无表演');
    check(c0.state.public.mustShow === true, '表演被拿空后玩家0必须表演');
    check(c0.state.public.players[p0].chips === 2, '玩家0 获 2 筹码');
  } else {
    check(c0.state.public.currentShow === null, '单张表演被挖空');
    check((await ack(c2, 'show', { indices: [0] })).ok, '无表演时下一玩家重新表演');
  }

  [c0, c1, c2].forEach((s) => s.disconnect());
  await new Promise((r) => setTimeout(r, 150));

  /* ---------- 2 人局 ---------- */
  let [d0, d1] = await Promise.all([connect(), connect()]);
  [d0, d1].forEach(attach);
  const code2 = 'X' + String(Date.now()).slice(-3).replace(/\d/g, (d) => 'ABCDEFGHIJ'[d]);
  await ack(d0, 'join', { room: code2, name: 'X' });
  await ack(d1, 'join', { room: code2, name: 'Y' });
  await ack(d0, 'ready', {}); await ack(d1, 'ready', {});
  check((await ack(d0, 'startGame', {})).ok, '2人局：开始（支持 2 人变体）');
  await waitFor(d0, (s) => s.public.phase === 'orient', '2p orient');
  check(d0.state.private.hand.length === 11 && d0.state.public.players[0].chips === 3, '2人局每人 11 张牌 + 3 筹码');
  d0.emit('confirmHand'); d1.emit('confirmHand');
  await waitFor(d0, (s) => s.public.phase === 'playing', '2p playing');
  await waitFor(d1, (s) => s.public.phase === 'playing', '2p playing');
  const first = d0.state.public.startPlayerIdx;
  if (first === 1) [d0, d1] = [d1, d0];
  const second = 1 - first;
  check((await ack(d0, 'show', { indices: [0] })).ok, '2p 玩家0 出单张');
  await waitFor(d0, (s) => s.public.currentIdx === second, '2p 轮到玩家1');
  const dsc = await ack(d1, 'scout', { edge: 'left', up: 'a', insertIndex: 0 });
  check(dsc.ok, '2p 玩家1 挖角（消耗筹码）');
  await waitFor(d0, (s) => s.public.players[second].chips === 2, '2p 筹码更新');
  check(d0.state.public.players[second].chips === 2, '2p 挖角后玩家1 剩 2 筹码');
  check(d0.state.public.currentIdx === second, '2p 挖角后玩家1 再次行动');

  console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败');
  [d0, d1].forEach((s) => s.disconnect());
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常：', e); process.exit(2); });
