'use strict';

const socket = io();

const S = {
  room: null,
  me: null,
  joined: false,
  playerId: localStorage.getItem('scout-playerId') || null,
  name: localStorage.getItem('scout-name') || '',
  selected: [], // 已选中的手牌索引（升序）
  scout: null, // 挖角弹窗状态机
  scoutPending: false,
  sessionActive: false,
  lastEventSeq: null, // 已播放的音效事件序号
};

function isOnline() { return socket.connected && S.sessionActive; }

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function $(id) { return document.getElementById(id); }

function setConnectionStatus(message) {
  const status = $('connection-status');
  status.textContent = message;
  status.title = message;
  status.dataset.connected = String(message === '已连接');
}

/* ---------------- 工具 ---------------- */

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function showOverlay(html) {
  $('modal').innerHTML = html;
  $('overlay').classList.remove('hidden');
}
function closeOverlay() {
  $('overlay').classList.add('hidden');
}

function classify(values) {
  const n = values.length;
  if (n === 0) return { valid: false, type: null, top: 0 };
  if (n === 1) return { valid: true, type: 'set', top: values[0] };
  if (values.every((v) => v === values[0])) return { valid: true, type: 'set', top: values[0] };
  let asc = true, desc = true;
  for (let i = 1; i < n; i++) {
    if (values[i] !== values[i - 1] + 1) asc = false;
    if (values[i] !== values[i - 1] - 1) desc = false;
  }
  if (asc || desc) return { valid: true, type: 'run', top: Math.max(...values) };
  return { valid: false, type: null, top: 0 };
}

function showBeats(a, b) {
  if (a.length !== b.length) return a.length > b.length;
  if (a.type !== b.type) return a.type === 'set'; // 同张数：同数 > 顺子
  return a.top > b.top;
}

const TYPE_CN = { set: '同数', run: '顺子' };

// 每个数字一种颜色（用于牌的两半着色）
const NUMBER_COLORS = {
  1: '#f0a3a3', 2: '#f4b06a', 3: '#efc94d', 4: '#9ccb77', 5: '#6fc6b0',
  6: '#7fb2e8', 7: '#a98ed9', 8: '#e091c0', 9: '#d0a678', 10: '#a3b3ca',
};

function cardEl(value, extra = {}) {
  const el = document.createElement('div');
  el.className = 'card' + (extra.small ? ' small' : '') + (extra.cls ? ' ' + extra.cls : '');
  if (extra.idx != null) el.dataset.idx = extra.idx;
  el.dataset.value = value;
  if (extra.sub != null) el.dataset.other = extra.sub;

  // 两半颜色：左上 = 当前朝向数字，右下 = 背面数字
  const aColor = NUMBER_COLORS[value] || '#fdf6e3';
  const bColor = (extra.sub != null ? NUMBER_COLORS[extra.sub] : aColor) || '#fdf6e3';
  el.style.setProperty('--half-a', aColor);
  el.style.setProperty('--half-b', bColor);

  const main = document.createElement('div');
  main.className = 'v-main' + (String(value).length > 1 ? ' d2' : '');
  if (value === 6 || value === 9) main.classList.add('underlined');
  main.textContent = value;
  el.appendChild(main);

  if (extra.sub != null) {
    const sub = document.createElement('div');
    sub.className = 'v-sub';
    if (extra.sub === 6 || extra.sub === 9) sub.classList.add('underlined');
    sub.textContent = extra.sub;
    el.appendChild(sub);
  }
  return el;
}

function copyText(text, message = '已复制房间码') {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast(message)).catch(() => toast('复制失败，请手动复制'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(message); } catch (e) { toast('复制失败，请手动记下'); }
    document.body.removeChild(ta);
  }
}

