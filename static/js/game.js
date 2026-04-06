const socket = io();
const SYM   = {H:'♥', D:'♦', C:'♣', S:'♠'};
const isRed = s => s==='H'||s==='D';

let S       = null;
let selIdx  = -1;
let confRAF = null;
let timerRAF= null;

// ── Speech (FIX 1 & 5) ───────────────────────────────────────
function speak(text, rate=0.92, pitch=1.0) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate; u.pitch = pitch; u.volume = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch(e) {}
}

function announceRoundWinner(name, isMe) {
  const nm = isMe ? 'You' : name;
  speak(`${nm} won the round! Boom!`, 0.85, 1.1);
  showAnnouncement(`🏅 ${isMe ? 'You' : name} won the round!`, 'round-win');
}

function announceGameWinner(name, isMe) {
  const nm = isMe ? 'You' : name;
  speak(`And the ultimate winner of the game isssss... ${nm}... BOOOOOOMMMM!`, 0.8, 1.15);
  showAnnouncement(`🏆 ULTIMATE WINNER: ${isMe ? 'You' : name}! BOOOOOMM! 🎉`, 'game-win');
}

function announceTurn(name, isMe) {
  speak(isMe ? "It's your turn!" : `It's ${name}'s turn`, 1.0, 1.0);
}

// ── Connect / reconnect ───────────────────────────────────────
socket.on('connect', () => {
  const gid  = sessionStorage.getItem('minus_game_id');
  const name = sessionStorage.getItem('minus_name');
  if (gid && name) socket.emit('rejoin', { game_id: gid, name });
  else window.location.href = '/';
});

socket.on('no_game',    () => window.location.href = '/');
socket.on('kicked',     d  => { alert(d.msg); sessionStorage.clear(); window.location.href = '/'; });
socket.on('error',      d  => toast(d.msg, 'err'));
socket.on('player_left',d  => { toast(`${d.name} disconnected.`, 'warn'); addLog(`${d.name} left the game`, '⚠️'); });
socket.on('player_kicked', d => { toast(`${d.name} was removed.`, 'warn'); addLog(`${d.name} was kicked`, '🚫'); });
socket.on('turn_timeout',  d => { toast(`⏱️ ${d.player_name}'s turn timed out — auto-played!`, 'warn'); addLog(`${d.player_name} timed out`, '⏱️'); });

let _lastTurnSid = null;
let _lastPhase   = null;
let _lastRound   = null;

socket.on('game_state', s => {
  const prevSid   = _lastTurnSid;
  const prevPhase = _lastPhase;
  const prevRound = _lastRound;
  S = s; selIdx = -1;

  // FIX 1: announce turn change
  if (s.phase === 'playing' && s.current_player_sid !== prevSid) {
    _lastTurnSid = s.current_player_sid;
    announceTurn(s.current_player_name, s.current_player_sid === s.my_sid);
    addLog(`${s.current_player_name}'s turn`, '▶');
  }

  // FIX 5: announce round winner when round ends
  if (s.phase === 'round_end' && prevPhase === 'playing') {
    const rr = s.round_result;
    if (rr && rr.round_winner_name) {
      const isMe = rr.round_winner_sid === s.my_sid;
      if (s.round < s.max_rounds) announceRoundWinner(rr.round_winner_name, isMe);
    }
  }

  // FIX 5: announce game winner
  if (s.phase === 'game_end' && prevPhase !== 'game_end') {
    const sorted = [...s.players].sort((a,b)=>a.score-b.score);
    const winner = sorted[0];
    announceGameWinner(winner.name, winner.sid === s.my_sid);
  }

  _lastPhase = s.phase;
  _lastRound = s.round;
  render();
});

// ── Buttons ───────────────────────────────────────────────────
document.getElementById('btn-show').onclick = () => {
  if (!S||!isMyTurn()||S.turn_state!=='waiting') return;
  document.getElementById('show-modal').classList.remove('hidden');
};
document.getElementById('btn-disc').onclick = () => {
  if (selIdx<0) { toast('Select a card in your hand first!','warn'); return; }
  socket.emit('discard_card',{card_index:selIdx}); selIdx=-1;
};
document.getElementById('btn-draw').onclick = () => socket.emit('draw_from_deck');
document.getElementById('btn-take').onclick = () => socket.emit('take_discard');
document.getElementById('btn-copy').onclick = () => {
  if (!S) return;
  navigator.clipboard.writeText(S.game_id)
    .then(()=>toast('Code copied!','info'))
    .catch(()=>toast(S.game_id,'info'));
};

