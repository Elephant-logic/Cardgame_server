/* server.js  (CommonJS) - Old Skool Blackjack / Switch style
   Authoritative server with lobby rooms.
   IMPORTANT: This server sends PER-CLIENT state so each player only sees their own hand.
*/
const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const app = express();

// Serve /public as your front-end
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

// -------------------- Utils --------------------
function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function randCode(n = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function findRoomByWs(ws) {
  for (const room of rooms.values()) {
    if (room.clients.has(ws)) return room;
  }
  return null;
}

function roomPlayers(room) {
  return room.players.map((p) => ({ id: p.id, name: p.name }));
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const ws of room.clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// -------------------- Game Logic --------------------
// Card ranks used by client: "A","2"... "10","J","Q","K"
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function makeDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ id: uid(), rank: r, suit: s });
    }
  }
  // shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function drawCard(room) {
  if (room.deck.length === 0) {
    // reshuffle discard except top card
    const top = room.state?.topCard;
    const keep = top ? [top] : [];
    const rest = room.discard.filter((c) => !top || c.id !== top.id);

    // shuffle rest into deck
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    room.deck = rest;
    room.discard = keep;
  }
  return room.deck.pop();
}

function startGame(room) {
  room.started = true;
  room.deck = makeDeck();
  room.discard = [];

  // Deal 7 each (your screenshots show 7)
  for (const p of room.players) {
    p.hand = [];
    p.lastDeclared = false;
    for (let i = 0; i < 7; i++) p.hand.push(drawCard(room));
  }

  // Flip first top card (ensure not null)
  const top = drawCard(room);
  room.discard.push(top);

  room.state = {
    turnIndex: 0,
    direction: 1,
    activeSuit: top.suit, // current suit follows top initially
    pendingDraw2: 0,      // stacking 2s (if your rules do)
    pendingDrawJ: 0,      // stacking Js (if your rules do)
    pendingSkip: 0,       // skip count
    topCard: { id: top.id, rank: top.rank, suit: top.suit },
    feed: "Online match started!"
  };

  broadcastState(room);
}

function currentPlayer(room) {
  return room.players[room.state.turnIndex];
}

function nextTurn(room, steps = 1) {
  const n = room.players.length;
  room.state.turnIndex = (room.state.turnIndex + steps * room.state.direction + n) % n;
}

function canPlayOn(card, topCard, activeSuit) {
  // Basic rule: match rank OR match suit (activeSuit)
  if (!card || !topCard) return false;
  if (card.rank === topCard.rank) return true;
  if (card.suit === activeSuit) return true;

  // Ace can go on anything (you stated that)
  if (card.rank === "A") return true;

  return false;
}

function removeCardsFromHand(hand, cardIds) {
  const set = new Set(cardIds);
  const removed = [];
  const kept = [];
  for (const c of hand) {
    if (set.has(c.id)) removed.push(c);
    else kept.push(c);
  }
  return { removed, kept };
}

