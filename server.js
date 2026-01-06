import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// =========================
// Rules (SERVER truth)
// =========================
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const POWER_RANKS = new Set(["A", "2", "8", "J", "Q", "K"]); // King treated separately but also no-finish
const SUIT_MAP = { H:"♥", D:"♦", C:"♣", S:"♠" };

function rankVal(r){
  if (r === "A") return 1;
  if (r === "J") return 11;
  if (r === "Q") return 12;
  if (r === "K") return 13;
  return parseInt(r, 10);
}
function canStart(c, top, suit){
  return c.rank === "A" || c.suit === suit || c.rank === top.rank;
}
function linkOk(p, n){
  return p.rank === n.rank || (p.suit === n.suit && Math.abs(rankVal(p.rank) - rankVal(n.rank)) === 1);
}
function createDeck(){
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit:s, rank:r });
  return d;
}
function shuffle(arr){
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
function drawCards(room, n){
  const out = [];
  for (let i = 0; i < n; i++){
    if (room.deck.length === 0){
      if (room.discard.length > 1){
        const top = room.discard.pop();
        const rest = room.discard;
        room.discard = [top];
        shuffle(rest);
        room.deck = rest;
        room.feed = "Reshuffled!";
      } else {
        room.deck = createDeck();
        shuffle(room.deck);
        room.feed = "New Cards Added!";
      }
    }
    out.push(room.deck.pop());
  }
  return out;
}

// =========================
// Rooms / Lobby
// =========================
const rooms = new Map(); // code -> room
const clients = new Map(); // ws -> { id, name, roomCode, seat }

function makeCode(){
  return crypto.randomBytes(4).toString("hex").slice(0,6).toUpperCase();
}

function makeRoom(hostWs, hostName){
  let code = makeCode();
  while (rooms.has(code)) code = makeCode();

  const room = {
    code,
    createdAt: Date.now(),
    started: false,

    deck: [],
    discard: [],
    players: [], // {id,name,ws,hand,lastDeclaredTurn,connected}
    turn: 0,
    direction: 1,
    activeSuit: null,

    pendingDraw2: 0,
    pendingDrawJ: 0,
    pendingSkip: 0,
    extraTurn: false,

    awaitingAceSeat: null,
    turnCounter: 0,
    feed: "Lobby ready."
  };

  room.players.push({
    id: crypto.randomUUID(),
    name: hostName,
    ws: hostWs,
    hand: [],
    lastDeclaredTurn: -1,
    connected: true
  });

  rooms.set(code, room);
  return room;
}

function joinRoom(room, ws, name){
  if (room.players.length >= 4) return { ok:false, err:"Room full (max 4)." };
  if (room.started) return { ok:false, err:"Game already started." };

  room.players.push({
    id: crypto.randomUUID(),
    name,
    ws,
    hand: [],
    lastDeclaredTurn: -1,
    connected: true
  });
  room.feed = `${name} joined.`;
  return { ok:true };
}

function roomPublicInfo(room){
  return {
    code: room.code,
    started: room.started,
    players: room.players.map((p, i) => ({ seat:i, name:p.name, connected:p.connected }))
  };
}

function send(ws, obj){
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(obj));
}

function broadcastRoom(room){
  room.players.forEach((p, seat) => {
    if (!p.connected) return;

    const view = {
      you: { seat, name: p.name, hand: p.hand, lastDeclaredTurn: p.lastDeclaredTurn },
      others: room.players.map((op, i) => i === seat
        ? null
        : ({ seat:i, name:op.name, count: op.hand.length, lastDeclaredTurn: op.lastDeclaredTurn, connected:op.connected })
      ).filter(Boolean),

      top: room.discard[room.discard.length - 1] || null,
      activeSuit: room.activeSuit,
      turn: room.turn,
      direction: room.direction,

      pendingDraw2: room.pendingDraw2,
      pendingDrawJ: room.pendingDrawJ,
      pendingSkip: room.pendingSkip,

      awaitingAceSeat: room.awaitingAceSeat,
      extraTurn: room.extraTurn,
      turnCounter: room.turnCounter,
      feed: room.feed
    };

    send(p.ws, { type:"state", room: roomPublicInfo(room), view });
  });
}

function endGame(room, winnerSeat){
  const winner = room.players[winnerSeat];
  room.feed = `🎉 ${winner?.name || "Player"} wins!`;
  room.started = false;
  broadcastRoom(room);
}

// =========================
// Turn & start-of-turn effects
// =========================
function advanceTurn(room){
  if (room.extraTurn){
    room.extraTurn = false;
    room.feed = "KING: Play again!";
    return;
  }

  room.turn = (room.turn + room.direction + room.players.length) % room.players.length;
  room.turnCounter++;

  applyStartOfTurn(room);
}