/* 移动端长按查看完整手牌，不改变选择或手牌朝向。 */
let cardHold = null;
let suppressCardClick = false;
function closeCardPreview() {
  if (cardHold) clearTimeout(cardHold.timer);
  cardHold = null;
  $('card-preview').classList.add('hidden');
  $('card-preview').replaceChildren();
}
$('hand').addEventListener('pointerdown', (event) => {
  if (!event.isPrimary || event.button !== 0 || (!isMobileLayout() && event.pointerType !== 'touch')) return;
  closeCardPreview();
  suppressCardClick = false;
  const card = event.target.closest('.card');
  if (!card) return;
  cardHold = { id: event.pointerId, x: event.clientX, y: event.clientY };
  cardHold.timer = setTimeout(() => {
    if (!cardHold) return;
    suppressCardClick = true;
    const preview = $('card-preview');
    preview.appendChild(cardEl(Number(card.dataset.value), { sub: Number(card.dataset.other) }));
    preview.classList.remove('hidden');
  }, 300);
});
document.addEventListener('pointermove', (event) => {
  if (cardHold && event.pointerId === cardHold.id && Math.hypot(event.clientX - cardHold.x, event.clientY - cardHold.y) > 10) closeCardPreview();
});
document.addEventListener('pointerup', closeCardPreview);
document.addEventListener('pointercancel', closeCardPreview);
window.addEventListener('blur', closeCardPreview);
window.addEventListener('resize', closeCardPreview);
$('hand').addEventListener('scroll', closeCardPreview);
$('hand').addEventListener('click', (event) => {
  if (!suppressCardClick) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);
$('hand').addEventListener('contextmenu', (event) => {
  if (isMobileLayout() || cardHold) event.preventDefault();
});

/* ---------------- 规则文本 ---------------- */

const RULES_HTML = `
<div class="rules-scroll">
<h3>🎪 目标</h3>
<p>组建更强的大秀，压过对手并「挖角」对方成员。每人都当一次起始玩家（共 3–5 轮）后，总分最高者获胜。</p>
<h3>🃏 牌与手牌</h3>
<ul>
<li>45 张牌，每张牌有两面、两个不同数字（1–10）。当前朝向的一面是「生效数字」。</li>
<li>手牌<strong>不能重排</strong>，只能打出<strong>相邻</strong>的牌。</li>
<li>发牌后可选择把<strong>整手牌一起翻转</strong>（换到另一面），之后不可再改。</li>
</ul>
<h3>🎪 表演（Show）</h3>
<ul>
<li>打出相邻的若干张牌，组成<strong>顺子</strong>（连续数字，可升可降）或<strong>同数</strong>（相同数字）。</li>
<li>必须压过当前表演：<strong>张数多者胜</strong>；张数相同先比<strong>同数 &gt; 顺子</strong>，再比<strong>最大数字</strong>。</li>
<li>被你压过的表演牌全部归你，每张 +1 分。</li>
</ul>
<h3>🕵️ 挖角（Scout）</h3>
<ul>
<li>从当前表演的<strong>最左或最右</strong>拿 1 张牌，以<strong>任意朝向、任意位置</strong>插入手牌。</li>
<li>表演主人获得 1 个筹码（+1 分）。</li>
<li>「✨ 挖角+表演」：每轮一次，挖角后可以立即表演。</li>
</ul>
<h3>🏁 一轮结束</h3>
<ul>
<li>有人<strong>出完手牌</strong>，或某个表演<strong>一圈没被压过</strong>（回到其主人手里）时，本轮结束。</li>
<li>计分：每张得分牌 +1、每个筹码 +1、每张剩余手牌 −1（表演存活者手牌不扣）。</li>
</ul>
<h3>👥 2 人变体</h3>
<p>每人发 11 张牌、3 个筹码。挖角需<strong>消耗自己 1 个筹码</strong>，且挖角后<strong>再次行动</strong>；没有筹码时必须表演，无法压过则判负。</p>
</div>`;

/* ---------------- 加入 / 大厅 ---------------- */

function randomRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function joinRoom(code, name) {
  socket.emit('join', { room: code, name, playerId: S.playerId }, (ack) => {
    if (!ack || !ack.ok) {
      toast(ack && ack.message ? ack.message : '加入失败');
      return;
    }
    S.playerId = ack.playerId;
    localStorage.setItem('scout-playerId', S.playerId);
    localStorage.setItem('scout-room', code);
    if (name) { S.name = name; localStorage.setItem('scout-name', name); }
    S.joined = true;
    renderLobby();
  });
}

function renderLobby() {
  if (S.joined && S.room) {
    $('lobby-form').classList.add('hidden');
    $('room-panel').classList.remove('hidden');
    $('room-code-value').textContent = S.room.code;
    const list = $('lobby-players');
    list.innerHTML = '';
    S.room.players.forEach((p) => {
      const div = document.createElement('div');
      div.className = 'player-item';
      const dot = document.createElement('span');
      dot.className = 'dot' + (p.connected ? '' : ' off');
      const nm = document.createElement('span');
      nm.className = 'pname';
      nm.textContent = p.name + (p.idx === S.me.yourIdx ? '（我）' : '') + (p.ready ? ' ✓ 已准备' : ' · 未准备');
      const host = document.createElement('span');
      if (p.isHost) { host.className = 'host-badge'; host.textContent = '房主'; }
      div.appendChild(dot); div.appendChild(nm); if (p.isHost) div.appendChild(host);
      list.appendChild(div);
    });
    const n = S.room.players.length;
    $('lobby-tip').textContent = n < 3 ? `等待玩家加入（当前 ${n} 人，至少 2 人可开局）…` : `当前 ${n} 人，可以开始！`;
    const isHost = S.room.players.find((p) => p.idx === S.me.yourIdx)?.isHost;
    $('btn-start').classList.toggle('hidden', S.room.settings.hostOnly && !isHost);
    $('btn-start').disabled = !isOnline() || n < 2 || !S.room.players.every((p) => p.ready && p.connected);
    $('btn-ready').textContent = S.room.players[S.me.yourIdx].ready ? '取消准备' : '准备';
    $('btn-ready').disabled = !isOnline();
    $('host-only').checked = S.room.settings.hostOnly;
    $('host-only').disabled = !isHost || !isOnline();
  } else {
    $('lobby-form').classList.remove('hidden');
    $('room-panel').classList.add('hidden');
  }
}

/* ---------------- 渲染主流程 ---------------- */

function render() {
  const room = S.room;
  const me = S.me;
  if (!room || !me) return;

  if (room.phase === 'lobby') {
    $('lobby').appendChild($('connection-status'));
    $('game').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    renderLobby();
    closeOverlay();
    return;
  }

  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('connection-slot').appendChild($('connection-status'));

  $('g-code').textContent = room.code;
  $('g-round').textContent = room.round;
  $('g-total').textContent = room.totalRounds;

  renderOpponents(room);
  renderTable(room);
  renderMyArea(room, me);
  renderTurnHint(room, me);

  if (room.phase === 'roundEnd') renderRoundEndModal(room);
  else if (room.phase === 'gameEnd') renderGameEndModal(room);
  else closeOverlay();
}

function renderTurnHint(room, me) {
  const el = $('turn-hint');
  if (room.phase === 'orient') { el.textContent = '整理手牌阶段'; return; }
  if (room.phase === 'roundEnd' || room.phase === 'gameEnd') { el.textContent = ''; return; }
  const cur = room.players[room.currentIdx];
  const isMe = room.currentIdx === me.yourIdx;
  el.textContent = isMe ? '轮到你了' : `等待 ${cur.name}…`;
}

function renderOpponents(room) {
  const el = $('opponents');
  el.innerHTML = '';
  room.players.forEach((p) => {
    if (p.idx === S.me.yourIdx) return;
    const div = document.createElement('div');
    div.className = 'opponent' + (p.idx === room.currentIdx ? ' active' : '');
    const name = document.createElement('div');
    name.className = 'oname';
    name.textContent = p.name;
    const row = document.createElement('div');
    row.className = 'orow';
    row.textContent = `手牌 ${p.handCount} · 筹码 ${p.chips} · 得分 ${p.scorePileCount} · 总分 ${p.totalScore}`;
    div.appendChild(name);
    div.appendChild(row);
    if (p.idx === room.currentShow?.ownerIdx) {
      const b = document.createElement('div');
      b.className = 'obadge';
      b.textContent = '🎪 表演中';
      div.appendChild(b);
    } else if (!p.scoutShowUsed && room.players.length !== 2) {
      const b = document.createElement('div');
      b.className = 'obadge';
      b.textContent = '✨ 挖角+表演';
      div.appendChild(b);
    }
    el.appendChild(div);
  });
}

function renderTable(room) {
  const el = $('table');
  el.innerHTML = '';
  if (!room.currentShow) {
    const empty = document.createElement('div');
    empty.className = 'table-empty';
    empty.textContent = '暂无表演 — 需要有人先表演（Show）';
    el.appendChild(empty);
    return;
  }
  const show = room.currentShow;
  const wrap = document.createElement('div');
  wrap.className = 'table-show';
  const owner = document.createElement('div');
  owner.className = 'show-owner';
  const ownerName = room.players[show.ownerIdx]?.name || '已离开的玩家';
  owner.innerHTML = `<b>${escapeHtml(ownerName)}</b> 的表演 <span class="show-type-badge ${show.type}">${TYPE_CN[show.type]}</span> <span style="opacity:.8">${show.length} 张 · 最大 ${show.top}</span>`;
  wrap.appendChild(owner);
  const cards = document.createElement('div');
  cards.className = 'show-cards';
  show.cards.forEach((c, i) => {
    const isEdge = S.scout && S.scout.step === 'pick' && (i === 0 || i === show.cards.length - 1);
    const card = cardEl(c.value, { sub: c.other, small: true, idx: i, cls: isEdge ? 'show-edge' : '' });
    if (isEdge) {
      card.addEventListener('click', () => pickScoutEdge(i === 0 ? 'left' : 'right'));
    }
    cards.appendChild(card);
  });
  wrap.appendChild(cards);
  if (S.scout && S.scout.step === 'pick') {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '点击最左或最右的一张牌进行挖角';
    wrap.appendChild(hint);
  }
  el.appendChild(wrap);
}

function renderMyArea(room, me) {
  $('my-captured').textContent = room.players[me.yourIdx].scorePileCount;
  $('my-chips').textContent = room.players[me.yourIdx].chips;
  $('my-total').textContent = room.players[me.yourIdx].totalScore;
  if (room.phase === 'orient') {
    renderOrientHand(me);
    renderInsertMarks();
    return;
  }

  renderHand(room, me);
  renderActions(room, me);
  renderInsertMarks();
}

function renderOrientHand(me) {
  closeCardPreview();
  const hand = $('hand');
  hand.innerHTML = '';
  me.hand.forEach((c) => {
    const other = c.value === c.a ? c.b : c.a;
    hand.appendChild(cardEl(c.value, { sub: other }));
  });
  fitHand();
  const actions = $('actions');
  const myConfirmed = S.room.players[me.yourIdx].confirmed;
  if (myConfirmed) {
    actions.innerHTML = '<div class="hint">✅ 已确认，等待其他玩家…</div>';
    $('action-hint').textContent = '等待其他玩家整理手牌…';
  } else {
    actions.innerHTML = `
      <button class="btn btn-gold" id="btn-flip">翻转整手</button>
      <button class="btn btn-primary" id="btn-confirm-hand">确认手牌</button>`;
    $('btn-flip').disabled = !isOnline();
    $('btn-confirm-hand').disabled = !isOnline();
    $('btn-flip').addEventListener('click', () => socket.emit('flipHand'));
    $('btn-confirm-hand').addEventListener('click', () => socket.emit('confirmHand'));
    $('action-hint').textContent = '可选择翻转整手牌（换到另一面数字），确定后点击确认。';
  }
}

function isContiguous(arr) {
  for (let k = 1; k < arr.length; k++) {
    if (arr[k] !== arr[k - 1] + 1) return false;
  }
  return true;
}

function renderHand(room, me) {
  closeCardPreview();
  const hand = $('hand');
  hand.innerHTML = '';
  const inserting = S.scout && S.scout.step === 'insert';

  me.hand.forEach((c, i) => {
    const other = c.value === c.a ? c.b : c.a;
    const inSel = S.selected.includes(i);
    const card = cardEl(c.value, { sub: other, idx: i, cls: inSel ? 'selected' : '' });
    if (!inserting) card.addEventListener('click', () => handTap(i));
    hand.appendChild(card);
  });

  fitHand();
}

function renderInsertMarks() {
  const marks = $('insert-marks');
  const inserting = S.scout && S.scout.step === 'insert';
  if (!inserting) { marks.innerHTML = ''; return; }

  const hand = $('hand');
  const cards = hand.querySelectorAll('.card');
  const n = cards.length;
  marks.innerHTML = '';
  if (!n) return;

  const marksRect = marks.getBoundingClientRect();
  for (let i = 0; i <= n; i++) {
    const rect = (i === n) ? cards[n - 1].getBoundingClientRect() : cards[i].getBoundingClientRect();
    const x = (i === n) ? rect.right : rect.left;
    const arrow = document.createElement('div');
    arrow.className = 'insert-arrow';
    arrow.style.left = (x - marksRect.left) + 'px';
    arrow.dataset.slot = i;
    arrow.textContent = '▼';
    arrow.addEventListener('click', () => confirmScout(i));
    marks.appendChild(arrow);
  }
}

function handTap(i) {
  if (S.scoutPending) return;
  if (S.scout && S.scout.step === 'pick') { S.scout = null; renderTable(S.room); }
  const idx = S.selected.indexOf(i);
  if (idx >= 0) S.selected.splice(idx, 1);   // 已选中 → 取消该牌
  else S.selected.push(i);                    // 未选中 → 选中该牌
  S.selected.sort((a, b) => a - b);
  updateSelection();
}

function updateSelection() {
  const room = S.room, me = S.me;
  if (room && me && room.phase === 'playing') {
    renderHand(room, me);
    renderSelectionHint(room, me);
    renderActions(room, me);
  }
}

function renderSelectionHint(room, me) {
  const hint = $('action-hint');
  const sel = S.selected;
  if (sel.length === 0) { hint.textContent = '点击手牌选择要打出的牌（需相邻）。'; return; }
  if (!isContiguous(sel)) { hint.textContent = '❌ 选中的牌必须相邻。'; return; }
  const cards = sel.map((i) => me.hand[i]);
  const values = cards.map((c) => c.value);
  const cls = classify(values);
  if (!cls.valid) {
    hint.textContent = '❌ 选中的牌不能组成顺子或同数。';
    return;
  }
  let beatText = '';
  if (room.currentShow) {
    const ok = showBeats({ length: cards.length, type: cls.type, top: cls.top }, { length: room.currentShow.length, type: room.currentShow.type, top: room.currentShow.top });
    beatText = ok ? ' ✅ 可以压过当前表演' : ' ❌ 压不过当前表演';
  }
  hint.textContent = `${values.join('-')}  ${TYPE_CN[cls.type]}（${cards.length} 张 · 最大 ${cls.top}）${beatText}`;
}

function renderActions(room, me) {
  const actions = $('actions');
  actions.innerHTML = '';
  if (!isOnline()) { $('action-hint').textContent = '连接中断，等待恢复…'; return; }
  if (S.scoutPending) { $('action-hint').textContent = '正在确认挖角…'; return; }
  if (room.phase !== 'playing') { $('action-hint').textContent = ''; return; }

  const myTurn = room.currentIdx === me.yourIdx;
  if (!myTurn) {
    $('action-hint').textContent = '等待其他玩家行动…';
    return; // 非自己回合：不显示表演/挖角按钮
  }

  // 挖角进行中
  if (S.scout) {
    renderScoutSteps(actions, S.scout.step, S.scout.scoutShow);
    if (S.scout.step === 'pick') {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-ghost';
      cancelBtn.textContent = '✖ 取消挖角';
      cancelBtn.addEventListener('click', cancelScout);
      actions.appendChild(cancelBtn);
    } else if (S.scout.step === 'insert') {
      // 翻转朝向
      const flipBtn = document.createElement('button');
      flipBtn.className = 'btn btn-gold';
      flipBtn.textContent = '🔄 翻转';
      flipBtn.addEventListener('click', flipScoutCard);
      actions.appendChild(flipBtn);

      // 预览卡（当前朝向，点击可翻转）
      const a = S.scout.card.a, b = S.scout.card.b;
      const v = S.scout.up === 'a' ? a : b;
      const other = S.scout.up === 'a' ? b : a;
      const preview = cardEl(v, { sub: other, small: true });
      preview.style.cursor = 'pointer';
      preview.title = '点击翻转朝向';
      preview.addEventListener('click', flipScoutCard);
      actions.appendChild(preview);

      // 取消
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-ghost';
      cancelBtn.textContent = '✖ 取消';
      cancelBtn.addEventListener('click', cancelScout);
      actions.appendChild(cancelBtn);
    }
    return;
  }

  const completingScoutShow = room.players.length !== 2 && me.scoutShowUsed && room.mustShow
    && room.lastEvent?.type === 'scout' && room.lastEvent.targetIdx === me.yourIdx;
  if (completingScoutShow) renderScoutSteps(actions, 'show', true);

  // 正常出牌
  const sel = S.selected;
  const canShow = sel.length > 0 && isContiguous(sel) && classify(sel.map((i) => me.hand[i]).map((c) => c.value)).valid;

  const showBtn = document.createElement('button');
  showBtn.className = 'btn btn-primary';
  showBtn.textContent = '🎪 表演';
  showBtn.disabled = !canShow;
  showBtn.addEventListener('click', () => doShow());
  actions.appendChild(showBtn);

  const scoutBtn = document.createElement('button');
  scoutBtn.className = 'btn';
  scoutBtn.textContent = room.players.length === 2 ? '🕵️ 挖角（消耗筹码）' : '🕵️ 挖角';
  scoutBtn.disabled = !me.canScout;
  scoutBtn.addEventListener('click', () => startScout(false));
  actions.appendChild(scoutBtn);

  if (room.players.length !== 2) {
    const comboBtn = document.createElement('button');
    comboBtn.className = 'btn btn-gold';
    comboBtn.textContent = me.scoutShowUsed ? '✨ 挖角＋表演（本轮已用）' : '✨ 挖角＋表演';
    comboBtn.disabled = !me.canScout || me.scoutShowUsed;
    comboBtn.addEventListener('click', () => startScout(true));
    actions.appendChild(comboBtn);
  }

  if (room.mustShow) {
    $('action-hint').textContent = completingScoutShow ? '挖角已完成，请选择手牌，完成表演。' : '必须表演：请选择手牌打出。';
  } else if (S.selected.length === 0) {
    $('action-hint').textContent = '选择要打出的牌，或点击「挖角」。';
  }
}

function doShow() {
  const sel = S.selected;
  if (sel.length === 0 || !isContiguous(sel)) return;
  socket.emit('show', { indices: sel }, (ack) => {
    if (ack && !ack.ok) toast(ack.message);
  });
  S.selected = [];
}

/* ---------------- 挖角（内联交互，无弹窗） ---------------- */

function renderScoutSteps(container, step, combo) {
  const steps = document.createElement('div');
  steps.className = 'scout-steps';
  steps.setAttribute('aria-label', combo ? '挖角加表演步骤' : '挖角步骤');
  const labels = [['pick', '选取场上牌'], ['insert', '插入手牌']];
  if (combo) labels.push(['show', '表演']);
  labels.forEach(([key, label], index) => {
    if (index) steps.appendChild(document.createTextNode(' → '));
    const item = document.createElement('span');
    item.textContent = label;
    if (key === step) { item.className = 'current'; item.setAttribute('aria-current', 'step'); }
    steps.appendChild(item);
  });
  container.appendChild(steps);
}

function startScout(scoutShow = false) {
  if (S.scoutPending || !S.me.canScout || (scoutShow && (S.me.scoutShowUsed || S.room.players.length === 2))) return;
  S.selected = [];
  S.scout = { step: 'pick', edge: null, card: null, up: null, scoutShow };
  renderHand(S.room, S.me);
  renderTable(S.room);
  $('action-hint').textContent = scoutShow ? '✨ 挖角＋表演：先点击当前表演最左或最右的一张牌。' : '🕵️ 点击当前表演最左或最右的一张牌。';
  renderActions(S.room, S.me);
}

function pickScoutEdge(edge) {
  const scout = S.scout;
  socket.emit('scoutPreview', { edge }, (ack) => {
    if (S.scout !== scout || !scout) return;
    if (!ack || !ack.ok) { toast('无法挖角'); return; }
    S.scout.edge = ack.edge;
    S.scout.card = ack.card;
    S.scout.up = (ack.card.value === ack.card.a) ? 'a' : 'b';
    S.scout.step = 'insert';
    renderTable(S.room);
    renderHand(S.room, S.me);
    renderActions(S.room, S.me);
    renderInsertMarks();
    $('action-hint').textContent = '点击手牌上方的「▼」插入；点「翻转」换朝向。';
  });
}

function flipScoutCard() {
  if (!S.scout) return;
  S.scout.up = S.scout.up === 'a' ? 'b' : 'a';
  renderActions(S.room, S.me);
}

function confirmScout(insertIndex) {
  const sc = S.scout;
  if (!sc || sc.step !== 'insert' || S.scoutPending) return;
  if (!isOnline()) { toast('连接已断开，请等待重连'); return; }
  // 先展示插入结果，避免云端往返期间界面毫无反馈；规则仍由服务端确认。
  S.scoutPending = true;
  S.scout = null;
  S.selected = [];
  const value = sc.up === 'a' ? sc.card.a : sc.card.b;
  const hand = S.me.hand.slice();
  hand.splice(insertIndex, 0, { ...sc.card, up: sc.up, value });
  renderHand(S.room, { ...S.me, hand });
  renderTable(S.room);
  renderActions(S.room, S.me);
  renderInsertMarks();
  socket.timeout(8000).emit('scout', { edge: sc.edge, up: sc.up, insertIndex, scoutShow: sc.scoutShow }, (err, ack) => {
    S.scoutPending = false;
    if (err || !ack || !ack.ok) {
      // 不改动本地权威状态，失败时直接恢复最近一次服务端手牌。
      render();
      toast(err ? '确认超时，请等待状态同步后再操作' : ack?.message || '挖角失败');
    }
  });
}

function cancelScout() {
  S.scout = null;
  renderTable(S.room);
  renderHand(S.room, S.me);
  renderActions(S.room, S.me);
  renderInsertMarks();
  $('action-hint').textContent = '选择要打出的牌，或点击「挖角」。';
}

/* ---------------- 结算弹窗 ---------------- */

function renderRoundEndModal(room) {
  const lr = room.lastRound;
  if (!lr) return;
  const winner = lr.detail[lr.winnerIdx];
  const endText =
    lr.kind === 'wentOut' ? `${escapeHtml(winner.name)} 出完了手牌！`
    : lr.kind === 'twoPlayerStuck' ? `${escapeHtml(winner.name)} 的表演无人能破！`
    : `${escapeHtml(winner.name)} 的表演坚持了一圈！`;
  let rows = '';
  lr.detail.forEach((d) => {
    const isWin = d.idx === lr.winnerIdx;
    rows += `<tr class="${isWin ? 'winner-row' : ''}">
      <td>${escapeHtml(d.name)}${isWin ? ' 🏆' : ''}</td>
      <td>+${d.captured}</td><td>+${d.chips}</td><td>−${d.penalty}</td>
      <td><b>${d.roundScore >= 0 ? '+' : ''}${d.roundScore}</b></td>
      <td>${d.totalScore}</td></tr>`;
  });
  showOverlay(`
    <h2>第 ${room.round} 轮结束</h2>
    <p style="text-align:center">${endText}</p>
    <table class="score-table">
      <tr><th>玩家</th><th>得分牌</th><th>筹码</th><th>手牌</th><th>本轮</th><th>总分</th></tr>
      ${rows}
    </table>
    ${renderReadiness(room)}
    ${renderResults(room)}
    <div class="modal-actions"><button class="btn btn-gold" id="btn-next-round">${room.players[S.me.yourIdx].ready ? '取消准备' : '准备下一轮'}</button></div>`);
  $('btn-next-round').disabled = !isOnline();
  $('btn-next-round').addEventListener('click', toggleReady);
}

function renderReadiness(room) {
  return `<p class="ready-summary">${room.players.map((p) => `${escapeHtml(p.name)}（${p.idx + 1}号位）${!p.connected ? '：离线' : p.ready ? '：已准备' : '：未准备'}`).join(' · ')}</p>`;
}

function renderResults(room) {
  if (!room.results.length) return '';
  return `<details class="results"><summary>逐轮战绩（${room.results.length} 轮）</summary>${room.results.map((r) => `<h3>第 ${r.round} 轮</h3><table class="score-table"><tr><th>玩家</th><th>得分牌</th><th>筹码</th><th>扣分</th><th>本轮</th><th>总分</th></tr>${r.detail.map((d) => `<tr><td>${escapeHtml(d.name)}（${d.idx + 1}）</td><td>${d.captured}</td><td>${d.chips}</td><td>${d.penalty}</td><td>${d.roundScore}</td><td>${d.totalScore}</td></tr>`).join('')}</table>`).join('')}</details>`;
}

function renderGameEndModal(room) {
  const sorted = room.players.slice().sort((a, b) => b.totalScore - a.totalScore);
  const winner = sorted[0];
  const winners = sorted.filter((p) => p.totalScore === winner.totalScore);
  const canRematch = room.players.length >= 2 && !room.abandoned;
  let rows = '';
  sorted.forEach((p, i) => {
    const rank = sorted.findIndex((x) => x.totalScore === p.totalScore) + 1;
    rows += `<tr class="${rank === 1 && !room.abandoned ? 'winner-row' : ''}">
      <td>${rank}</td><td>${escapeHtml(p.name)}${rank === 1 && !room.abandoned ? ' 🏆' : ''}</td><td><b>${p.totalScore}</b></td></tr>`;
  });
  const endText = room.abandoned
    ? '<p style="text-align:center">有玩家退出了房间，本局结束。</p>'
    : `<p style="text-align:center"><b>${winners.map((p) => escapeHtml(p.name)).join('、')}</b> 以 ${winner.totalScore} 分${winners.length > 1 ? '并列获胜' : '获胜'}！</p>`;
  showOverlay(`
    <h2>🎉 游戏结束</h2>
    ${endText}
    <table class="score-table">
      <tr><th>名次</th><th>玩家</th><th>总分</th></tr>
      ${rows}
    </table>
    ${renderResults(room)}
    ${canRematch ? renderReadiness(room) : ''}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="btn-back-lobby">返回大厅</button>
      ${canRematch ? `<button class="btn btn-gold" id="btn-rematch-ready">${room.players[S.me.yourIdx].ready ? '取消准备' : '准备'}</button><button class="btn btn-primary" id="btn-rematch">再来一局</button>` : ''}
    </div>`);
  if (canRematch) {
    $('btn-rematch-ready').disabled = !isOnline();
    $('btn-rematch-ready').addEventListener('click', toggleReady);
    const isHost = room.players[S.me.yourIdx].isHost;
    $('btn-rematch').classList.toggle('hidden', room.settings.hostOnly && !isHost);
    $('btn-rematch').disabled = !isOnline() || !room.players.every((p) => p.ready && p.connected);
    $('btn-rematch').addEventListener('click', () => socket.emit('rematch', {}, (ack) => { if (!ack.ok) toast(ack.message); }));
  }
  $('btn-back-lobby').addEventListener('click', () => leaveGame());
}

/* ---------------- 事件绑定 ---------------- */

$('name-input').value = S.name;

$('btn-create').addEventListener('click', () => {
  const name = $('name-input').value.trim() || '玩家';
  joinRoom(randomRoomCode(), name);
});
$('btn-join').addEventListener('click', () => {
  const code = $('code-input').value.trim().toUpperCase();
  const name = $('name-input').value.trim() || '玩家';
  if (!code) { toast('请输入房间码'); return; }
  joinRoom(code, name);
});
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
$('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-create').click(); });