function closeShow()   { document.getElementById('show-modal').classList.add('hidden'); }
function confirmShow() { closeShow(); if(!S||!isMyTurn()||S.turn_state!=='waiting') return; socket.emit('show'); }
function dupDiscard(v) { socket.emit('discard_duplicates',{value:v}); }
function nextRound()   { socket.emit('next_round'); }
function kickPlayer(targetSid) { if(confirm('Remove this player?')) socket.emit('kick_player',{target_sid:targetSid}); }

function selCard(i) {
  if (!isMyTurn()||S.turn_state!=='waiting') return;
  selIdx = selIdx===i?-1:i;
  renderMyHand(); renderButtons();
}

// ── Master render ─────────────────────────────────────────────
function render() {
  if (!S) return;
  renderHUD(); renderSidebar(); renderOpponents(); renderPiles();
  renderMyHand(); renderButtons(); renderDupPanel(); renderHint();
  renderTimer();
  if      (S.phase==='round_end') showRoundOv();
  else if (S.phase==='game_end')  showGameEnd();
  else { hide('ov-round'); hide('ov-game'); }
}

function renderHUD() {
  document.getElementById('round-lbl').textContent = `Round ${S.round}/${S.max_rounds}`;
  document.getElementById('code-chip').textContent = S.game_id;
  const banner=document.getElementById('turn-banner');
  const pill  =document.getElementById('phase-pill');
  if (S.phase!=='playing') {
    banner.textContent='Round Over'; banner.className='tb-idle';
    pill.textContent=''; pill.className='pp-idle'; return;
  }
  if (isMyTurn()) {
    banner.textContent='⭐ Your Turn!'; banner.className='tb-mine';
    if (S.turn_state==='waiting') { pill.textContent='① Discard or ⚡ SHOW'; pill.className='pp-step1'; }
    else                          { pill.textContent='② Draw or Take'; pill.className='pp-step2'; }
  } else {
    banner.innerHTML=`${S.current_player_name} <span class="dot"></span><span class="dot"></span><span class="dot"></span>`;
    banner.className='tb-other'; pill.textContent='Waiting…'; pill.className='pp-idle';
  }
}

// FIX 1: turn countdown timer ─────────────────────────────────
function renderTimer() {
  const el = document.getElementById('turn-timer');
  if (!el) return;
  if (cancelAnimationFrame) cancelAnimationFrame(timerRAF);
  if (S.phase !== 'playing' || S.turn_state !== 'waiting' || !S.turn_deadline) {
    el.textContent = '';
    el.className = 'turn-timer hidden';
    return;
  }
  function tick() {
    const secs = Math.max(0, Math.ceil(S.turn_deadline - Date.now()/1000));
    el.textContent = `⏱ ${secs}s`;
    el.className = `turn-timer ${secs <= 10 ? 'urgent' : ''}`;
    if (secs > 0) timerRAF = requestAnimationFrame(tick);
    else { el.textContent = '⏱ 0s'; el.className = 'turn-timer urgent'; }
  }
  tick();
}

function renderSidebar() {
  const sorted=[...S.players].sort((a,b)=>a.score-b.score);
  const isHost = S.my_sid === S.host_sid;

  // Scores
  document.getElementById('sb-rows').innerHTML = sorted.map((p,r)=>{
    const kickBtn = isHost && p.sid !== S.my_sid
      ? `<button class="sb-kick" onclick="kickPlayer('${p.sid}')" title="Remove player">✕</button>`
      : '';
    return `<div class="sb-row ${p.sid===S.my_sid?'me':''} ${r===0?'lead':''}">
      <span class="sb-rank">${r+1}</span>
      <span class="sb-name">${p.sid===S.my_sid?'You':p.name}</span>
      <span class="sb-pts">${p.score}</span>
      ${kickBtn}
    </div>`;
  }).join('');

  // FIX 4: last round scores
  const lr = S.last_round_result;
  const lrEl = document.getElementById('last-round-wrap');
  if (lr && S.phase === 'playing' && lrEl) {
    lrEl.classList.remove('hidden');
    document.getElementById('lr-rows').innerHTML = S.players.map(p=>`
      <div class="lr-row ${p.sid===S.my_sid?'me':''}">
        <span class="lr-name">${p.sid===S.my_sid?'You':p.name}</span>
        <span class="lr-pts">+${lr.round_pts[p.name]??0}</span>
      </div>`).join('');
  } else if (lrEl) {
    lrEl.classList.add('hidden');
  }
}