function applyStartOfTurn(room){
  if (room.awaitingAceSeat !== null) return;

  let safety = 0;
  while (room.pendingSkip > 0 && safety++ < 12){
    const p = room.players[room.turn];
    const top = room.discard[room.discard.length - 1];
    const suit = room.activeSuit;

    const playable8 = p.hand.findIndex(c => c.rank === "8" && canStart(c, top, suit));
    if (playable8 !== -1){
      room.feed = `⚠️ SKIP x${room.pendingSkip} on ${p.name} (Play an 8 to stack, or get skipped).`;
      return;
    }

    room.pendingSkip--;
    room.feed = `⏭️ ${p.name} skipped! (8 stack left: ${room.pendingSkip})`;
    room.turn = (room.turn + room.direction + room.players.length) % room.players.length;
    room.turnCounter++;
  }
}

function dealNewGame(room){
  room.deck = createDeck();
  shuffle(room.deck);
  room.discard = [];
  room.direction = 1;
  room.turn = 0;
  room.turnCounter = 0;

  room.pendingDraw2 = 0;
  room.pendingDrawJ = 0;
  room.pendingSkip = 0;
  room.extraTurn = false;
  room.awaitingAceSeat = null;

  room.players.forEach(p => {
    p.hand = [];
    p.lastDeclaredTurn = -1;
  });

  for (let i = 0; i < 7; i++){
    room.players.forEach(p => p.hand.push(room.deck.pop()));
  }

  while (true){
    const start = room.deck.pop();
    if (!POWER_RANKS.has(start.rank) && start.rank !== "K"){
      room.discard.push(start);
      room.activeSuit = start.suit;
      break;
    }
    room.deck.unshift(start);
  }

  room.feed = "Cards are in play!";
  room.started = true;

  applyStartOfTurn(room);
}

// =========================
// Powers
// =========================
function applyPower(room, card, seat, isLastInPlay){
  const r = card.rank;

  if (r === "A" && isLastInPlay){
    room.awaitingAceSeat = seat;
    return;
  }
  if (r === "2"){
    room.pendingDraw2 += 2;
    return;
  }
  if (r === "8"){
    room.pendingSkip += 1;
    return;
  }
  if (r === "Q"){
    room.direction *= -1;
    return;
  }
  if (r === "K"){
    room.extraTurn = true;
    return;
  }
  if (r === "J"){
    if (card.suit === "♥" || card.suit === "♦"){
      if (room.pendingDrawJ > 0) room.pendingDrawJ = 0;
    } else {
      room.pendingDrawJ += 5;
    }
  }
}

// =========================
// Validations & actions
// =========================
function ensureRoomAndSeat(ws){
  const c = clients.get(ws);
  if (!c?.roomCode) return { ok:false, err:"Not in a room." };
  const room = rooms.get(c.roomCode);
  if (!room) return { ok:false, err:"Room missing." };
  const seat = c.seat;
  if (seat == null || !room.players[seat]) return { ok:false, err:"Seat missing." };
  return { ok:true, room, seat };
}

function reject(ws, msg){
  send(ws, { type:"toast", msg });
}

function handleDraw(room, seat){
  if (!room.started) return;
  if (room.awaitingAceSeat !== null) return;
  if (seat !== room.turn) return;

  const p = room.players[seat];

  if (room.pendingSkip > 0){
    room.feed = "No draw under 8-skip. Play an 8 or you'll be skipped.";
    return;
  }

  let n = 1;
  if (room.pendingDraw2 > 0){
    n = room.pendingDraw2;
    room.pendingDraw2 = 0;
  } else if (room.pendingDrawJ > 0){
    n = room.pendingDrawJ;
    room.pendingDrawJ = 0;
  }

  const drawn = drawCards(room, n);
  p.hand.push(...drawn);

  room.feed = `${p.name} drew ${n}.`;
  p.lastDeclaredTurn = -1;

  advanceTurn(room);
  applyStartOfTurn(room);
}

function handleLast(room, seat){
  if (!room.started) return;
  if (room.awaitingAceSeat !== null) return;
  if (seat !== room.turn) return;

  const p = room.players[seat];
  p.lastDeclaredTurn = room.turnCounter;
  room.feed = `${p.name} called LAST!`;
}

function handleAcePick(room, seat, suitChar){
  if (!room.started) return;
  if (room.awaitingAceSeat !== seat) return;

  const suit = SUIT_MAP[suitChar];
  if (!suit) return;

  room.activeSuit = suit;
  room.awaitingAceSeat = null;
  room.feed = `Suit is ${suit}`;

  advanceTurn(room);
  applyStartOfTurn(room);
}