function applyPlay(room, playerId, cardIds, chosenSuit) {
  const s = room.state;
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return { ok: false, err: "no_player" };

  // Must be your turn
  if (currentPlayer(room).id !== playerId) return { ok: false, err: "not_your_turn" };

  // If pending skip must be consumed by skipping (client should enforce, server enforces too)
  if (s.pendingSkip > 0) {
    s.pendingSkip = 0;
    s.feed = `${p.name} was skipped`;
    nextTurn(room, 1);
    return { ok: true };
  }

  // If pending draw stacks exist, you may be forced to pick up unless you play same penalty card.
  // NOTE: Your exact rules are specific; this keeps it simple:
  // - pendingDraw2 can be stacked only by playing a 2
  // - pendingDrawJ can be stacked only by playing a J
  const { removed, kept } = removeCardsFromHand(p.hand, cardIds);
  if (removed.length !== cardIds.length) return { ok: false, err: "cards_not_in_hand" };

  // Validate all cards playable in sequence (your client likely sends a run)
  // We'll enforce first card playable vs current top.
  const first = removed[0];
  if (!canPlayOn(first, s.topCard, s.activeSuit)) {
    return { ok: false, err: "illegal_play" };
  }

  // Enforce stacking rules if needed
  if (s.pendingDraw2 > 0 && first.rank !== "2") return { ok: false, err: "must_play_2_or_draw" };
  if (s.pendingDrawJ > 0 && first.rank !== "J") return { ok: false, err: "must_play_J_or_draw" };

  // Apply play
  p.hand = kept;

  // Put cards onto discard in order
  for (const c of removed) room.discard.push(c);

  const lastCard = removed[removed.length - 1];
  s.topCard = { id: lastCard.id, rank: lastCard.rank, suit: lastCard.suit };

  // Default active suit follows top suit
  s.activeSuit = lastCard.suit;

  // POWER CARDS behaviour (adjust to YOUR rules; this matches your messages)
  // - A (Ace): choose suit (do NOT auto-pick). If chosenSuit absent, keep current suit as-is.
  if (lastCard.rank === "A") {
    if (chosenSuit && SUITS.includes(chosenSuit)) s.activeSuit = chosenSuit;
    s.feed = `${p.name} played ${removed.length} card(s)`;
  }
  // - 8: change suit (only playable if 8 or matching suit/rank; client enforces)
  else if (lastCard.rank === "8") {
    if (chosenSuit && SUITS.includes(chosenSuit)) s.activeSuit = chosenSuit;
    s.feed = `${p.name} played ${removed.length} card(s)`;
  }
  // - Q: reverse direction (you said Q reverses direction, not suit)
  else if (lastCard.rank === "Q") {
    s.direction *= -1;
    s.feed = `${p.name} reversed direction`;
  }
  // - J: pickup penalty (your “blackjack”)
  else if (lastCard.rank === "J") {
    s.pendingDrawJ += 1; // each J adds 1 pickup (change if yours is 2)
    s.feed = `${p.name} played J (pickup pending)`;
  }
  // - 2: pickup 2
  else if (lastCard.rank === "2") {
    s.pendingDraw2 += 2;
    s.feed = `${p.name} played 2 (+2 pending)`;
  }
  // - K as power card you can't finish on (you said this earlier)
  else if (lastCard.rank === "K") {
    s.feed = `${p.name} played K`;
  } else {
    s.feed = `${p.name} played ${removed.length} card(s)`;
  }

  // WIN / LAST rules:
  // You said:
  // - You can only go to 0 if you called LAST at the end of your previous turn.
  // - If you try to finish without calling, penalty.
  //
  // We will enforce:
  // - If hand is now 0 and lastDeclared was not already true => penalty pickup 2 and keep playing.
  // - If hand is 0 and lastDeclared true => win.
  if (p.hand.length === 0) {
    if (!p.lastDeclared) {
      // penalty: pick up 2 (or 1 depending your rule)
      p.hand.push(drawCard(room));
      p.hand.push(drawCard(room));
      s.feed = `${p.name} tried to finish without LAST! (+2 penalty)`;
    } else {
      s.feed = `${p.name} wins!`;
      room.started = false; // ends game
      broadcastState(room);
      broadcast(room, { t: "game_over", winner: p.id, name: p.name });
      return { ok: true, gameOver: true };
    }
  }

  // Reset lastDeclared after their turn
  // (they must declare again on future attempts if needed)
  p.lastDeclared = false;

  // Advance turn
  nextTurn(room, 1);
  return { ok: true };
}

function applyDraw(room, playerId) {
  const s = room.state;
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return { ok: false, err: "no_player" };
  if (currentPlayer(room).id !== playerId) return { ok: false, err: "not_your_turn" };

  // Apply pending pickups first
  if (s.pendingDraw2 > 0) {
    const n = s.pendingDraw2;
    for (let i = 0; i < n; i++) p.hand.push(drawCard(room));
    s.pendingDraw2 = 0;
    s.feed = `${p.name} picked up ${n}`;
    nextTurn(room, 1);
    return { ok: true };
  }
  if (s.pendingDrawJ > 0) {
    const n = s.pendingDrawJ;
    for (let i = 0; i < n; i++) p.hand.push(drawCard(room));
    s.pendingDrawJ = 0;
    s.feed = `${p.name} picked up ${n}`;
    nextTurn(room, 1);
    return { ok: true };
  }

  // normal draw 1
  p.hand.push(drawCard(room));
  s.feed = `${p.name} drew 1`;
  nextTurn(room, 1);
  return { ok: true };
}

function applyDeclareLast(room, playerId) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return { ok: false, err: "no_player" };

  // LAST can be declared at end of your turn BEFORE you can finish.
  // We store it and validate on next finish attempt.
  p.lastDeclared = true;
  room.state.feed = `${p.name} declared LAST!`;
  return { ok: true };
}

// -------------------- Personalized State Sync --------------------
function broadcastState(room) {
  const s = room.state;
  if (!s) return;

  // Send a personalized state to each client:
  // - You see your real hand.
  // - Opponents: only correct card count via placeholder objects.
  for (const [ws, meta] of room.clients.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const youId = meta.id;

    const playersForYou = room.players.map((p) => {
      if (p.id === youId) {
        return {
          id: p.id,
          name: p.name,
          lastDeclared: !!p.lastDeclared,
          hand: p.hand.map((c) => ({ id: c.id, rank: c.rank, suit: c.suit }))
        };
      }
      const n = (p.hand || []).length;
      const dummy = [];
      for (let i = 0; i < n; i++) dummy.push({ id: `${p.id}:${i}` });
      return {
        id: p.id,
        name: p.name,
        lastDeclared: !!p.lastDeclared,
        hand: dummy
      };
    });

    const payload = {
      t: "state",
      state: {
        you: youId,
        players: playersForYou,
        turnIndex: s.turnIndex,
        direction: s.direction,
        activeSuit: s.activeSuit,
        pendingDraw2: s.pendingDraw2,
        pendingDrawJ: s.pendingDrawJ,
        pendingSkip: s.pendingSkip,
        topCard: s.topCard,
        feed: s.feed
      }
    };

    try {
      ws.send(JSON.stringify(payload));
    } catch {}
  }
}

