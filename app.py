import eventlet
eventlet.monkey_patch()

import os, random, uuid, json, threading
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "minus-secret-change-me")
socketio = SocketIO(app, cors_allowed_origins="*", logger=False, engineio_logger=False)

# ── View counter ─────────────────────────────────────────────
_VIEW_FILE = '/tmp/minus_views.json'
_view_lock = threading.Lock()

def _load_views():
    try:
        with open(_VIEW_FILE) as f: return json.load(f).get('total', 0)
    except: return 0

def _save_views(n):
    try:
        with open(_VIEW_FILE, 'w') as f: json.dump({'total': n}, f)
    except: pass

_total_views = _load_views()

def increment_views():
    global _total_views
    with _view_lock:
        _total_views += 1
        _save_views(_total_views)
    return _total_views

# ── Game state ────────────────────────────────────────────────
games        = {}
player_game  = {}
_turn_timers = {}   # gid -> eventlet greenlet

SUITS      = ["H","D","C","S"]
VALUES     = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"]
SCORE_MAP  = {"A":1,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,"J":0,"Q":12,"K":14}
MAX_ROUNDS = 10
HAND_SIZE  = 5
MAX_PLAYERS= 4
MIN_PLAYERS= 2
TURN_SECS  = 30   # seconds per turn before auto-play

def cscore(v):    return SCORE_MAP.get(v, 0)
def htotal(hand): return sum(c["score"] for c in hand)

def make_deck():
    d = [{"suit":s,"value":v,"score":cscore(v)} for s in SUITS for v in VALUES]
    random.shuffle(d); return d

def get_player(game, sid):
    return next((p for p in game["players"] if p["sid"] == sid), None)

def cur(game):
    return game["players"][game["turn_idx"] % len(game["players"])] if game["players"] else None

def reshuffle(game):
    if game["deck"]: return True
    if len(game["discard"]) <= 1: return False
    top = game["discard"].pop()
    game["deck"] = game["discard"][:]
    random.shuffle(game["deck"])
    game["discard"] = [top]
    return True

def state_for(game, sid):
    cp  = cur(game)
    rev = game["phase"] in ("round_end", "game_end")
    me  = get_player(game, sid)
    is_step2 = (game["phase"] == "playing" and game["turn_state"] in ("discarded","dup_draw"))
    cp_sid = cp["sid"] if cp else None
    visible_top = (game.get("pre_discard_top") if (is_step2 and sid == cp_sid)
                   else (game["discard"][-1] if game["discard"] else None))
    players_out = []
    for p in game["players"]:
        players_out.append({
            "sid":        p["sid"],
            "name":       p["name"],
            "score":      p["score"],
            "hand_count": len(p["hand"]),
            "is_current": bool(cp and p["sid"] == cp["sid"]),
            "hand":       p["hand"] if (p["sid"] == sid or rev) else None,
        })
    return {
        "game_id":             game["id"],
        "phase":               game["phase"],
        "round":               game["round"],
        "max_rounds":          MAX_ROUNDS,
        "turn_state":          game["turn_state"],
        "current_player_sid":  cp_sid,
        "current_player_name": cp["name"] if cp else None,
        "discard_top":         visible_top,
        "deck_count":          len(game["deck"]),
        "my_sid":              sid,
        "host_sid":            game["host"],
        "my_hand":             me["hand"] if me else [],
        "players":             players_out,
        "round_result":        game.get("round_result"),
        "last_round_result":   game.get("last_round_result"),   # FIX 4
        "turn_deadline":       game.get("turn_deadline"),       # for countdown
    }

def broadcast(game):
    for p in game["players"]:
        socketio.emit("game_state", state_for(game, p["sid"]), to=p["sid"])

def push_rooms():
    waiting = [
        {"game_id": g["id"], "host_name": g["players"][0]["name"] if g["players"] else "?",
         "count": len(g["players"]), "max": MAX_PLAYERS}
        for g in games.values() if g["phase"] == "waiting"
    ]
    socketio.emit("rooms_list", waiting)

# ── Turn timer (FIX 1) ────────────────────────────────────────
def cancel_turn_timer(gid):
    gt = _turn_timers.pop(gid, None)
    if gt:
        try: gt.kill()
        except: pass