function handlePlay(room, seat, indices){
  if (!room.started) return;
  if (room.awaitingAceSeat !== null) return;
  if (seat !== room.turn) return;

  const p = room.players[seat];
  if (!Array.isArray(indices) || indices.length === 0) return;

  const uniq = [...new Set(indices)]
    .filter(i => Number.isInteger(i) && i >= 0 && i < p.hand.length);

  if (uniq.length === 0) return;

  const cards = uniq.map(i => p.hand[i]);

  if (room.pendingDraw2 > 0 && cards[0].rank !== "2"){
    room.feed = "Must play a 2!";
    return;
  }
  if (room.pendingDrawJ > 0 && cards[0].rank !== "J"){
    room.feed = "Must play a Jack!";
    return;
  }
  if (room.pendingSkip > 0 && cards[0].rank !== "8"){
    room.feed = "Under 8-skip: play an 8 or be skipped.";
    return;
  }

  const top = room.discard[room.discard.length - 1];
  if (!canStart(cards[0], top, room.activeSuit)){
    room.feed = "Invalid card.";
    return;
  }
  for (let i = 0; i < cards.length - 1; i++){
    if (!linkOk(cards[i], cards[i + 1])){
      room.feed = "Invalid combo.";
      return;
    }
  }

  const isSet = cards.length > 1 && cards.every(c => c.rank === cards[0].rank);

  const remaining = p.hand.length - cards.length;
  if ((remaining === 1 || remaining === 0) && p.lastDeclaredTurn !== room.turnCounter){
    room.feed = "Call LAST before leaving 1 or finishing!";
    return;
  }

  const remove = [...uniq].sort((a,b)=>b-a);
  for (const i of remove) p.hand.splice(i, 1);

  room.feed = `${p.name} played ${cards.length}.`;

  cards.forEach((c, i) => {
    room.discard.push(c);
    const isLast = i === cards.length - 1;
    const allowPower = (isSet || isLast);
    if (allowPower){
      if (POWER_RANKS.has(c.rank) || c.rank === "K"){
        applyPower(room, c, seat, isLast);
      }
    }
  });

  const lastCard = cards[cards.length - 1];
  if (lastCard.rank !== "A"){
    room.activeSuit = lastCard.suit;
  }

  const triedFinish = p.hand.length === 0;
  const finishedOnPower = triedFinish && (POWER_RANKS.has(lastCard.rank) || lastCard.rank === "K");
  if (finishedOnPower){
    p.hand.push(...drawCards(room, 2));
    p.lastDeclaredTurn = -1;
    room.extraTurn = false;
    room.feed = `⚠️ No power-card finish! ${p.name} drew 2.`;
    advanceTurn(room);
    applyStartOfTurn(room);
    return;
  }

  if (p.hand.length === 0){
    endGame(room, seat);
    return;
  }

  if (room.awaitingAceSeat !== null){
    room.feed = `${p.name} must pick a suit.`;
    return;
  }

  advanceTurn(room);
  applyStartOfTurn(room);
}

wss.on("connection", (ws) => {
  const id = crypto.randomUUID();
  clients.set(ws, { id, name: null, roomCode: null, seat: null });

  send(ws, { type:"hello", id });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const c = clients.get(ws);
    if (!c) return;

    if (msg.type === "set_name"){
      const name = String(msg.name || "").trim().slice(0, 12);
      if (!name) return reject(ws, "Enter a name.");
      c.name = name;
      send(ws, { type:"name_ok", name });
      return;
    }

    if (msg.type === "create_room"){
      if (!c.name) return reject(ws, "Set your name first.");
      const room = makeRoom(ws, c.name);
      c.roomCode = room.code;
      c.seat = 0;
      room.feed = `${c.name} created room ${room.code}.`;
      send(ws, { type:"room_created", room: roomPublicInfo(room), seat: 0 });
      broadcastRoom(room);
      return;
    }

    if (msg.type === "join_room"){
      if (!c.name) return reject(ws, "Set your name first.");
      const code = String(msg.code || "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return reject(ws, "Room not found.");
      const res = joinRoom(room, ws, c.name);
      if (!res.ok) return reject(ws, res.err);

      c.roomCode = room.code;
      c.seat = room.players.length - 1;

      send(ws, { type:"room_joined", room: roomPublicInfo(room), seat: c.seat });
      broadcastRoom(room);
      return;
    }

    if (msg.type === "start_game"){
      const { ok, room, seat, err } = ensureRoomAndSeat(ws);
      if (!ok) return reject(ws, err);
      if (seat !== 0) return reject(ws, "Only host can deal.");
      if (room.players.length < 2) return reject(ws, "Need at least 2 players.");
      dealNewGame(room);
      broadcastRoom(room);
      return;
    }

    if (msg.type === "action"){
      const { ok, room, seat, err } = ensureRoomAndSeat(ws);
      if (!ok) return reject(ws, err);
      if (!room.started) return;

      const a = msg.action;

      if (a === "draw"){
        handleDraw(room, seat);
        broadcastRoom(room);
        return;
      }
      if (a === "last"){
        handleLast(room, seat);
        broadcastRoom(room);
        return;
      }
      if (a === "play"){
        handlePlay(room, seat, msg.indices);
        broadcastRoom(room);
        return;
      }
      if (a === "ace"){
        handleAcePick(room, seat, msg.suit);
        broadcastRoom(room);
        return;
      }
    }
  });

  ws.on("close", () => {
    const c = clients.get(ws);
    if (!c) return;

    if (c.roomCode){
      const room = rooms.get(c.roomCode);
      if (room){
        const p = room.players[c.seat];
        if (p){
          p.connected = false;
          room.feed = `${p.name} disconnected.`;
        }
        broadcastRoom(room);

        const anyConnected = room.players.some(x => x.connected);
        if (!anyConnected) rooms.delete(room.code);
      }
    }
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`Old Skool Blackjack WS running on :${PORT}`);
});
