"""
Minus Strategy Card Game — Flask + SocketIO Backend
All game rules enforced server-side. Never trust the client.

CORRECT TURN ORDER:
  1. Player selects a card and DISCARDS it       (waiting → discarded)
  2. Player DRAWS from deck OR TAKES top discard (discarded → next turn)

  EXCEPTION — Duplicate Discard:
  1. Player discards ALL cards of same value      (waiting → dup_draw)
  2. Player draws exactly ONE card               (dup_draw → next turn)

  SHOW — only callable at state='waiting' (before any action). Ends round.
"""

import os, random, uuid
from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "minus-secret-change-me")
socketio = SocketIO(app, cors_allowed_origins="*", logger=False, engineio_logger=False)

# ─── In-memory store ──────────────────────────────────────────
games = {}          # game_id → game dict
player_game = {}    # socket sid → game_id

# ─── Constants ────────────────────────────────────────────────
SUITS       = ["H","D","C","S"]
VALUES      = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"]
SCORE_MAP   = {"A":1,"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,"J":0,"Q":12,"K":14}
MAX_ROUNDS  = 10
HAND_SIZE   = 5
MAX_PLAYERS = 4
MIN_PLAYERS = 2

def cscore(v):      return SCORE_MAP.get(v, 0)
def htotal(hand):   return sum(c["score"] for c in hand)

def make_deck():
    d = [{"suit":s,"value":v,"score":cscore(v)} for s in SUITS for v in VALUES]
    random.shuffle(d)
    return d

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
    rev = game["phase"] in ("round_end","game_end")
    me  = get_player(game, sid)
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
        "current_player_sid":  cp["sid"]  if cp else None,
        "current_player_name": cp["name"] if cp else None,
        "discard_top":         game["discard"][-1] if game["discard"] else None,
        "deck_count":          len(game["deck"]),
        "my_sid":              sid,
        "host_sid":            game["host"],
        "my_hand":             me["hand"] if me else [],
        "players":             players_out,
        "round_result":        game.get("round_result"),
    }

def broadcast(game):
    for p in game["players"]:
        socketio.emit("game_state", state_for(game, p["sid"]), to=p["sid"])

def advance_turn(game):
    game["turn_idx"]   = (game["turn_idx"] + 1) % len(game["players"])
    game["turn_state"] = "waiting"

def start_round(game):
    deck = make_deck()
    for p in game["players"]:
        p["hand"] = [deck.pop() for _ in range(HAND_SIZE)]
    game["deck"]         = deck
    game["discard"]      = [deck.pop()]
    game["turn_idx"]     = 0
    game["turn_state"]   = "waiting"
    game["phase"]        = "playing"
    game["round_result"] = None

# ─── Routes ───────────────────────────────────────────────────
@app.route("/")
def index():     return render_template("index.html")
@app.route("/game")
def game_page(): return render_template("game.html")

# ─── Socket: lifecycle ────────────────────────────────────────
@socketio.on("connect")
def on_connect():
    emit("connected", {"sid": request.sid})

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
        if not g["players"]: del games[gid]; return
        if g["host"] == sid: g["host"] = g["players"][0]["sid"]
        broadcast(g)
    else:
        socketio.emit("player_left", {"name": p["name"]}, to=gid)

# ─── Socket: lobby ────────────────────────────────────────────
@socketio.on("create_game")
def on_create_game(data):
    name = (data.get("name") or "Player").strip()[:20] or "Player"
    gid  = str(uuid.uuid4())[:6].upper()
    game = {
        "id":gid, "host":request.sid, "phase":"waiting",
        "players":[{"sid":request.sid,"name":name,"hand":[],"score":0}],
        "deck":[], "discard":[], "round":1,
        "turn_idx":0, "turn_state":"waiting", "round_result":None,
    }
    games[gid] = game
    player_game[request.sid] = gid
    join_room(gid)
    emit("game_created", {"game_id": gid})
    broadcast(game)

@socketio.on("join_game")
def on_join_game(data):
    gid  = (data.get("game_id") or "").strip().upper()
    name = (data.get("name") or "Player").strip()[:20] or "Player"
    if gid not in games:          return emit("error", {"msg":"Game not found. Check the code!"})
    g = games[gid]
    if g["phase"] != "waiting":   return emit("error", {"msg":"Game already started."})
    if len(g["players"]) >= MAX_PLAYERS: return emit("error", {"msg":f"Room full (max {MAX_PLAYERS})."})
    if request.sid in player_game: return emit("error", {"msg":"You are already in a game."})
    g["players"].append({"sid":request.sid,"name":name,"hand":[],"score":0})
    player_game[request.sid] = gid
    join_room(gid)
    broadcast(g)

@socketio.on("start_game")
def on_start_game():
    sid = request.sid
    gid = player_game.get(sid)
    if not gid: return emit("error", {"msg":"Not in a game."})
    g = games[gid]
    if g["host"] != sid:               return emit("error", {"msg":"Only host can start."})
    if len(g["players"]) < MIN_PLAYERS:return emit("error", {"msg":f"Need at least {MIN_PLAYERS} players."})
    if g["phase"] != "waiting":        return emit("error", {"msg":"Already started."})
    for p in g["players"]: p["score"] = 0
    g["round"] = 1
    start_round(g)
    broadcast(g)