$('btn-copy').addEventListener('click', () => copyText(S.room.code));
$('btn-invite').addEventListener('click', () => {
  const url = new URL(location.href);
  url.search = ''; url.hash = '';
  url.searchParams.set('room', S.room.code);
  copyText(url.toString(), '已复制邀请链接');
});
function toggleReady() {
  if (!isOnline()) return;
  socket.emit('ready', {}, (ack) => { if (!ack?.ok) toast(ack?.message || '准备失败'); });
}
$('btn-ready').addEventListener('click', toggleReady);
$('host-only').addEventListener('change', (event) => {
  socket.emit('settings', { hostOnly: event.target.checked }, (ack) => { if (!ack?.ok) toast(ack?.message || '设置失败'); });
});
$('quick-chat').addEventListener('click', (event) => {
  if (event.target.tagName !== 'BUTTON' || !isOnline()) return;
  $('chat-input').value = event.target.textContent;
  $('chat-form').requestSubmit();
});
let marksFrame = null;
$('hand').addEventListener('scroll', () => {
  if (marksFrame !== null) return;
  marksFrame = requestAnimationFrame(() => { marksFrame = null; renderInsertMarks(); });
});
$('btn-start').addEventListener('click', () => { enterFullscreen(); socket.emit('startGame', {}, (ack) => { if (ack && !ack.ok) toast(ack.message); }); });
$('btn-leave').addEventListener('click', () => leaveGame());
$('btn-leave-game').addEventListener('click', () => {
  if (confirm('确定退出房间？若对局进行中，本局将结束。')) leaveGame();
});
$('btn-fullscreen').addEventListener('click', toggleFullscreen);

