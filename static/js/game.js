/**
 * Minus Strategy Card Game — Multiplayer Client
 *
 * TURN ORDER enforced visually:
 *   waiting     → SHOW available, select & discard a card (Step 1)
 *   discarded   → SHOW disabled, must draw or take (Step 2)
 *   dup_draw    → after duplicate-discard, must draw one card (Step 2)
 */

const socket = io();
const SYM    = {H:'♥', D:'♦', C:'♣', S:'♠'};
const isRed  = s => s==='H' || s==='D';

let S        = null;   // latest game state
let selIdx   = -1;     // selected card index in my hand
let confRAF  = null;

// ─── SOCKET EVENTS ───────────────────────────────────────────
socket.on('connect',    () => socket.emit('request_state'));
socket.on('no_game',    () => window.location.href = '/');
socket.on('game_state', s  => { S = s; selIdx = -1; render(); });
socket.on('error',      d  => toast(d.msg, 'err'));
socket.on('player_left',d  => toast(`${d.name} disconnected.`, 'warn'));

// ─── BUTTON CLICK HANDLERS ───────────────────────────────────
document.getElementById('btn-show').onclick  = () => {
  if (!S || !isMyTurn() || S.turn_state !== 'waiting') return;
  document.getElementById('show-modal').classList.remove('hidden');
};

document.getElementById('btn-disc').onclick  = () => {
  if (selIdx < 0) { toast('Select a card in your hand first!', 'warn'); return; }
  socket.emit('discard_card', { card_index: selIdx });
  selIdx = -1;
};

document.getElementById('btn-draw').onclick  = () => socket.emit('draw_from_deck');
document.getElementById('btn-take').onclick  = () => socket.emit('take_discard');

document.getElementById('btn-copy').onclick  = () => {
  if (!S) return;
  navigator.clipboard.writeText(S.game_id)
    .then(() => toast('Game code copied!', 'info'))
    .catch(() => toast(S.game_id, 'info'));
};

// ─── SHOW MODAL ───────────────────────────────────────────────
function closeShow()   { document.getElementById('show-modal').classList.add('hidden'); }
function confirmShow() {
  closeShow();
  if (!S || !isMyTurn() || S.turn_state !== 'waiting') return;
  socket.emit('show');
}

// ─── DUPLICATE DISCARD ────────────────────────────────────────
function dupDiscard(val) { socket.emit('discard_duplicates', { value: val }); }

// ─── NEXT ROUND (host only) ───────────────────────────────────
function nextRound() { socket.emit('next_round'); }

// ─── CARD SELECTION ──────────────────────────────────────────
function selCard(i) {
  if (!isMyTurn() || S.turn_state !== 'waiting') return;
  selIdx = (selIdx === i) ? -1 : i;
  renderMyHand();
  renderButtons();
}

// ─── MASTER RENDER ───────────────────────────────────────────
function render() {
  if (!S) return;
  renderHUD();
  renderSidebar();
  renderOpponents();
  renderPiles();
  renderMyHand();
  renderButtons();
  renderDupPanel();
  renderHint();
  // Handle overlays
  if (S.phase === 'round_end') showRoundOv();
  else if (S.phase === 'game_end') showGameEnd();
  else { hide('ov-round'); hide('ov-game'); }
}

// ─── HUD ──────────────────────────────────────────────────────
function renderHUD() {
  document.getElementById('round-lbl').textContent  = `Round ${S.round}/${S.max_rounds}`;
  document.getElementById('code-chip').textContent  = S.game_id;
  const banner = document.getElementById('turn-banner');
  const pill   = document.getElementById('phase-pill');

  if (S.phase !== 'playing') {
    banner.textContent = 'Round Over';
    banner.className   = 'tb-idle';
    pill.textContent   = '';
    pill.className     = 'pp-idle';
    return;
  }

  if (isMyTurn()) {
    banner.textContent = '⭐ Your Turn!';
    banner.className   = 'tb-mine';
    const ts = S.turn_state;
    if (ts === 'waiting') {
      pill.textContent = '① Discard or ⚡ SHOW';
      pill.className   = 'pp-step1';
    } else {
      pill.textContent = '② Draw or Take';
      pill.className   = 'pp-step2';
    }
  } else {
    banner.innerHTML = `${S.current_player_name} <span class="dot"></span><span class="dot"></span><span class="dot"></span>`;
    banner.className = 'tb-other';
    pill.textContent = 'Waiting…';
    pill.className   = 'pp-idle';
  }
}