# ─── Socket: gameplay ─────────────────────────────────────────
def validate(game, sid, allowed):
    if game["phase"] != "playing":  return None, "Round not active."
    cp = cur(game)
    if not cp or cp["sid"] != sid:  return None, "Not your turn."
    if game["turn_state"] not in allowed: return None, f"Action not allowed now."
    return get_player(game, sid), None

@socketio.on("discard_card")
def on_discard_card(data):
    """STEP 1 — discard one card, then player must draw."""
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    p, err = validate(g, sid, ["waiting"])
    if err: return emit("error", {"msg": err})
    idx = data.get("card_index")
    if not isinstance(idx, int) or not (0 <= idx < len(p["hand"])):
        return emit("error", {"msg":"Invalid card."})
    card = p["hand"].pop(idx)
    g["discard"].append(card)
    g["turn_state"] = "discarded"
    broadcast(g)

@socketio.on("draw_from_deck")
def on_draw_from_deck():
    """STEP 2a — draw from hidden deck."""
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    p, err = validate(g, sid, ["discarded","dup_draw"])
    if err: return emit("error", {"msg": err})
    if not reshuffle(g): return emit("error", {"msg":"No cards left!"})
    p["hand"].append(g["deck"].pop())
    advance_turn(g)
    broadcast(g)

@socketio.on("take_discard")
def on_take_discard():
    """STEP 2b — take top of discard pile."""
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    p, err = validate(g, sid, ["discarded","dup_draw"])
    if err: return emit("error", {"msg": err})
    if not g["discard"]: return emit("error", {"msg":"Discard pile is empty."})
    p["hand"].append(g["discard"].pop())
    advance_turn(g)
    broadcast(g)

@socketio.on("discard_duplicates")
def on_discard_duplicates(data):
    """Dup discard — discard all matching-value cards, then draw one."""
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    p, err = validate(g, sid, ["waiting"])
    if err: return emit("error", {"msg": err})
    val = data.get("value")
    m = [c for c in p["hand"] if c["value"] == val]
    if len(m) < 2: return emit("error", {"msg":"Need 2+ cards of same value."})
    p["hand"] = [c for c in p["hand"] if c["value"] != val]
    g["discard"].extend(m)
    g["turn_state"] = "dup_draw"
    broadcast(g)

@socketio.on("show")
def on_show():
    """SHOW — only at turn start. Ends round immediately."""
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    _, err = validate(g, sid, ["waiting"])
    if err: return emit("error", {"msg": err})
    end_round(g, sid)

def end_round(game, show_sid=None):
    game["phase"] = "round_end"
    totals  = {p["sid"]: htotal(p["hand"]) for p in game["players"]}
    min_val = min(totals.values())
    penalty = show_sid and totals[show_sid] > min_val
    round_pts = {}
    for p in game["players"]:
        base = totals[p["sid"]]
        pts  = (base + 25) if (penalty and p["sid"] == show_sid) else base
        round_pts[p["sid"]] = pts
        p["score"] += pts
    game["round_result"] = {
        "show_caller_sid":  show_sid,
        "show_caller_name": get_player(game, show_sid)["name"] if show_sid else None,
        "penalty":   penalty,
        "totals":    {p["name"]: totals[p["sid"]]     for p in game["players"]},
        "round_pts": {p["name"]: round_pts[p["sid"]]  for p in game["players"]},
        "cumulative":{p["name"]: p["score"]            for p in game["players"]},
        "min_val":   min_val,
    }
    if game["round"] >= MAX_ROUNDS: game["phase"] = "game_end"
    broadcast(game)

@socketio.on("next_round")
def on_next_round():
    sid = request.sid; gid = player_game.get(sid)
    if not gid: return
    g = games[gid]
    if g["phase"] != "round_end":   return emit("error",{"msg":"Not round-end phase."})
    if g["host"] != sid:            return emit("error",{"msg":"Only host advances round."})
    g["round"] += 1
    start_round(g)
    broadcast(g)

@socketio.on("request_state")
def on_request_state():
    sid = request.sid; gid = player_game.get(sid)
    if gid and gid in games: emit("game_state", state_for(games[gid], sid))
    else:                    emit("no_game", {})

if __name__ == "__main__":
    socketio.run(app, debug=True, host="0.0.0.0", port=5000)


@socketio.on("rejoin")
def on_rejoin(data):
    """Called when a player refreshes or navigates to /game page."""
    sid  = request.sid
    gid  = (data.get("game_id") or "").strip().upper()
    name = (data.get("name") or "").strip()

    if gid not in games:
        return emit("no_game", {})

    g = games[gid]

    # Check if this player is already in the game (same name)
    existing = next((p for p in g["players"] if p["name"] == name), None)

    if existing:
        # Update their socket id to the new one
        old_sid = existing["sid"]
        player_game.pop(old_sid, None)
        existing["sid"] = sid
        player_game[sid] = gid
        join_room(gid)
        emit("game_state", state_for(g, sid))
    else:
        emit("no_game", {})