function renderOpponents() {
  const others=S.players.filter(p=>p.sid!==S.my_sid);
  const rev=S.phase==='round_end'||S.phase==='game_end';
  document.getElementById('opponents').innerHTML=others.map(p=>{
    const active=p.is_current&&S.phase==='playing';
    let cards;
    if (rev&&p.hand) {
      const t=p.hand.reduce((s,c)=>s+c.score,0);
      cards=p.hand.map(c=>cHTML(c,true)).join('')
           +`<div style="font-size:.67rem;color:var(--gold);margin-top:3px;font-family:'DM Mono',monospace">${t} pts</div>`;
    } else {
      cards=Array(p.hand_count).fill(`<div class="card card-back card-sm"><div class="cbp"></div></div>`).join('');
    }
    return `<div class="opp ${active?'active':''}">
      <div class="opp-name ${active?'active':''}">${active?'▶ ':''}${p.name}</div>
      <div class="opp-cards">${cards}</div>
      <div class="opp-score">Score: ${p.score}</div>
    </div>`;
  }).join('');
}

function renderPiles() {
  document.getElementById('deck-el').innerHTML=S.deck_count>0
    ?`<div class="card card-back"><div class="cbp"></div></div>`
    :`<div class="card-empty">Empty</div>`;
  document.getElementById('deck-cnt').textContent=`${S.deck_count} card${S.deck_count!==1?'s':''}`;
  const canTake=isMyTurn()&&S.phase==='playing'
              &&(S.turn_state==='discarded'||S.turn_state==='dup_draw')&&!!S.discard_top;
  document.getElementById('discard-el').innerHTML=S.discard_top
    ?cHTML(S.discard_top,false,canTake)
    :`<div class="card-empty">Empty</div>`;
}

function renderMyHand() {
  const hand=S.my_hand||[];
  const total=hand.reduce((s,c)=>s+c.score,0);
  document.getElementById('htotal').textContent=`${total} pts`;
  const canSel=isMyTurn()&&S.phase==='playing'&&S.turn_state==='waiting';
  document.getElementById('my-hand').innerHTML=hand.map((c,i)=>`
    <div class="card card-face ${isRed(c.suit)?'red':'blk'} ${canSel?'sel-able':''} ${i===selIdx?'selected':''} deal"
         style="animation-delay:${i*.04}s" onclick="${canSel?`selCard(${i})`:''}">
      <div class="cc tl">${c.value}<br/>${SYM[c.suit]}</div>
      <div class="card-mid">${SYM[c.suit]}</div>
      <div class="cc br">${c.value}<br/>${SYM[c.suit]}</div>
    </div>`).join('');
}

function renderButtons() {
  const my=isMyTurn()&&S.phase==='playing';
  const ts=S.turn_state;
  setDis('btn-show',!(my&&ts==='waiting'));
  setDis('btn-disc',!(my&&ts==='waiting'&&selIdx>=0));
  setDis('btn-draw',!(my&&(ts==='discarded'||ts==='dup_draw')));
  setDis('btn-take',!(my&&(ts==='discarded'||ts==='dup_draw')&&!!S.discard_top));
  document.getElementById('btn-disc').classList.toggle('active-step',my&&ts==='waiting');
  document.getElementById('btn-draw').classList.toggle('active-step',my&&(ts==='discarded'||ts==='dup_draw'));
}