function leaveGame() {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    localStorage.removeItem('scout-room');
    localStorage.removeItem('scout-playerId');
    S.joined = false;
    S.playerId = null;
    socket.disconnect();
    location.reload();
  };
  socket.emit('leaveGame', {}, finish);
  setTimeout(finish, 1500);
}

function openRules() {
  showOverlay(`<h2>📖 游戏规则</h2>${RULES_HTML}<div class="modal-actions"><button class="btn btn-primary" id="btn-close-rules">知道了</button></div>`);
  $('btn-close-rules').addEventListener('click', closeOverlay);
}
$('btn-rules').addEventListener('click', openRules);
$('btn-rules2').addEventListener('click', openRules);
$('overlay').addEventListener('click', (e) => { if (e.target === $('overlay')) closeOverlay(); });

/* ---------------- 音效 ---------------- */
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
document.addEventListener('pointerdown', () => { try { ensureAudio(); } catch (e) {} }, { once: true });

function tone(freq, start, dur, type, gain) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type || 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

function playSfx(type) {
  try {
    const ctx = ensureAudio();
    if (!ctx) return;
    const t = ctx.currentTime;
    if (type === 'show') {
      tone(440, t, 0.08, 'triangle', 0.22);
      tone(660, t + 0.06, 0.12, 'triangle', 0.2);
    } else if (type === 'scout') {
      tone(520, t, 0.09, 'square', 0.1);
      tone(330, t + 0.07, 0.12, 'square', 0.1);
    } else if (type === 'score') {
      tone(523.25, t, 0.1, 'sine', 0.22);
      tone(783.99, t + 0.09, 0.18, 'sine', 0.22);
    } else if (type === 'turn') {
      tone(659.25, t, 0.1, 'sine', 0.26);
      tone(880, t + 0.09, 0.16, 'sine', 0.22);
    }
  } catch (e) {}
}