def start_turn_timer(gid, expected_idx):
    cancel_turn_timer(gid)
    import time
    deadline = time.time() + TURN_SECS
    if gid in games:
        games[gid]["turn_deadline"] = deadline

    def _fire():
        eventlet.sleep(TURN_SECS)
        if gid not in games: return
        g = games[gid]
        if g["phase"] != "playing": return
        if g["turn_idx"] != expected_idx: return
        cp = cur(g)
        if not cp: return
        p = get_player(g, cp["sid"])
        name = cp["name"]
        # auto-play: if waiting, discard highest card then draw; if discarded/dup_draw just draw
        if g["turn_state"] == "waiting" and p and p["hand"]:
            g["pre_discard_top"] = g["discard"][-1] if g["discard"] else None
            highest = max(range(len(p["hand"])), key=lambda i: p["hand"][i]["score"])
            card = p["hand"].pop(highest)
            g["discard"].append(card)
        if reshuffle(g) and p:
            p["hand"].append(g["deck"].pop())
        advance_turn(g)
        socketio.emit("turn_timeout", {"player_name": name}, to=gid)
        broadcast(g)
    _turn_timers[gid] = eventlet.spawn(_fire)

def advance_turn(game):
    game["turn_idx"]        = (game["turn_idx"] + 1) % len(game["players"])
    game["turn_state"]      = "waiting"
    game["pre_discard_top"] = None
    game["turn_deadline"]   = None
    # start timer for new turn
    import time
    game["turn_deadline"] = time.time() + TURN_SECS
    start_turn_timer(game["id"], game["turn_idx"])

def start_round(game):
    deck = make_deck()
    for p in game["players"]:
        p["hand"] = [deck.pop() for _ in range(HAND_SIZE)]
    game["deck"]             = deck
    game["discard"]          = [deck.pop()]
    game["turn_state"]       = "waiting"
    game["phase"]            = "playing"
    game["round_result"]     = None
    game["pre_discard_top"]  = None
    # FIX 3: round winner starts first
    starter_sid = game.get("next_starter_sid")
    sids = [p["sid"] for p in game["players"]]
    game["turn_idx"] = sids.index(starter_sid) if starter_sid and starter_sid in sids else 0
    game["next_starter_sid"] = None
    import time
    game["turn_deadline"] = time.time() + TURN_SECS
    start_turn_timer(game["id"], game["turn_idx"])

# ── Routes ────────────────────────────────────────────────────
@app.route("/")
def index():
    count = increment_views()
    return render_template("index.html", total_views=count)

@app.route("/game")
def game_page(): return render_template("game.html")

# ── Socket lifecycle ──────────────────────────────────────────
@socketio.on("connect")
def on_connect():
    emit("connected", {"sid": request.sid})
    waiting = [
        {"game_id": g["id"], "host_name": g["players"][0]["name"] if g["players"] else "?",
         "count": len(g["players"]), "max": MAX_PLAYERS}
        for g in games.values() if g["phase"] == "waiting"
    ]
    emit("rooms_list", waiting)

@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    gid = player_game.pop(sid, None)
    if not gid or gid not in games: return
    g = games[gid]
    p = get_player(g, sid)
    if not p: return
    if g["phase"] == "waiting":
        g["players"] = [x for x in g["players"] if x["sid"] != sid]
        if not g["players"]: del games[gid]; push_rooms(); return
        if g["host"] == sid: g["host"] = g["players"][0]["sid"]
        broadcast(g); push_rooms()
    else:
        socketio.emit("player_left", {"name": p["name"]}, to=gid)

# ── Lobby ─────────────────────────────────────────────────────
@socketio.on("create_game")
def on_create_game(data):
    name = (data.get("name") or "Player").strip()[:20] or "Player"
    gid  = str(uuid.uuid4())[:6].upper()
    import time
    game = {
        "id": gid, "host": request.sid, "phase": "waiting",
        "players": [{"sid": request.sid, "name": name, "hand": [], "score": 0}],
        "deck": [], "discard": [], "round": 1,
        "turn_idx": 0, "turn_state": "waiting",
        "round_result": None, "last_round_result": None,
        "pre_discard_top": None, "next_starter_sid": None, "turn_deadline": None,
    }
    games[gid] = game
    player_game[request.sid] = gid
    join_room(gid)
    emit("game_created", {"game_id": gid})
    broadcast(game); push_rooms()