function renderDupPanel() {
  const panel=document.getElementById('dup-panel');
  const show=isMyTurn()&&S.phase==='playing'&&S.turn_state==='waiting';
  if (!show){panel.classList.add('hidden');return;}
  const counts={};
  (S.my_hand||[]).forEach(c=>{counts[c.value]=(counts[c.value]||0)+1;});
  const dups=Object.entries(counts).filter(([,n])=>n>=2);
  if (!dups.length){panel.classList.add('hidden');return;}
  panel.classList.remove('hidden');
  document.getElementById('dup-btns').innerHTML=dups.map(([v,n])=>
    `<button class="btn btn-dup" onclick="dupDiscard('${v}')">${v}×${n} Discard All</button>`).join('');
}

function renderHint() {
  const el=document.getElementById('hint');
  if (!isMyTurn()||S.phase!=='playing'){el.textContent='';el.className='';return;}
  const msgs={
    waiting:'① Click a card to select it, then "Discard Selected" — or call ⚡ SHOW.',
    discarded:'② Draw from deck, or click the glowing card to take the previous discard.',
    dup_draw:'② You discarded duplicates! Now draw one card.',
  };
  el.textContent=msgs[S.turn_state]||''; el.className='';
}

// ── Activity log (side screen) ────────────────────────────────
const _log = [];
function addLog(msg, icon='ℹ') {
  _log.unshift({msg, icon, t: new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})});
  if (_log.length > 30) _log.pop();
  const el = document.getElementById('activity-log');
  if (!el) return;
  el.innerHTML = _log.map(e=>`
    <div class="log-row">
      <span class="log-icon">${e.icon}</span>
      <span class="log-msg">${e.msg}</span>
      <span class="log-time">${e.t}</span>
    </div>`).join('');
}

// ── Big announcement banner ───────────────────────────────────
let _annTimer = null;
function showAnnouncement(msg, type='round-win') {
  const el = document.getElementById('announcement');
  if (!el) return;
  el.textContent = msg;
  el.className = `announcement ${type}`;
  el.classList.remove('hidden');
  clearTimeout(_annTimer);
  _annTimer = setTimeout(()=>el.classList.add('hidden'), type==='game-win'?8000:4000);
}

// ── Round overlay ─────────────────────────────────────────────
function showRoundOv() {
  const r=S.round_result; if(!r) return;
  show('ov-round'); hide('ov-game');
  const isEnd  = S.round>=S.max_rounds;
  const isHost = S.my_sid===S.host_sid;
  const winner = r.round_winner_name;
  const isWinnerMe = r.round_winner_sid === S.my_sid;

  let html=`<div class="ov-title">Round ${S.round} Complete</div>`;

  // FIX 5: Round winner announcement in overlay
  if (winner) {
    html += `<div class="banner b-winner">🏅 <b>${isWinnerMe?'You':winner}</b> won Round ${S.round}! ${isEnd?'':'They go first next round.'}</div>`;
  }

  if (r.show_caller_name) {
    const isMe=r.show_caller_sid===S.my_sid, nm=isMe?'You':r.show_caller_name;
    html+=r.penalty
      ?`<div class="banner b-fail">⚠️ <b>${nm}</b> called SHOW but didn't have the lowest hand! +25 penalty.</div>`
      :`<div class="banner b-ok">✅ <b>${nm}</b> called SHOW and had the lowest hand!</div>`;
  }
  html+=`<table class="rtbl"><thead>
    <tr><th>Player</th><th>Hand</th><th>Total</th><th>Round +</th><th>Cumulative</th></tr>
  </thead><tbody>`;
  S.players.forEach(p=>{
    const nm=p.name, isMe=p.sid===S.my_sid, isPen=r.penalty&&r.show_caller_sid===p.sid;
    const isRoundWin=p.sid===r.round_winner_sid;
    const hs=(p.hand||[]).map(c=>`${c.value}${SYM[c.suit]}`).join(' ');
    html+=`<tr class="${isMe?'me-row':''} ${isPen?'pen-row':''} ${isRoundWin?'win-row':''}">
      <td>${isMe?'You':nm}${isRoundWin?' 🏅':''}</td><td class="hstr">${hs}</td>
      <td>${r.totals[nm]??0}</td>
      <td>${r.round_pts[nm]??0}${isPen?' (+25⚠️)':''}</td>
      <td><b>${r.cumulative[nm]??0}</b></td></tr>`;
  });
  html+=`</tbody></table>`;
  if (isEnd)
    html+=`<button class="btn-cta" onclick="showGameEnd()">See Final Results →</button>`;
  else if (isHost)
    html+=`<button class="btn-cta" onclick="nextRound()">▶ Next Round (${S.round+1}/${S.max_rounds})</button>`;
  else
    html+=`<p style="text-align:center;color:rgba(255,255,255,.5);font-size:.85rem;margin-top:8px">⏳ Waiting for host to start next round…</p>`;
  document.getElementById('ov-rbox').innerHTML=html;
}