function notifyMyTurn() {
  playSfx('turn');
  const el = $('turn-hint');
  el.classList.add('turn-flash');
  clearTimeout(el._flashTimer);
  el._flashTimer = setTimeout(() => el.classList.remove('turn-flash'), 1800);
}

/* ---------------- 手牌自适应（移动端全部显示、无需滚动） ---------------- */
function isMobileLayout() {
  return window.matchMedia('(max-width: 480px), (orientation: landscape) and (max-height: 520px)').matches;
}

function fitHand() {
  const hand = $('hand');
  const cards = hand.querySelectorAll('.card');
  const n = cards.length;
  if (!n) { hand.style.removeProperty('--cw'); return; }

  if (isMobileLayout()) { return; } // 移动端叠牌无需缩放

  const gap = parseFloat(getComputedStyle(hand).columnGap || getComputedStyle(hand).gap || '6px') || 6;
  const available = hand.clientWidth - gap * (n - 1) - 4;
  let cw = Math.floor(available / n);
  cw = Math.max(28, Math.min(74, cw));
  hand.style.setProperty('--cw', cw + 'px');
}
let fitTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => { if (S.room && S.room.phase !== 'lobby') { fitHand(); renderInsertMarks(); } }, 150);
});

/* ---------------- 全屏 ---------------- */
function enterFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {});
  }
}
function toggleFullscreen() {
  if (!document.fullscreenElement) enterFullscreen();
  else document.exitFullscreen && document.exitFullscreen().catch(() => {});
}