// -------------------- Rooms --------------------
const rooms = new Map(); // code -> room

function removeClient(ws) {
  const room = findRoomByWs(ws);
  if (!room) return;

  const meta = room.clients.get(ws);
  room.clients.delete(ws);

  // remove player
  room.players = room.players.filter((p) => p.id !== meta.id);

  // if empty room, delete it
  if (room.clients.size === 0) {
    rooms.delete(room.code);
    return;
  }

  // notify remaining clients
  broadcast(room, { t: "players", room: room.code, players: roomPlayers(room) });

  // if game started, end it
  if (room.started) {
    room.started = false;
    if (room.state) room.state.feed = "Player left — game ended";
    broadcastState(room);
    broadcast(room, { t: "game_over", reason: "player_left" });
  }
}

// -------------------- WebSocket --------------------
wss.on("connection", (ws) => {
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const room = findRoomByWs(ws);

    // CREATE
    if (msg.t === "create") {
      if (room) removeClient(ws);

      let code = randCode(6);
      while (rooms.has(code)) code = randCode(6);

      const playerId = uid();
      const name = (msg.name || "Player").toString().slice(0, 24);

      const newRoom = {
        code,
        clients: new Map(),
        players: [],
        started: false,
        state: null,
        deck: [],
        discard: []
      };

      newRoom.clients.set(ws, { id: playerId, name, isHost: true });
      newRoom.players.push({ id: playerId, name, isHost: true, hand: [], lastDeclared: false });
      rooms.set(code, newRoom);

      send(ws, { t: "created", room: code, you: playerId, players: roomPlayers(newRoom) });
      return;
    }

    // JOIN
    if (msg.t === "join") {
      if (room) removeClient(ws);

      const code = (msg.room || "").toString().trim().toUpperCase();
      const r = rooms.get(code);
      if (!r) {
        send(ws, { t: "error", error: "room_not_found" });
        return;
      }

      if (r.players.length >= 4) {
        send(ws, { t: "error", error: "room_full" });
        return;
      }

      const playerId = uid();
      const name = (msg.name || "Player").toString().slice(0, 24);

      r.clients.set(ws, { id: playerId, name, isHost: false });
      r.players.push({ id: playerId, name, isHost: false, hand: [], lastDeclared: false });

      // tell joiner
      send(ws, { t: "joined", room: code, you: playerId, players: roomPlayers(r) });

      // tell everyone players list updated
      broadcast(r, { t: "players", room: code, players: roomPlayers(r) });
      return;
    }

    // START
    if (msg.t === "start") {
      if (!room) return;
      if (room.started) return;

      // host only
      const meta = room.clients.get(ws);
      const host = room.players.find((p) => p.isHost);
      if (!meta || !host || meta.id !== host.id) {
        send(ws, { t: "error", error: "host_only" });
        return;
      }

      // require 2-4 players
      if (room.players.length < 2) {
        send(ws, { t: "error", error: "need_2_players" });
        return;
      }

      startGame(room);
      broadcast(room, { t: "started" });
      return;
    }

    // GAME ACTIONS
    if (msg.t === "play") {
      if (!room || !room.started) return;
      const meta = room.clients.get(ws);
      if (!meta) return;

      const cardIds = Array.isArray(msg.cards) ? msg.cards : [];
      const suit = msg.suit || null;

      const res = applyPlay(room, meta.id, cardIds, suit);
      if (!res.ok) {
        send(ws, { t: "error", error: res.err });
      }
      broadcastState(room);
      return;
    }

    if (msg.t === "draw") {
      if (!room || !room.started) return;
      const meta = room.clients.get(ws);
      if (!meta) return;

      const res = applyDraw(room, meta.id);
      if (!res.ok) send(ws, { t: "error", error: res.err });
      broadcastState(room);
      return;
    }

    if (msg.t === "last") {
      if (!room || !room.started) return;
      const meta = room.clients.get(ws);
      if (!meta) return;

      const res = applyDeclareLast(room, meta.id);
      if (!res.ok) send(ws, { t: "error", error: res.err });
      broadcastState(room);
      return;
    }

    // SUIT selection is handled by sending "play" with suit when A/8 is played.
  });

  ws.on("close", () => {
    removeClient(ws);
  });
});

server.listen(PORT, () => {
  console.log("Old Skool Blackjack server running on", PORT);
});
