const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");

// ----------------------------
// Basic server Setup
// ----------------------------
const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));

// ----------------------------
// Helpers
// ----------------------------
function rid(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function send(ws, type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcast(room, type, payload = {}) {
  for (const ws of room.clients.values()) send(ws, type, payload);
}

function safeParse(msg) {
  try { return JSON.parse(msg); } catch { return null; }
}

// ----------------------------
// Game Rules (SERVER AUTHORITY)
// ----------------------------
const POWER_RANKS = new Set(["A", "2", "8", "J", "Q", "K"]);

function rankVal(r) {
  if (r === "A") return 1;
  if (r === "J") return 11;
  if (r === "Q") return 12;
  if (r === "K") return 13;
  return parseInt(r, 10);
}

function canStart(c, top, suit) {
  // If top is undefined (empty discard), any card is valid
  if (!top) return true; 
  return c.rank === "A" || c.suit === suit || c.rank === top.rank;
}

function linkOk(p, n) {
  return p.rank === n.rank || (p.suit === n.suit && Math.abs(rankVal(p.rank) - rankVal(n.rank)) === 1);
}

function createDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({ suit: s, rank: r });
  return deck;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function topCard(state) {
  return state.discard[state.discard.length - 1];
}

function draw(state, n, events) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (state.deck.length === 0) {
      if (state.discard.length > 1) {
        const top = state.discard.pop();
        const rest = state.discard;
        state.discard = [top];
        shuffle(rest);
        state.deck = rest;
        events.push({ t: "feed", m: "Reshuffled!" });
      } else {
        const nd = createDeck();
        shuffle(nd);
        state.deck = nd;
        events.push({ t: "feed", m: "New Cards Added!" });
      }
    }
    if (state.deck.length > 0) out.push(state.deck.pop());
  }
  return out;
}

// Fallback logic if user doesn't send a suit
function chooseSuitForBotLike(state, pidx) {
  const p = state.players[pidx];
  const counts = { "♠":0, "♥":0, "♦":0, "♣":0 };
  for (const c of p.hand) counts[c.suit]++;
  let best = "♠";
  for (const k of Object.keys(counts)) if (counts[k] > counts[best]) best = k;
  return best;
}

function applyPower(state, card, pidx, isLast, events, chosenSuit) {
  const r = card.rank;
  const p = state.players[pidx];

  // ACE LOGIC: Updated to accept user input
  if (r === "A" && isLast) {
    if (chosenSuit && ["♠", "♥", "♦", "♣"].includes(chosenSuit)) {
        state.activeSuit = chosenSuit;
    } else {
        state.activeSuit = chooseSuitForBotLike(state, pidx);
    }
    events.push({ t: "feed", m: `Suit changed to ${state.activeSuit}` });
    return;
  }

  if (r === "2") state.pendingDraw2 += 2;
  else if (r === "8") state.pendingSkip += 1;
  else if (r === "Q") {
    state.direction *= -1;
    events.push({ t: "feed", m: state.direction === 1 ? "Direction: Clockwise" : "Direction: Reversed!" });
  }
  else if (r === "K") {
    state.extraTurn = true;
  }
  else if (r === "J") {
    const isRed = (card.suit === "♥" || card.suit === "♦");
    if (isRed) {
      state.pendingDrawJ = 0;
      events.push({ t: "feed", m: "Attack Blocked!" });
    } else {
      state.pendingDrawJ += 5;
    }
  }
}

function startNewGame(playerIdsBySeat, namesBySeat) {
  const state = {
    status: "playing",
    deck: shuffle(createDeck()),
    discard: [],
    players: [],
    turnIndex: 0,
    direction: 1,
    activeSuit: null,

    pendingDraw2: 0,
    pendingDrawJ: 0,
    pendingSkip: 0,
    extraTurn: false,

    winnerSeat: null
  };

  for (let i = 0; i < playerIdsBySeat.length; i++) {
    state.players.push({
      seat: i,
      id: playerIdsBySeat[i],
      name: namesBySeat[i] || `Player ${i+1}`,
      hand: [],
      lastDeclared: false
    });
  }

  const events = [];
  // Deal 7 cards each
  for (let r = 0; r < 7; r++) {
    for (let i = 0; i < state.players.length; i++) {
      state.players[i].hand.push(...draw(state, 1, events));
    }
  }

  // Flip first top card
  // Ensure it's not a power card for a clean start (optional, but good for game flow)
  let first;
  while(true) {
      first = draw(state, 1, events)[0];
      if(!POWER_RANKS.has(first.rank)) break;
      state.deck.unshift(first); // Put back and try again
  }
  
  state.discard.push(first);
  state.activeSuit = first.suit;

  events.push({ t: "feed", m: `Top card is ${first.rank}${first.suit}` });

  return { state, events };
}

function isPlayersTurn(state, seat) {
  return state.turnIndex === seat;
}

function advanceTurn(state) {
  const n = state.players.length;
  state.turnIndex = (state.turnIndex + state.direction + n) % n;
}