// ─── SIDEBAR SCOREBOARD ──────────────────────────────────────
function renderSidebar() {
  const sorted = [...S.players].sort((a, b) => a.score - b.score);
  document.getElementById('sb-rows').innerHTML = sorted.map((p, r) => `
    <div class="sb-row ${p.sid === S.my_sid ? 'me' : ''} ${r === 0 ? 'lead' : ''}">
      <span class="sb-rank">${r + 1}</span>
      <span class="sb-name">${p.sid === S.my_sid ? 'You' : p.name}</span>
      <span class="sb-pts">${p.score}</span>
    </div>`).join('');
}

// ─── OPPONENTS ────────────────────────────────────────────────
function renderOpponents() {
  const others = S.players.filter(p => p.sid !== S.my_sid);
  const rev    = S.phase === 'round_end' || S.phase === 'game_end';
  document.getElementById('opponents').innerHTML = others.map(p => {
    const active = p.is_current && S.phase === 'playing';
    let cards;
    if (rev && p.hand) {
      const t = p.hand.reduce((s, c) => s + c.score, 0);
      cards = p.hand.map(c => cHTML(c, true)).join('')
            + `<div style="font-size:.67rem;color:var(--gold);margin-top:3px;font-family:'DM Mono',monospace">${t} pts</div>`;
    } else {
      cards = Array(p.hand_count).fill(
        `<div class="card card-back card-sm"><div class="cbp"></div></div>`
      ).join('');
    }
    return `
      <div class="opp ${active ? 'active' : ''}">
        <div class="opp-name ${active ? 'active' : ''}">${active ? '▶ ' : ''}${p.name}</div>
        <div class="opp-cards">${cards}</div>
        <div class="opp-score">Score: ${p.score}</div>
      </div>`;
  }).join('');
}

// ─── PILES ────────────────────────────────────────────────────
function renderPiles() {
  const deckEl = document.getElementById('deck-el');
  deckEl.innerHTML = S.deck_count > 0
    ? `<div class="card card-back"><div class="cbp"></div></div>`
    : `<div class="card-empty">Empty</div>`;
  document.getElementById('deck-cnt').textContent = `${S.deck_count} card${S.deck_count !== 1 ? 's' : ''}`;

  const canTake = isMyTurn() && S.phase === 'playing'
                && (S.turn_state === 'discarded' || S.turn_state === 'dup_draw')
                && S.discard_top;
  const discEl = document.getElementById('discard-el');
  discEl.innerHTML = S.discard_top
    ? cHTML(S.discard_top, false, canTake)
    : `<div class="card-empty">Empty</div>`;
}

// ─── MY HAND ──────────────────────────────────────────────────
function renderMyHand() {
  const hand   = S.my_hand || [];
  const total  = hand.reduce((s, c) => s + c.score, 0);
  document.getElementById('htotal').textContent = `${total} pts`;
  const canSel = isMyTurn() && S.phase === 'playing' && S.turn_state === 'waiting';
  document.getElementById('my-hand').innerHTML = hand.map((c, i) => `
    <div class="card card-face ${isRed(c.suit) ? 'red' : 'blk'} ${canSel ? 'sel-able' : ''} ${i === selIdx ? 'selected' : ''} deal"
         style="animation-delay:${i * .04}s"
         onclick="${canSel ? `selCard(${i})` : ''}">
      <div class="cc tl">${c.value}<br/>${SYM[c.suit]}</div>
      <div class="card-mid">${SYM[c.suit]}</div>
      <div class="cc br">${c.value}<br/>${SYM[c.suit]}</div>
    </div>`).join('');
}

