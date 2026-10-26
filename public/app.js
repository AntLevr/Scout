'use strict';

const socket = io();

const S = {
  room: null,
  me: null,
  joined: false,
  playerId: localStorage.getItem('scout-playerId') || null,
  name: localStorage.getItem('scout-name') || '',
  sel: null, // {a, b} 手牌选中区间（含端点）
  scout: null, // 侦察弹窗状态机
};

function $(id) { return document.getElementById(id); }

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
  S.scout = null;
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
  if (a.length > b.length) return true;
  if (a.length < b.length) return false;
  if (a.top > b.top) return true;
  if (a.top < b.top) return false;
  if (a.type === 'set' && b.type === 'run') return true;
  return false;
}

const TYPE_CN = { set: '同数', run: '顺子' };

// 每个数字一种颜色（用于牌的两半着色）
const NUMBER_COLORS = {
  1: '#dc2626', 2: '#ea580c', 3: '#ca8a04', 4: '#16a34a', 5: '#0d9488',
  6: '#2563eb', 7: '#7c3aed', 8: '#db2777', 9: '#9a5b2e', 10: '#64748b',
};

function cardEl(value, extra = {}) {
  const el = document.createElement('div');
  el.className = 'card' + (extra.small ? ' small' : '') + (extra.cls ? ' ' + extra.cls : '');
  if (extra.idx != null) el.dataset.idx = extra.idx;

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

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('已复制房间码'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制房间码'); } catch (e) { toast('复制失败，请手动记下'); }
    document.body.removeChild(ta);
  }
}

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
<li>必须压过当前表演：<strong>张数多者胜</strong>；张数相同比<strong>最大数字</strong>；再相同则<strong>同数 &gt; 顺子</strong>。</li>
<li>被你压过的表演牌全部归你，每张 +1 分。</li>
</ul>
<h3>🕵️ 侦察（Scout）</h3>
<ul>
<li>从当前表演的<strong>最左或最右</strong>拿 1 张牌，以<strong>任意朝向、任意位置</strong>插入手牌。</li>
<li>表演主人获得 1 个筹码（+1 分）。</li>
<li>「✨ 侦察+表演」：每轮一次，侦察后可以立即表演。</li>
</ul>
<h3>🏁 一轮结束</h3>
<ul>
<li>有人<strong>出完手牌</strong>，或某个表演<strong>一圈没被压过</strong>（回到其主人手里）时，本轮结束。</li>
<li>计分：每张得分牌 +1、每个筹码 +1、每张剩余手牌 −1（表演存活者手牌不扣）。</li>
</ul>
<h3>👥 2 人变体</h3>
<p>每人发 11 张牌、3 个筹码。侦察需<strong>消耗自己 1 个筹码</strong>，且侦察后<strong>再次行动</strong>；没有筹码时必须表演，无法压过则判负。</p>
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
      nm.textContent = p.name + (p.idx === S.me.yourIdx ? '（我）' : '');
      const host = document.createElement('span');
      if (p.isHost) { host.className = 'host-badge'; host.textContent = '房主'; }
      div.appendChild(dot); div.appendChild(nm); if (p.isHost) div.appendChild(host);
      list.appendChild(div);
    });
    const n = S.room.players.length;
    $('lobby-tip').textContent = n < 3 ? `等待玩家加入（当前 ${n} 人，至少 2 人可开局）…` : `当前 ${n} 人，可以开始！`;
    const isHost = S.room.players.find((p) => p.idx === S.me.yourIdx)?.isHost;
    $('btn-start').classList.toggle('hidden', !isHost);
    $('btn-start').disabled = n < 2;
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
    $('game').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    renderLobby();
    closeOverlay();
    return;
  }

  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');

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
      b.textContent = '✨ 侦察+表演';
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
  const ownerName = room.players[show.ownerIdx].name;
  owner.innerHTML = `<b>${ownerName}</b> 的表演 <span class="show-type-badge ${show.type}">${TYPE_CN[show.type]}</span> <span style="opacity:.8">${show.length} 张 · 最大 ${show.top}</span>`;
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
    hint.textContent = '点击最左或最右的一张牌进行侦察';
    wrap.appendChild(hint);
  }
  el.appendChild(wrap);
}