function applyAction(state, seat, action) {
  const events = [];
  if (state.status !== "playing") return { ok: false, err: "Game not active", events };

  // Allow declaring LAST out of turn (optional, but usually strict turn based in this code)
  // For now, we restrict all actions to the active player for simplicity
  if (!isPlayersTurn(state, seat)) return { ok: false, err: "Not your turn", events };

  const p = state.players[seat];

  // ---------- DECLARE LAST ----------
  if (action.type === "DECLARE_LAST") {
    p.lastDeclared = true;
    events.push({ t: "feed", m: `${p.name} shouts LAST!` });
    return { ok: true, events };
  }

  // ---------- DRAW ----------
  if (action.type === "DRAW") {
    let toDraw = 1;

    if (state.pendingDraw2 > 0) {
      toDraw = state.pendingDraw2;
      state.pendingDraw2 = 0;
      events.push({ t: "feed", m: `${p.name} draws ${toDraw} (2 stack)` });
    } else if (state.pendingDrawJ > 0) {
      toDraw = state.pendingDrawJ;
      state.pendingDrawJ = 0;
      events.push({ t: "feed", m: `${p.name} draws ${toDraw} (Jack stack)` });
    } else if (state.pendingSkip > 0) {
      state.pendingSkip = 0;
      events.push({ t: "feed", m: `${p.name} is skipped!` });
      p.lastDeclared = false; // Reset LAST on skip
      advanceTurn(state);
      return { ok: true, events };
    } else {
      events.push({ t: "feed", m: `${p.name} draws 1` });
    }

    p.hand.push(...draw(state, toDraw, events));
    p.lastDeclared = false; // Reset LAST on draw
    advanceTurn(state);
    return { ok: true, events };
  }

  // ---------- PLAY ----------
  if (action.type === "PLAY") {
    const indices = Array.isArray(action.indices) ? action.indices.slice() : [];
    if (indices.length === 0) return { ok: false, err: "No cards selected", events };

    // Sort descending to remove safely
    const uniq = Array.from(new Set(indices)).filter(i => Number.isInteger(i));
    uniq.sort((a,b) => b - a);

    if (uniq[0] >= p.hand.length || uniq[uniq.length-1] < 0) {
      return { ok: false, err: "Invalid selection", events };
    }

    const cards = uniq.map(i => p.hand[i]);

    // Validation
    if (state.pendingDraw2 > 0 && cards[0].rank !== "2") return { ok: false, err: "Must play a 2!", events };
    if (state.pendingDrawJ > 0 && cards[0].rank !== "J") return { ok: false, err: "Must play a Jack (or DRAW)!", events };
    if (state.pendingSkip > 0 && cards[0].rank !== "8") return { ok: false, err: "Can only stack an 8!", events };

    const top = topCard(state);
    if (!canStart(cards[0], top, state.activeSuit)) return { ok: false, err: "Invalid Card", events };

    for (let i = 0; i < cards.length - 1; i++) {
      if (!linkOk(cards[i], cards[i+1])) return { ok: false, err: "Invalid Combo", events };
    }

    // Remove from hand
    for (const i of uniq) p.hand.splice(i, 1);

    const finishedNow = (p.hand.length === 0);
    const isSet = cards.length > 1 && cards.every(c => c.rank === cards[0].rank);

    // Play to discard & Apply Power
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      state.discard.push(c);
      const isLast = (i === cards.length - 1);

      if (POWER_RANKS.has(c.rank) && (isSet || isLast)) {
        // We pass the user's chosen suit (action.suitParam) here
        applyPower(state, c, seat, isLast, events, action.suitParam);
      }
    }

    const lastCard = cards[cards.length - 1];
    // If it's NOT an Ace, the suit becomes the card's suit
    // If it IS an Ace, applyPower handled the suit change
    if (lastCard.rank !== "A") state.activeSuit = lastCard.suit;

    events.push({ t: "feed", m: `${p.name} played ${cards.length}` });

    // 1) FORGOT LAST PENALTY
    // If you finish, but p.lastDeclared is false -> Draw 2
    if (finishedNow && !p.lastDeclared) {
      events.push({ t: "feed", m: `⚠️ ${p.name} Forgot LAST! Draw 2` });
      p.hand.push(...draw(state, 2, events));
      p.lastDeclared = false;
      advanceTurn(state);
      return { ok: true, events };
    }

    // 2) POWER FINISH PENALTY
    if (finishedNow && POWER_RANKS.has(lastCard.rank)) {
      events.push({ t: "feed", m: `Can't end on Power! Pick up 1` });
      p.hand.push(...draw(state, 1, events));
      p.lastDeclared = false;
      advanceTurn(state);
      return { ok: true, events };
    }

    // WIN CONDITION
    if (p.hand.length === 0) {
      state.status = "ended";
      state.winnerSeat = seat;
      events.push({ t: "feed", m: `🏆 ${p.name} wins!` });
      return { ok: true, events };
    }

    p.lastDeclared = false; // Reset "Last" status after a successful play that didn't win

    if (state.extraTurn) {
      state.extraTurn = false;
      events.push({ t: "feed", m: `KING: Play Again!` });
      return { ok: true, events };
    }

    advanceTurn(state);
    return { ok: true, events };
  }

  return { ok: false, err: "Unknown action", events };
}