@socketio.on("join_game")
def on_join_game(data):
    gid  = (data.get("game_id") or "").strip().upper()
    name = (data.get("name") or "Player").strip()[:20] or "Player"
    if gid not in games:               return emit("error", {"msg": "Game not found."})
    g = games[gid]
    if g["phase"] != "waiting":        return emit("error", {"msg": "Game already started."})
    if len(g["players"]) >= MAX_PLAYERS: return emit("error", {"msg": f"Room full (max {MAX_PLAYERS})."})
    if any(p["name"] == name for p in g["players"]): return emit("error", {"msg": "Name taken — choose another."})
    if request.sid in player_game:     return emit("error", {"msg": "You are already in a game."})
    g["players"].append({"sid": request.sid, "name": name, "hand": [], "score": 0})
    player_game[request.sid] = gid
    join_room(gid)
    broadcast(g); push_rooms()

@socketio.on("start_game")
def on_start_game():
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return emit("error", {"msg": "Not in a game."})
    g = games[gid]
    if g["host"] != sid:                return emit("error", {"msg": "Only host can start."})
    if len(g["players"]) < MIN_PLAYERS: return emit("error", {"msg": f"Need at least {MIN_PLAYERS} players."})
    if g["phase"] != "waiting":         return emit("error", {"msg": "Already started."})
    for p in g["players"]: p["score"] = 0
    g["round"] = 1
    start_round(g); broadcast(g); push_rooms()

# FIX 2: Host kick player ─────────────────────────────────────
@socketio.on("kick_player")
def on_kick_player(data):
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    if g["host"] != sid: return emit("error", {"msg": "Only host can kick players."})
    target_sid = data.get("target_sid")
    if not target_sid or target_sid == sid: return emit("error", {"msg": "Cannot kick yourself."})
    target = get_player(g, target_sid)
    if not target: return emit("error", {"msg": "Player not found."})
    name = target["name"]
    # Remove from game
    g["players"] = [p for p in g["players"] if p["sid"] != target_sid]
    player_game.pop(target_sid, None)
    leave_room(gid, sid=target_sid)
    # Notify kicked player
    socketio.emit("kicked", {"msg": "You were removed from the game by the host."}, to=target_sid)
    # Notify room
    socketio.emit("player_kicked", {"name": name}, to=gid)
    if g["phase"] == "waiting":
        broadcast(g); push_rooms()
    else:
        # Fix turn_idx if needed
        if len(g["players"]) < MIN_PLAYERS:
            cancel_turn_timer(gid)
            g["phase"] = "waiting"
            g["round"]  = 1
            for p in g["players"]: p["score"] = 0; p["hand"] = []
            broadcast(g); push_rooms()
        else:
            if g["turn_idx"] >= len(g["players"]):
                g["turn_idx"] = 0
            broadcast(g)

# FIX 2: Rejoin ───────────────────────────────────────────────
@socketio.on("rejoin")
def on_rejoin(data):
    sid  = request.sid
    gid  = (data.get("game_id") or "").strip().upper()
    name = (data.get("name") or "").strip()
    if not gid or not name or gid not in games: return emit("no_game", {})
    g = games[gid]
    existing = next((p for p in g["players"] if p["name"] == name), None)
    if not existing: return emit("no_game", {})
    old_sid = existing["sid"]
    player_game.pop(old_sid, None)
    existing["sid"] = sid
    player_game[sid] = gid
    if g["host"] == old_sid: g["host"] = sid
    join_room(gid)
    emit("game_state", state_for(g, sid))

# ── Gameplay ──────────────────────────────────────────────────
def validate(game, sid, allowed):
    if game["phase"] != "playing":        return None, "Round not active."
    cp = cur(game)
    if not cp or cp["sid"] != sid:        return None, "Not your turn."
    if game["turn_state"] not in allowed: return None, "Action not allowed now."
    return get_player(game, sid), None