function renderMyArea(room, me) {
  $('my-captured').textContent = room.players[me.yourIdx].scorePileCount;
  $('my-chips').textContent = room.players[me.yourIdx].chips;
  $('my-total').textContent = room.players[me.yourIdx].totalScore;
  const ss = $('my-ss-token');
  ss.classList.toggle('tok', true);
  ss.classList.toggle('used', me.scoutShowUsed || room.players.length === 2);
  ss.textContent = room.players.length === 2 ? '🪙 侦察消耗1筹码' : (me.scoutShowUsed ? '✨ 侦察+表演（已用）' : '✨ 侦察+表演（可用）');

  if (room.phase === 'orient') {
    renderOrientHand(me);
    return;
  }

  renderHand(room, me);
  renderActions(room, me);
}

function renderOrientHand(me) {
  const hand = $('hand');
  hand.innerHTML = '';
  me.hand.forEach((c) => {
    const other = c.value === c.a ? c.b : c.a;
    hand.appendChild(cardEl(c.value, { sub: other }));
  });
  const actions = $('actions');
  const myConfirmed = S.room.players[me.yourIdx].confirmed;
  if (myConfirmed) {
    actions.innerHTML = '<div class="hint">✅ 已确认，等待其他玩家…</div>';
    $('action-hint').textContent = '等待其他玩家整理手牌…';
  } else {
    actions.innerHTML = `
      <button class="btn btn-gold" id="btn-flip">🔄 翻转整手</button>
      <button class="btn btn-primary" id="btn-confirm-hand">✅ 确认手牌</button>`;
    $('btn-flip').addEventListener('click', () => socket.emit('flipHand'));
    $('btn-confirm-hand').addEventListener('click', () => socket.emit('confirmHand'));
    $('action-hint').textContent = '可选择翻转整手牌（换到另一面数字），确定后点击确认。';
  }
}

function selectionRange() {
  if (!S.sel) return null;
  const a = Math.min(S.sel.a, S.sel.b);
  const b = Math.max(S.sel.a, S.sel.b);
  return { a, b, indices: range(a, b) };
}
function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

function renderHand(room, me) {
  const hand = $('hand');
  hand.innerHTML = '';
  const sel = selectionRange();

  me.hand.forEach((c, i) => {
    const other = c.value === c.a ? c.b : c.a;
    const inSel = sel && i >= sel.a && i <= sel.b;
    const card = cardEl(c.value, { sub: other, idx: i, cls: inSel ? 'selected' : '' });
    card.addEventListener('pointerdown', (e) => handPointerDown(e, i));
    hand.appendChild(card);
  });
}

let selecting = false, selStart = null, selEnd = null;

function handPointerDown(e, i) {
  if (S.scout && S.scout.step === 'pick') { S.scout = null; renderTable(S.room); }
  selecting = true;
  selStart = i;
  selEnd = i;
  updateSelection();
  e.preventDefault();
}
document.addEventListener('pointermove', (e) => {
  if (!selecting) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const card = el && el.closest ? el.closest('.card[data-idx]') : null;
  if (card && card.closest('#hand')) {
    selEnd = parseInt(card.dataset.idx, 10);
    updateSelection();
  }
});
document.addEventListener('pointerup', () => { if (selecting) { selecting = false; } });

function updateSelection() {
  if (selStart == null) { S.sel = null; }
  else S.sel = { a: selStart, b: selEnd };
  const room = S.room, me = S.me;
  if (room && me && room.phase === 'playing') {
    renderHand(room, me);
    renderSelectionHint(room, me);
    renderActions(room, me);
  }
}

function renderSelectionHint(room, me) {
  const sel = selectionRange();
  const hint = $('action-hint');
  if (!sel) { hint.textContent = '拖拽或点击手牌，选择要打出的相邻牌。'; return; }
  const cards = sel.indices.map((i) => me.hand[i]);
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
  const myTurn = room.phase === 'playing' && room.currentIdx === me.yourIdx;
  const sel = selectionRange();
  const canShow = myTurn && sel && classify(sel.indices.map((i) => me.hand[i]).map((c) => c.value)).valid;

  const showBtn = document.createElement('button');
  showBtn.className = 'btn btn-primary';
  showBtn.textContent = '🎪 表演';
  showBtn.disabled = !canShow;
  showBtn.addEventListener('click', () => doShow());
  actions.appendChild(showBtn);

  const scoutBtn = document.createElement('button');
  scoutBtn.className = 'btn btn-gold';
  if (S.scout && S.scout.step === 'pick') {
    scoutBtn.textContent = '✖ 取消侦察';
    scoutBtn.disabled = false;
    scoutBtn.addEventListener('click', () => {
      S.scout = null;
      renderTable(room);
      renderActions(room, me);
      $('action-hint').textContent = '选择要打出的牌，或点击「侦察」挖角。';
    });
  } else {
    scoutBtn.textContent = room.players.length === 2 ? '🕵️ 侦察（消耗筹码）' : '🕵️ 侦察';
    scoutBtn.disabled = !(myTurn && me.canScout);
    scoutBtn.addEventListener('click', () => openScoutModal());
  }
  actions.appendChild(scoutBtn);

  if (myTurn && room.mustShow) {
    $('action-hint').textContent = '必须表演：请选择手牌打出。';
  } else if (!myTurn) {
    $('action-hint').textContent = '等待其他玩家行动…';
  } else if (!S.sel) {
    $('action-hint').textContent = '选择要打出的牌，或点击「侦察」挖角。';
  }
}