/* ---------------- Socket 事件 ---------------- */

socket.on('state', (data) => {
  S.sessionActive = true;
  setConnectionStatus('已连接');
  $('chat-send').disabled = false;
  $('chat-panel').classList.remove('hidden');
  requestAnimationFrame(clampChatPosition);

  const prevIdx = S.room ? S.room.currentIdx : -1;
  const prevPhase = S.room ? S.room.phase : null;
  if (prevPhase !== data.public.phase || data.public.currentIdx !== data.private.yourIdx) S.scout = null;
  S.room = data.public;
  S.me = data.private;

  // 音效：按事件序号播放（只给目标玩家播放）
  const ev = S.room.lastEvent;
  if (ev && ev.seq) {
    if (S.lastEventSeq == null) S.lastEventSeq = ev.seq;
    else if (ev.seq > S.lastEventSeq) {
      S.lastEventSeq = ev.seq;
      if (ev.targetIdx === S.me.yourIdx) playSfx(ev.type);
    }
  }

  // 轮到自己行动时提醒（提示音 + 高亮）
  if (S.room.phase === 'playing' && S.room.currentIdx === S.me.yourIdx
      && (prevIdx !== S.room.currentIdx || prevPhase !== 'playing')) {
    notifyMyTurn();
  }

  // 阶段切换时重置选中与挖角状态
  if (S.room.phase !== 'playing') { S.selected = []; if (S.scout && S.scout.step === 'pick') S.scout = null; }
  render();
});