// ─── BUTTONS ─────────────────────────────────────────────────
function renderButtons() {
  const my = isMyTurn() && S.phase === 'playing';
  const ts = S.turn_state;

  // ⚡ SHOW — ONLY at turn start before any discard
  setDis('btn-show', !(my && ts === 'waiting'));

  // ① Discard — step 1, card must be selected
  setDis('btn-disc', !(my && ts === 'waiting' && selIdx >= 0));

  // ② Draw — only after discarding
  setDis('btn-draw', !(my && (ts === 'discarded' || ts === 'dup_draw')));

  // ② Take — only after discarding, pile not empty
  setDis('btn-take', !(my && (ts === 'discarded' || ts === 'dup_draw') && !!S.discard_top));

  // Active-step glow on the current step button
  document.getElementById('btn-disc').classList.toggle('active-step', my && ts === 'waiting');
  document.getElementById('btn-draw').classList.toggle('active-step', my && (ts === 'discarded' || ts === 'dup_draw'));
}

// ─── DUPLICATE DISCARD PANEL ──────────────────────────────────
function renderDupPanel() {
  const panel = document.getElementById('dup-panel');
  const show  = isMyTurn() && S.phase === 'playing' && S.turn_state === 'waiting';
  if (!show) { panel.classList.add('hidden'); return; }
  const counts = {};
  (S.my_hand || []).forEach(c => { counts[c.value] = (counts[c.value] || 0) + 1; });
  const dups = Object.entries(counts).filter(([, n]) => n >= 2);
  if (!dups.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  document.getElementById('dup-btns').innerHTML = dups.map(([v, n]) =>
    `<button class="btn btn-dup" onclick="dupDiscard('${v}')">${v}×${n} Discard All</button>`
  ).join('');
}

// ─── HINT TEXT ────────────────────────────────────────────────
function renderHint() {
  const el = document.getElementById('hint');
  if (!isMyTurn() || S.phase !== 'playing') { el.textContent = ''; el.className = ''; return; }
  const msgs = {
    waiting:    '① Click a card to select it, then click "Discard Selected" — or call ⚡ SHOW to end the round.',
    discarded:  '② Now draw a card from the deck, or click the glowing discard pile card to take it.',
    dup_draw:   '② You discarded duplicates! Now draw one card from the deck or take the top discard.',
  };
  el.textContent = msgs[S.turn_state] || '';
  el.className   = '';
}

// ─── ROUND END OVERLAY ───────────────────────────────────────
function showRoundOv() {
  const r = S.round_result;
  if (!r) return;
  show('ov-round');
  hide('ov-game');
  const isEnd = S.round >= S.max_rounds;
  const isHost = S.my_sid === S.host_sid;
  let html = `<div class="ov-title">Round ${S.round} Complete</div>`;

  if (r.show_caller_name) {
    const isMe = r.show_caller_sid === S.my_sid;
    const nm   = isMe ? 'You' : r.show_caller_name;
    html += r.penalty
      ? `<div class="banner b-fail">⚠️ <b>${nm}</b> called SHOW but didn't have the lowest hand! +25 penalty applied.</div>`
      : `<div class="banner b-ok">✅ <b>${nm}</b> called SHOW and had the lowest hand!</div>`;
  }

  html += `<table class="rtbl"><thead>
    <tr><th>Player</th><th>Hand</th><th>Hand Total</th><th>Round +</th><th>Cumulative</th></tr>
  </thead><tbody>`;
  S.players.forEach(p => {
    const nm    = p.name;
    const isMe  = p.sid === S.my_sid;
    const isPen = r.penalty && r.show_caller_sid === p.sid;
    const hand  = p.hand || [];
    const hs    = hand.map(c => `${c.value}${SYM[c.suit]}`).join(' ');
    const ht    = r.totals[nm]    ?? 0;
    const rp    = r.round_pts[nm] ?? 0;
    const cu    = r.cumulative[nm]?? 0;
    html += `<tr class="${isMe ? 'me-row' : ''} ${isPen ? 'pen-row' : ''}">
      <td>${isMe ? 'You' : nm}</td>
      <td class="hstr">${hs}</td>
      <td>${ht}</td>
      <td>${rp}${isPen ? ' (+25⚠️)' : ''}</td>
      <td><b>${cu}</b></td>
    </tr>`;
  });
  html += `</tbody></table>`;

  if (isEnd) {
    html += `<button class="btn-cta" onclick="showGameEnd()">See Final Results →</button>`;
  } else if (isHost) {
    html += `<button class="btn-cta" onclick="nextRound()">Next Round (${S.round + 1}/${S.max_rounds}) →</button>`;
  } else {
    html += `<p style="text-align:center;color:rgba(255,255,255,.5);font-size:.85rem">⏳ Waiting for host to start next round…</p>`;
  }
  document.getElementById('ov-rbox').innerHTML = html;
}

// ─── GAME END OVERLAY ────────────────────────────────────────
function showGameEnd() {
  hide('ov-round');
  show('ov-game');
  const sorted = [...S.players].sort((a, b) => a.score - b.score);
  const winner = sorted[0];
  const medals = ['🥇','🥈','🥉'];
  let html = `
    <div class="ov-title">🏆 Game Over!</div>
    <p class="win-line">
      ${winner.sid === S.my_sid ? '🎉 <span class="wname">You win!</span>' : `<span class="wname">${winner.name}</span> wins!`}
      &nbsp;—&nbsp; ${winner.score} pts
    </p>
    <table class="rtbl"><thead>
      <tr><th>Rank</th><th>Player</th><th>Total Score</th></tr>
    </thead><tbody>`;
  sorted.forEach((p, i) => {
    html += `<tr class="${i === 0 ? 'win-row' : ''} ${p.sid === S.my_sid ? 'me-row' : ''}">
      <td>${medals[i] || `${i+1}.`}</td>
      <td>${p.sid === S.my_sid ? 'You' : p.name}</td>
      <td>${p.score}</td>
    </tr>`;
  });
  html += `</tbody></table>
    <button class="btn-cta" onclick="window.location.href='/'">← Back to Lobby</button>`;
  document.getElementById('ov-gbox').innerHTML = html;
  startConfetti();
}

// ─── HELPERS ─────────────────────────────────────────────────
function isMyTurn() { return S && S.current_player_sid === S.my_sid; }
function setDis(id, dis) { const e = document.getElementById(id); if (e) e.disabled = dis; }
function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = `toast toast-${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

function cHTML(c, small = false, glow = false) {
  const col = isRed(c.suit) ? 'red' : 'blk';
  const sm  = small ? ' card-sm' : '';
  const gl  = glow  ? ' take-glow' : '';
  const fn  = glow  ? `onclick="document.getElementById('btn-take').click()"` : '';
  return `<div class="card card-face ${col}${sm}${gl}" ${fn}>
    <div class="cc tl">${c.value}<br/>${SYM[c.suit]}</div>
    <div class="card-mid">${SYM[c.suit]}</div>
    <div class="cc br">${c.value}<br/>${SYM[c.suit]}</div>
  </div>`;
}

// ─── CONFETTI ────────────────────────────────────────────────
function startConfetti() {
  const cv = document.getElementById('confetti-canvas');
  const W  = cv.width  = innerWidth;
  const H  = cv.height = innerHeight;
  const ctx = cv.getContext('2d');
  const C  = ['#c9a84c','#e8c96a','#2ecc71','#3498db','#e74c3c','#9b59b6','#f39c12'];
  const ps = Array.from({length: 200}, () => ({
    x: Math.random()*W, y: Math.random()*H - H,
    w: Math.random()*13+5, h: Math.random()*6+3,
    vx: (Math.random()-.5)*3, vy: Math.random()*4+2,
    r: Math.random()*Math.PI*2, vr: (Math.random()-.5)*.17,
    c: C[Math.floor(Math.random()*C.length)],
  }));
  function draw() {
    ctx.clearRect(0,0,W,H);
    ps.forEach(p => {
      p.x+=p.vx; p.y+=p.vy; p.r+=p.vr; p.vy+=.06;
      if (p.y>H){p.y=-20;p.x=Math.random()*W;p.vy=Math.random()*3+1;}
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.r);
      ctx.fillStyle=p.c; ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h);
      ctx.restore();
    });
    confRAF = requestAnimationFrame(draw);
  }
  draw();
  setTimeout(() => {
    if (confRAF) { cancelAnimationFrame(confRAF); confRAF=null; }
    ctx.clearRect(0,0,W,H);
  }, 8000);
}