function doShow() {
  const sel = selectionRange();
  if (!sel) return;
  socket.emit('show', { indices: sel.indices }, (ack) => {
    if (ack && !ack.ok) toast(ack.message);
  });
  selStart = selEnd = null;
  S.sel = null;
}

/* ---------------- 侦察弹窗 ---------------- */

function openScoutModal() {
  S.scout = { step: 'pick', edge: null, card: null, up: null, insertIndex: null, scoutShow: false };
  renderScoutModal();
}

function pickScoutEdge(edge) {
  socket.emit('scoutPreview', { edge }, (ack) => {
    if (!ack || !ack.ok) { toast('无法侦察'); return; }
    S.scout.edge = ack.edge;
    S.scout.card = ack.card;
    S.scout.up = (ack.card.value === ack.card.a) ? 'a' : 'b';
    S.scout.insertIndex = S.me.hand.length;
    S.scout.step = 'orient';
    renderScoutModal();
  });
}

function renderScoutModal() {
  const sc = S.scout;
  const me = S.me;
  if (!sc) return;

  if (sc.step === 'pick') {
    // 第一步无需遮罩：直接在桌面上高亮并等待点击两端卡牌
    $('overlay').classList.add('hidden');
    renderTable(S.room);
    $('action-hint').textContent = '🕵️ 点击当前表演最左或最右的一张牌；再点一次「侦察」可取消。';
    renderActions(S.room, me);
    return;
  }

  const a = sc.card.a, b = sc.card.b;
  let orientHTML = '';
  ['a', 'b'].forEach((k) => {
    const v = k === 'a' ? a : b;
    const other = k === 'a' ? b : a;
    const cls = sc.up === k ? 'selected' : '';
    const card = cardEl(v, { sub: other, cls });
    card.id = 'orient-' + k;
    card.style.cursor = 'pointer';
    orientHTML += card.outerHTML;
  });

  const insertHTML = insertRowHTML(sc.insertIndex, me.hand);

  const canSS = S.room.players.length !== 2 && !me.scoutShowUsed;

  showOverlay(`
    <h2>🕵️ 侦察</h2>
    <p style="text-align:center">这张牌有两面，选择插入手牌时的<strong>朝向</strong>：</p>
    <div class="orient-pick">${orientHTML}</div>
    <p style="text-align:center">选择<strong>插入位置</strong>（点击手牌间的空隙）：</p>
    <div class="insert-row" id="insert-row">${insertHTML}</div>
    ${canSS ? `<label style="display:flex;align-items:center;gap:8px;justify-content:center;margin:10px 0">
      <input type="checkbox" id="scout-show-chk" ${sc.scoutShow ? 'checked' : ''} />
      ✨ 侦察后立即表演（侦察+表演，本轮一次）
    </label>` : ''}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="scout-cancel">取消</button>
      <button class="btn btn-primary" id="scout-confirm">确认侦察</button>
    </div>`);

  $('orient-a').addEventListener('click', () => { sc.up = 'a'; renderScoutModal(); });
  $('orient-b').addEventListener('click', () => { sc.up = 'b'; renderScoutModal(); });
  if (canSS) $('scout-show-chk').addEventListener('change', (e) => { sc.scoutShow = e.target.checked; });
  $('scout-cancel').addEventListener('click', () => { S.scout = null; closeOverlay(); render(); });
  $('scout-confirm').addEventListener('click', () => {
    socket.emit('scout', { edge: sc.edge, up: sc.up, insertIndex: sc.insertIndex, scoutShow: sc.scoutShow }, (ack) => {
      if (ack && !ack.ok) { toast(ack.message); return; }
      S.scout = null;
      closeOverlay();
    });
  });
  $('insert-row').querySelectorAll('.hand-slot').forEach((slot) => {
    slot.addEventListener('click', () => {
      sc.insertIndex = parseInt(slot.dataset.slot, 10);
      renderScoutModal();
    });
  });
}