// ── Game end overlay ──────────────────────────────────────────
function showGameEnd() {
  hide('ov-round'); show('ov-game');
  const sorted=[...S.players].sort((a,b)=>a.score-b.score);
  const medals=['🥇','🥈','🥉'], winner=sorted[0];
  let html=`<div class="ov-title">🏆 Game Over!</div>
    <div class="game-win-banner">
      And the ultimate winner of the game isssss…<br/>
      <span class="ultimate-winner">${winner.sid===S.my_sid?'🎉 YOU! 🎉':winner.name}</span>
      <br/>BOOOOOOMMM! 🎆
    </div>
    <table class="rtbl"><thead><tr><th>Rank</th><th>Player</th><th>Total Score</th></tr></thead><tbody>`;
  sorted.forEach((p,i)=>{
    html+=`<tr class="${i===0?'win-row':''} ${p.sid===S.my_sid?'me-row':''}">
      <td>${medals[i]||`${i+1}.`}</td><td>${p.sid===S.my_sid?'You':p.name}</td><td>${p.score}</td></tr>`;
  });
  html+=`</tbody></table><button class="btn-cta" onclick="window.location.href='/'">← Play Again</button>`;
  document.getElementById('ov-gbox').innerHTML=html;
  startConfetti();
}

// ── Helpers ───────────────────────────────────────────────────
function isMyTurn(){return S&&S.current_player_sid===S.my_sid;}
function setDis(id,dis){const e=document.getElementById(id);if(e)e.disabled=dis;}
function show(id){document.getElementById(id)?.classList.remove('hidden');}
function hide(id){document.getElementById(id)?.classList.add('hidden');}
function toast(msg,type='info'){
  const el=document.getElementById('toast');
  el.textContent=msg; el.className=`toast toast-${type}`;
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.add('hidden'),3500);
}
function cHTML(c,small=false,glow=false){
  const col=isRed(c.suit)?'red':'blk', sm=small?' card-sm':'', gl=glow?' take-glow':'';
  const fn=glow?`onclick="document.getElementById('btn-take').click()"` :'';
  return `<div class="card card-face ${col}${sm}${gl}" ${fn}>
    <div class="cc tl">${c.value}<br/>${SYM[c.suit]}</div>
    <div class="card-mid">${SYM[c.suit]}</div>
    <div class="cc br">${c.value}<br/>${SYM[c.suit]}</div>
  </div>`;
}
function startConfetti(){
  const cv=document.getElementById('confetti-canvas');
  const W=cv.width=innerWidth, H=cv.height=innerHeight, ctx=cv.getContext('2d');
  const C=['#c9a84c','#e8c96a','#2ecc71','#3498db','#e74c3c','#9b59b6','#f39c12'];
  const ps=Array.from({length:200},()=>({
    x:Math.random()*W, y:Math.random()*H-H, w:Math.random()*13+5, h:Math.random()*6+3,
    vx:(Math.random()-.5)*3, vy:Math.random()*4+2, r:Math.random()*Math.PI*2, vr:(Math.random()-.5)*.17,
    c:C[Math.floor(Math.random()*C.length)],
  }));
  function draw(){
    ctx.clearRect(0,0,W,H);
    ps.forEach(p=>{
      p.x+=p.vx;p.y+=p.vy;p.r+=p.vr;p.vy+=.06;
      if(p.y>H){p.y=-20;p.x=Math.random()*W;p.vy=Math.random()*3+1;}
      ctx.save();ctx.translate(p.x,p.y);ctx.rotate(p.r);
      ctx.fillStyle=p.c;ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h);ctx.restore();
    });
    confRAF=requestAnimationFrame(draw);
  }
  draw(); setTimeout(()=>{if(confRAF){cancelAnimationFrame(confRAF);confRAF=null;}ctx.clearRect(0,0,W,H);},10000);
}