@socketio.on("discard_card")
def on_discard_card(data):
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    p, err = validate(g, sid, ["waiting"])
    if err: return emit("error", {"msg": err})
    idx = data.get("card_index")
    if not isinstance(idx, int) or not (0 <= idx < len(p["hand"])):
        return emit("error", {"msg": "Invalid card."})
    cancel_turn_timer(gid)
    g["pre_discard_top"] = g["discard"][-1] if g["discard"] else None
    card = p["hand"].pop(idx)
    g["discard"].append(card)
    g["turn_state"] = "discarded"
    g["turn_deadline"] = None
    broadcast(g)

@socketio.on("draw_from_deck")
def on_draw_from_deck():
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    p, err = validate(g, sid, ["discarded","dup_draw"])
    if err: return emit("error", {"msg": err})
    if not reshuffle(g): return emit("error", {"msg": "No cards left!"})
    p["hand"].append(g["deck"].pop())
    advance_turn(g); broadcast(g)

@socketio.on("take_discard")
def on_take_discard():
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    p, err = validate(g, sid, ["discarded","dup_draw"])
    if err: return emit("error", {"msg": err})
    pre = g.get("pre_discard_top")
    if pre and len(g["discard"]) >= 2:
        g["discard"].remove(pre)
        p["hand"].append(pre)
    elif g["discard"]:
        p["hand"].append(g["discard"].pop())
    else:
        return emit("error", {"msg": "Discard pile empty."})
    advance_turn(g); broadcast(g)

@socketio.on("discard_duplicates")
def on_discard_duplicates(data):
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    p, err = validate(g, sid, ["waiting"])
    if err: return emit("error", {"msg": err})
    val = data.get("value")
    m   = [c for c in p["hand"] if c["value"] == val]
    if len(m) < 2: return emit("error", {"msg": "Need 2+ cards of same value."})
    cancel_turn_timer(gid)
    g["pre_discard_top"] = g["discard"][-1] if g["discard"] else None
    p["hand"] = [c for c in p["hand"] if c["value"] != val]
    g["discard"].extend(m)
    g["turn_state"] = "dup_draw"
    g["turn_deadline"] = None
    broadcast(g)

@socketio.on("show")
def on_show():
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    _, err = validate(g, sid, ["waiting"])
    if err: return emit("error", {"msg": err})
    cancel_turn_timer(gid)
    end_round(g, sid)

def end_round(game, show_sid=None):
    cancel_turn_timer(game["id"])
    game["phase"]    = "round_end"
    game["turn_deadline"] = None
    totals    = {p["sid"]: htotal(p["hand"]) for p in game["players"]}
    min_val   = min(totals.values())
    penalty   = bool(show_sid and totals[show_sid] > min_val)
    round_pts = {}
    for p in game["players"]:
        base = totals[p["sid"]]
        pts  = (base + 25) if (penalty and p["sid"] == show_sid) else base
        round_pts[p["sid"]] = pts
        p["score"] += pts
    # FIX 3: find round winner (lowest hand, no penalty)
    winner_sid = min(totals, key=lambda s: totals[s])
    game["next_starter_sid"] = winner_sid
    round_result = {
        "show_caller_sid":  show_sid,
        "show_caller_name": get_player(game, show_sid)["name"] if show_sid else None,
        "penalty":    penalty,
        "totals":    {p["name"]: totals[p["sid"]]    for p in game["players"]},
        "round_pts": {p["name"]: round_pts[p["sid"]] for p in game["players"]},
        "cumulative":{p["name"]: p["score"]           for p in game["players"]},
        "min_val":   min_val,
        "round_winner_sid":  winner_sid,
        "round_winner_name": get_player(game, winner_sid)["name"],
    }
    game["round_result"]      = round_result
    game["last_round_result"] = round_result   # FIX 4: persist
    if game["round"] >= MAX_ROUNDS:
        game["phase"] = "game_end"
    broadcast(game)

@socketio.on("next_round")
def on_next_round():
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    if g["phase"] != "round_end": return emit("error", {"msg": "Not round-end phase."})
    if g["host"] != sid:          return emit("error", {"msg": "Only host advances round."})
    g["round"] += 1
    start_round(g); broadcast(g)

@socketio.on("request_state")
def on_request_state():
    sid = request.sid; gid = player_game.get(sid)
    if gid and gid in games: emit("game_state", state_for(games[gid], sid))
    else:                    emit("no_game", {})

if __name__ == "__main__":
    socketio.run(app, debug=True, host="0.0.0.0", port=5000)