function insertRowHTML(insertIndex, hand) {
  let html = '';
  const slots = hand.length + 1;
  for (let i = 0; i < slots; i++) {
    const isSel = i === insertIndex;
    html += `<div class="hand-slot" data-slot="${i}" style="${isSel ? 'background:rgba(242,182,61,.4);' : ''}">${isSel ? '▼' : '+'}</div>`;
    if (i < hand.length) {
      const c = hand[i];
      const other = c.value === c.a ? c.b : c.a;
      html += cardEl(c.value, { sub: other, small: true }).outerHTML;
    }
  }
  return html;
}

/* ---------------- 结算弹窗 ---------------- */

function renderRoundEndModal(room) {
  const lr = room.lastRound;
  if (!lr) return;
  const winner = lr.detail[lr.winnerIdx];
  const endText =
    lr.kind === 'wentOut' ? `${winner.name} 出完了手牌！`
    : lr.kind === 'twoPlayerStuck' ? `${winner.name} 的表演无人能破！`
    : `${winner.name} 的表演坚持了一圈！`;
  let rows = '';
  lr.detail.forEach((d) => {
    const isWin = d.idx === lr.winnerIdx;
    rows += `<tr class="${isWin ? 'winner-row' : ''}">
      <td>${d.name}${isWin ? ' 🏆' : ''}</td>
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
    <div class="modal-actions"><button class="btn btn-primary" id="btn-next-round">进入下一轮 →</button></div>`);
  $('btn-next-round').addEventListener('click', () => socket.emit('nextRound'));
}

function renderGameEndModal(room) {
  const sorted = room.players.slice().sort((a, b) => b.totalScore - a.totalScore);
  const winner = sorted[0];
  const canRematch = room.players.length >= 2 && !room.abandoned;
  let rows = '';
  sorted.forEach((p, i) => {
    rows += `<tr class="${i === 0 && !room.abandoned ? 'winner-row' : ''}">
      <td>${i + 1}</td><td>${p.name}${i === 0 && !room.abandoned ? ' 🏆' : ''}</td><td><b>${p.totalScore}</b></td></tr>`;
  });
  const endText = room.abandoned
    ? '<p style="text-align:center">有玩家退出了房间，本局结束。</p>'
    : `<p style="text-align:center"><b>${winner.name}</b> 以 ${winner.totalScore} 分获胜，成为最佳马戏团长！</p>`;
  showOverlay(`
    <h2>🎉 游戏结束</h2>
    ${endText}
    <table class="score-table">
      <tr><th>名次</th><th>玩家</th><th>总分</th></tr>
      ${rows}
    </table>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="btn-back-lobby">返回大厅</button>
      ${canRematch ? '<button class="btn btn-primary" id="btn-rematch">再来一局</button>' : ''}
    </div>`);
  if (canRematch) $('btn-rematch').addEventListener('click', () => socket.emit('rematch'));
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
$('btn-start').addEventListener('click', () => socket.emit('startGame', {}, (ack) => { if (ack && !ack.ok) toast(ack.message); }));
$('btn-leave').addEventListener('click', () => leaveGame());
$('btn-leave-game').addEventListener('click', () => {
  if (confirm('确定退出房间？若对局进行中，本局将结束。')) leaveGame();
});

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

/* ---------------- Socket 事件 ---------------- */

socket.on('state', (data) => {
  S.room = data.public;
  S.me = data.private;
  // 阶段切换时重置选中与侦察状态
  if (S.room.phase !== 'playing') { S.sel = null; selStart = selEnd = null; if (S.scout && S.scout.step === 'pick') S.scout = null; }
  render();
});

socket.on('error', (data) => toast(data.message));

socket.on('connect', () => {
  if (S.joined && S.room) {
    // 会话中断线后自动重连回原房间
    socket.emit('join', { room: S.room.code, name: S.name, playerId: S.playerId }, (ack) => {
      if (ack && ack.ok) { S.playerId = ack.playerId; localStorage.setItem('scout-playerId', S.playerId); }
    });
  } else if (!S.joined && S.playerId && S.name) {
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

$('name-input').value = S.name;
if (S.name) { /* 保持空白状态，等待用户操作 */ }
renderLobby();

/* ---------------- 保活心跳（防止免费云平台闲置休眠） ---------------- */
setInterval(() => {
  fetch('/healthz').catch(() => {});
}, 30000);