// ----------------------------
// Room Management
// ----------------------------
const rooms = new Map();

function getRoom(code) { return rooms.get(code); }

function makeRoom() {
  let code;
  do { code = rid(5); } while (rooms.has(code));
  const room = {
    code,
    clients: new Map(),
    seats: [null, null],
    names: new Map(),
    state: null
  };
  rooms.set(code, room);
  return room;
}

function roomInfo(room) {
  return {
    code: room.code,
    seats: room.seats.map((pid, i) => {
      if (!pid) return { seat: i, occupied: false };
      return { seat: i, occupied: true, id: pid, name: room.names.get(pid) || "Player" };
    }),
    started: !!room.state
  };
}

function publicStateFor(room, viewerId) {
  const s = room.state;
  if (!s) return null;

  // Clone state to modify for public view
  const out = JSON.parse(JSON.stringify(s));
  
  // Hide opponent hands
  for (const pl of out.players) {
    if (pl.id !== viewerId) {
      pl.handCount = pl.hand.length;
      pl.hand = []; // Hide actual cards
    }
  }
  out.deckCount = out.deck.length;
  return out;
}

function seatOf(room, playerId) {
  return room.seats.findIndex(x => x === playerId);
}

function broadcastState(room) {
  for (const [pid, ws] of room.clients.entries()) {
    send(ws, "GAME_STATE", { state: publicStateFor(room, pid) });
  }
  broadcast(room, "ROOM_INFO", { room: roomInfo(room) });
}

// ----------------------------
// WebSocket Handler
// ----------------------------
wss.on("connection", (ws) => {
  ws._pid = rid(10);
  ws._room = null;

  send(ws, "HELLO", { playerId: ws._pid });

  ws.on("message", (raw) => {
    const msg = safeParse(raw);
    if (!msg || !msg.type) return;

    // --- CREATE ---
    if (msg.type === "CREATE_ROOM") {
      const room = makeRoom();
      room.clients.set(ws._pid, ws);
      room.names.set(ws._pid, (msg.name || "Player 1").slice(0, 18));
      room.seats[0] = ws._pid;
      ws._room = room.code;

      send(ws, "ROOM_CREATED", { code: room.code });
      broadcastState(room);
      return;
    }

    // --- JOIN ---
    if (msg.type === "JOIN_ROOM") {
      const code = (msg.code || "").toUpperCase().trim();
      const room = getRoom(code);
      if (!room) return send(ws, "ERROR", { message: "Room not found" });

      if (!room.seats.includes(null) && !room.seats.includes(ws._pid)) {
        return send(ws, "ERROR", { message: "Room full" });
      }

      room.clients.set(ws._pid, ws);
      room.names.set(ws._pid, (msg.name || "Player").slice(0, 18));

      if (room.seats[0] === null) room.seats[0] = ws._pid;
      else if (room.seats[1] === null) room.seats[1] = ws._pid;

      ws._room = room.code;

      send(ws, "ROOM_JOINED", { code: room.code });
      broadcastState(room);
      return;
    }

    // --- START ---
    if (msg.type === "START_GAME") {
      const room = ws._room ? getRoom(ws._room) : null;
      if (!room) return;
      if (room.seats.includes(null)) return send(ws, "ERROR", { message: "Waiting for P2..." });

      if (!room.state) {
        const names = room.seats.map(pid => room.names.get(pid) || "Player");
        const { state, events } = startNewGame(room.seats, names);
        room.state = state;
        broadcast(room, "FEED", { events });
        broadcastState(room);
      }
      return;
    }

    // --- ACTION ---
    if (msg.type === "ACTION") {
      const room = ws._room ? getRoom(ws._room) : null;
      if (!room || !room.state) return;

      const seat = seatOf(room, ws._pid);
      if (seat < 0) return;

      const res = applyAction(room.state, seat, msg.action || {});
      if (!res.ok) {
        send(ws, "ERROR", { message: res.err || "Invalid" });
      }
      if (res.events.length) broadcast(room, "FEED", { events: res.events });
      broadcastState(room);
      return;
    }
  });

  ws.on("close", () => {
    const code = ws._room;
    if (!code) return;
    const room = getRoom(code);
    if (!room) return;

    room.clients.delete(ws._pid);
    
    // Clear seat
    const seat = seatOf(room, ws._pid);
    if (seat >= 0) room.seats[seat] = null;

    if (room.clients.size === 0) {
      rooms.delete(room.code);
      return;
    }

    if (room.state && room.state.status === "playing") {
      room.state.status = "ended";
      broadcast(room, "FEED", { events: [{ t:"feed", m:"Opponent left. Game ended." }] });
    }
    broadcastState(room);
  });
});