socket.on('error', (data) => toast(data.message));

/* ---------------- 房间聊天 ---------------- */
let chatOpen = false;
let chatLastId = null;
let chatUnread = 0;
let chatInitialized = false;
let chatTab = 'chat';
function updateChatNotice() {
  $('chat-toggle').textContent = `💬 房间聊天${chatUnread ? ` (${chatUnread})` : ''}`;
  $('chat-toggle').classList.toggle('has-unread', chatUnread > 0);
  $('chat-tab').textContent = `聊天${chatUnread ? ` (${chatUnread})` : ''}`;
}
function renderChat(messages) {
  const list = $('chat-messages');
  const lastId = messages.length ? messages[messages.length - 1].id : null;
  const initialized = chatInitialized;
  chatInitialized = true;
  if (lastId === chatLastId) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  if (initialized && (!chatOpen || chatTab !== 'chat' || document.hidden)) {
    const previous = messages.findIndex((m) => m.id === chatLastId);
    chatUnread += previous < 0 ? messages.length : messages.length - previous - 1;
    if (chatUnread) toast('💬 房间有新聊天消息');
  }
  chatLastId = lastId;
  list.replaceChildren();
  for (const message of messages) {
    const row = document.createElement('div');
    row.className = 'chat-message';
    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    meta.textContent = `${message.name} · ${message.seat}号位 · ${new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const body = document.createElement('div');
    body.textContent = message.text;
    row.append(meta, body);
    list.appendChild(row);
  }
  if (nearBottom) list.scrollTop = list.scrollHeight;
  updateChatNotice();
}
function renderLogs(logs) {
  const list = $('game-logs');
  const lastId = logs.length ? logs[logs.length - 1].id : '';
  if (list.dataset.lastId === lastId) return;
  list.dataset.lastId = lastId;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.replaceChildren();
  for (const log of logs) {
    const row = document.createElement('div');
    row.className = 'chat-message';
    row.textContent = `${new Date(log.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}  ${log.text}`;
    list.appendChild(row);
  }
  if (nearBottom) list.scrollTop = list.scrollHeight;
}
function selectChatTab(tab) {
  chatTab = tab;
  $('chat-conversation').classList.toggle('hidden', tab !== 'chat');
  $('game-logs').classList.toggle('hidden', tab !== 'logs');
  for (const name of ['chat', 'logs']) {
    $(name + '-tab').setAttribute('aria-selected', String(name === tab));
    $(name + '-tab').tabIndex = name === tab ? 0 : -1;
  }
  if (tab === 'chat' && chatOpen && !document.hidden) chatUnread = 0;
  updateChatNotice();
  const list = $(tab === 'chat' ? 'chat-messages' : 'game-logs');
  list.scrollTop = list.scrollHeight;
  requestAnimationFrame(clampChatPosition);
}
$('chat-tab').addEventListener('click', () => selectChatTab('chat'));
$('logs-tab').addEventListener('click', () => selectChatTab('logs'));
for (const name of ['chat', 'logs']) {
  $(name + '-tab').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tab = event.key === 'Home' ? 'chat' : event.key === 'End' ? 'logs' : chatTab === 'chat' ? 'logs' : 'chat';
    selectChatTab(tab);
    $(tab + '-tab').focus();
  });
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && chatOpen && chatTab === 'chat') { chatUnread = 0; updateChatNotice(); }
});
let chatMessages = [];
let gameLogs = [];
socket.on('chatHistory', (messages) => { chatMessages = messages; renderChat(messages); });
socket.on('history', (history) => { chatMessages = history.chat; gameLogs = history.logs; renderChat(chatMessages); renderLogs(gameLogs); });
socket.on('gameLog', (entry) => { if (!gameLogs.some((x) => x.id === entry.id)) gameLogs.push(entry); gameLogs = gameLogs.slice(-200); renderLogs(gameLogs); });
$('chat-toggle').addEventListener('click', (event) => {
  if (suppressChatClick) { event.preventDefault(); return; }
  chatOpen = !chatOpen;
  $('chat-body').classList.toggle('hidden', !chatOpen);
  $('chat-toggle').setAttribute('aria-expanded', String(chatOpen));
  if (chatOpen) selectChatTab(chatTab);
  requestAnimationFrame(clampChatPosition);
});

// 长按 250ms 后拖动；保存相对位置，窗口变化时限制在可见范围内。
let chatDrag = null;
let suppressChatClick = false;
let chatPosition = null;
try { chatPosition = JSON.parse(localStorage.getItem('scout-chat-position')); } catch (_) {}
function clampChatPosition() {
  const panel = $('chat-panel');
  if (panel.classList.contains('hidden')) return;
  const rect = panel.getBoundingClientRect();
  const maxX = Math.max(8, window.innerWidth - rect.width - 8);
  const maxY = Math.max(8, window.innerHeight - rect.height - 8);
  const saved = chatPosition && Number.isFinite(chatPosition.x) && Number.isFinite(chatPosition.y);
  const x = Math.max(8, Math.min(maxX, saved ? chatPosition.x * window.innerWidth : rect.left));
  const y = Math.max(8, Math.min(maxY, saved ? chatPosition.y * window.innerHeight : rect.top));
  panel.style.left = x + 'px'; panel.style.top = y + 'px'; panel.style.right = 'auto';
}
const chatHandle = $('chat-toggle');
chatHandle.title = '点击展开/收起，长按拖动位置';
chatHandle.addEventListener('pointerdown', (event) => {
  if (!event.isPrimary || event.button !== 0) return;
  suppressChatClick = false;
  const rect = $('chat-panel').getBoundingClientRect();
  chatDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, active: false };
  chatHandle.setPointerCapture(event.pointerId);
  chatDrag.timer = setTimeout(() => {
    if (!chatDrag) return;
    chatDrag.active = true; suppressChatClick = true;
    chatHandle.classList.add('dragging');
  }, 250);
});
chatHandle.addEventListener('pointermove', (event) => {
  if (!chatDrag || event.pointerId !== chatDrag.id) return;
  const dx = event.clientX - chatDrag.x, dy = event.clientY - chatDrag.y;
  if (!chatDrag.active) {
    if (Math.hypot(dx, dy) > 8) { clearTimeout(chatDrag.timer); suppressChatClick = true; }
    return;
  }
  chatPosition = { x: (chatDrag.left + dx) / window.innerWidth, y: (chatDrag.top + dy) / window.innerHeight };
  clampChatPosition();
});
function endChatDrag() {
  if (!chatDrag) return;
  clearTimeout(chatDrag.timer);
  if (chatDrag.active) {
    const rect = $('chat-panel').getBoundingClientRect();
    chatPosition = { x: rect.left / window.innerWidth, y: rect.top / window.innerHeight };
    try { localStorage.setItem('scout-chat-position', JSON.stringify(chatPosition)); } catch (_) {}
  }
  chatDrag = null;
  chatHandle.classList.remove('dragging');
}
chatHandle.addEventListener('pointerup', endChatDrag);
chatHandle.addEventListener('pointercancel', endChatDrag);
chatHandle.addEventListener('lostpointercapture', endChatDrag);
chatHandle.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('resize', clampChatPosition);
$('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!isOnline()) return toast('连接尚未恢复，请稍后发送');
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  const button = $('chat-send');
  button.disabled = true;
  socket.timeout(5000).emit('chat', { text }, (err, ack) => {
    button.disabled = !isOnline();
    if (err) return toast('发送超时，请检查连接');
    if (!ack || !ack.ok) return toast(ack?.message || '发送失败');
    if (input.value.trim() === text) input.value = '';
  });
});

socket.on('connect', () => {
  setConnectionStatus(S.joined ? '正在恢复房间…' : '已连接');
  if (S.joined && S.room) {
    // 会话中断线后自动重连回原房间
    socket.emit('join', { room: S.room.code, name: S.name, playerId: S.playerId }, (ack) => {
      if (ack && ack.ok) { S.playerId = ack.playerId; localStorage.setItem('scout-playerId', S.playerId); }
    });
  } else if (!S.joined && S.playerId && S.name && (!inviteCode || inviteCode === localStorage.getItem('scout-room'))) {
    // 刷新页面后自动回到之前的房间
    const roomCode = localStorage.getItem('scout-room');
    if (roomCode) {
      socket.emit('join', { room: roomCode, name: S.name, playerId: S.playerId }, (ack) => {
        if (ack && ack.ok) {
          S.playerId = ack.playerId;
          localStorage.setItem('scout-playerId', S.playerId);
          S.joined = true;
          toast('已重新加入房间');
        } else {
          localStorage.removeItem('scout-room');
        }
      });
    }
  }
});

/* ---------------- 初始 ---------------- */

const inviteCode = new URL(location.href).searchParams.get('room')?.trim().toUpperCase();
if (inviteCode && /^[A-Z0-9]{4}$/.test(inviteCode)) {
  $('code-input').value = inviteCode;
  toast('已填入邀请房间码，输入昵称后点击加入');
}
function markDisconnected(message) {
  S.sessionActive = false;
  S.scoutPending = false;
  S.scout = null;
  S.selected = [];
  setConnectionStatus(message);
  $('chat-send').disabled = true;
  if (S.room) render();
}
socket.on('disconnect', () => markDisconnected('连接中断，正在重连…'));
socket.on('connect_error', () => markDisconnected('连接失败，正在重试…'));
socket.on('sessionReplaced', () => {
  socket.disconnect();
  markDisconnected('此座位已在另一标签页打开，请关闭本页');
});

$('name-input').value = S.name;
if (S.name) { /* 保持空白状态，等待用户操作 */ }
renderLobby();

/* ---------------- 保活心跳（防止免费云平台闲置休眠） ---------------- */
setInterval(() => {
  fetch('/healthz').catch(() => {});
}, 30000);
