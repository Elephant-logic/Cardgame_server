/**
 * Old Skool Blackjack (Switch) - Online Lobby + Authoritative Server
 * - Rooms (2 or 4 players; bots auto-fill if needed)
 * - Server is source of truth: hands, turn, top card, active suit, effects
 *
 * Protocol (client->server):
 *  {t:"hello", name}
 *  {t:"create_room", seats:2|4}
 *  {t:"join_room", code}
 *  {t:"start"}                          (host only)
 *  {t:"play", cardIds:[...], suit?: "S"|"H"|"D"|"C"}
 *  {t:"draw"}
 *  {t:"last"}                           (marks last-called for NEXT finish)
 *  {t:"leave"}
 *
 * Server->client:
 *  {t:"hello_ok", you:{id,name}}
 *  {t:"rooms", rooms:[{code,seats,count,inGame}]}
 *  {t:"room", room:{code,seats,hostId,players:[{id,name,isBot,handCount}], inGame}}
 *  {t:"state", state:{...}}             (full state for room)
 *  {t:"toast", msg}
 *  {t:"need_suit"}                      (your play requires suit choice)
 *  {t:"ended", winner:{id,name}}
 */

const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const app = express();

// Hard no-cache so you don't get "same old index" problems on Render/CDNs
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
}));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/** -------------------- Helpers -------------------- */
function uid(prefix="p") {
  return prefix + Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(2,6);
}
function roomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i=0;i<5;i++) out += chars[(Math.random()*chars.length)|0];
  return out;
}
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  for (const p of room.players) {
    if (p.ws) safeSend(p.ws, obj);
  }
}
function publicRoom(room) {
  return {
    code: room.code,
    seats: room.seats,
    hostId: room.hostId,
    inGame: room.inGame,
    players: room.players.map(p => ({ id:p.id, name:p.name, isBot:!!p.isBot, handCount:p.hand.length }))
  };
}

/** -------------------- Game Engine -------------------- */
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const SUITS = ["S","H","D","C"];

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) {
    deck.push({ id: uid("c"), r, s });
  }
  // Fisher–Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function draw(deck, n=1) {
  const out = [];
  for (let i=0;i<n;i++) {
    if (deck.length === 0) break;
    out.push(deck.pop());
  }
  return out;
}

function cardLabel(c) {
  const suitSym = c.s === "S" ? "♠" : c.s === "H" ? "♥" : c.s === "D" ? "♦" : "♣";
  return `${c.r}${suitSym}`;
}

function canPlayOn(card, top, activeSuit) {
  if (!card || !top) return false;
  if (card.r === "A") return true;               // Ace wild
  if (card.r === "8") {                          // 8 wild BUT if top is 8, only 8 or A
    return true;
  }
  if (top.r === "8") {
    // User requirement: can't play on 8 unless it's an 8 (or Ace)
    return false;
  }
  return card.r === top.r || card.s === activeSuit;
}

function validateMultiPlay(hand, cardIds, top, activeSuit) {
  if (!Array.isArray(cardIds) || cardIds.length === 0) return { ok:false, err:"No cards selected." };
  const picked = cardIds.map(id => hand.find(c => c.id === id)).filter(Boolean);
  if (picked.length !== cardIds.length) return { ok:false, err:"One or more cards not in your hand." };
  const rank = picked[0].r;
  for (const c of picked) {
    if (c.r !== rank) return { ok:false, err:"Multi-play must be same rank." };
  }
  // First card must be playable
  if (!canPlayOn(picked[0], top, activeSuit)) return { ok:false, err:"That rank/suit doesn't match." };
  // If playing on top 8, only allow 8s or Aces, but multi-play is same rank so already handled
  return { ok:true, picked };
}

function applyEffects(room, playedCards, suitChoice) {
  // Determine new active suit / top
  const last = playedCards[playedCards.length - 1];
  room.top = last;

  // Suit choice required for A or 8
  if (last.r === "A" || last.r === "8") {
    if (!suitChoice || !SUITS.includes(suitChoice)) return { needSuit:true };
    room.activeSuit = suitChoice;
  } else {
    room.activeSuit = last.s;
  }

  // Effects are based on rank (stackable if multiple same rank)
  const rank = last.r;

  if (rank === "Q") {
    room.direction *= -1;
  }

  if (rank === "J") {
    // skip next player
    room.skipNext = true;
  }

  if (rank === "2") {
    room.pendingDraw += 2 * playedCards.length;
  }

  // K is a "power card you can't finish on"
  // handled in finish validation, no extra effect
  return { needSuit:false };
}

function nextTurn(room, steps=1) {
  const n = room.players.length;
  let idx = room.turnIndex;
  for (let i=0;i<steps;i++) {
    idx = (idx + room.direction + n) % n;
  }
  room.turnIndex = idx;
}

function maybeBotAct(room) {
  const current = room.players[room.turnIndex];
  if (!current || !current.isBot || room.ended) return;

  // Simple bot: if pendingDraw, draw and pass
  if (room.pendingDraw > 0) {
    current.hand.push(...draw(room.deck, room.pendingDraw));
    room.pendingDraw = 0;
    if (room.skipNext) room.skipNext = false;
    nextTurn(room, 1);
    return;
  }

  // Find playable cards
  const playable = current.hand.filter(c => canPlayOn(c, room.top, room.activeSuit));
  if (playable.length === 0) {
    current.hand.push(...draw(room.deck, 1));
    nextTurn(room, 1);
    return;
  }

  // Prefer to shed multiples of same rank
  playable.sort((a,b) => RANKS.indexOf(a.r) - RANKS.indexOf(b.r));
  const best = playable[0];
  const sameRank = current.hand.filter(c => c.r === best.r && canPlayOn(c, room.top, room.activeSuit));
  const toPlay = sameRank.map(c=>c.id);

  // Suit choice if needed
  let suitChoice = null;
  if (best.r === "A" || best.r === "8") {
    // choose suit they have most of
    const counts = {S:0,H:0,D:0,C:0};
    for (const c of current.hand) counts[c.s] = (counts[c.s]||0)+1;
    suitChoice = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
  }

  doPlay(room, current.id, toPlay, suitChoice, true);
}

function doPlay(room, playerId, cardIds, suitChoice, isBot=false) {
  const p = room.players.find(x => x.id === playerId);
  if (!p || room.ended) return;

  if (room.players[room.turnIndex].id !== playerId) {
    if (!isBot) broadcast(room, {t:"toast", msg:"Not your turn."});
    return;
  }

  // Pending draw must be taken first (draw-stacking)
  if (room.pendingDraw > 0) {
    // Only allow stacking another 2
    const hand = p.hand;
    const pickedCards = cardIds.map(id => hand.find(c=>c.id===id)).filter(Boolean);
    const okStack = pickedCards.length>0 && pickedCards.every(c => c.r === "2");
    if (!okStack) {
      p.hand.push(...draw(room.deck, room.pendingDraw));
      room.pendingDraw = 0;
      if (room.skipNext) room.skipNext = false;
      nextTurn(room, 1);
      broadcastState(room, `${p.name} picked up`);
      return;
    }
  }

  const v = validateMultiPlay(p.hand, cardIds, room.top, room.activeSuit);
  if (!v.ok) { if(!isBot) safeSend(p.ws, {t:"toast", msg:v.err}); return; }

  const picked = v.picked;
  const rank = picked[0].r;

  // Finish rules:
  // - cannot finish in the SAME turn as pressing LAST (client enforces)
  // - must have lastCalled=true BEFORE the turn that finishes to 0
  // - cannot finish on a K (power card)
  const wouldBeEmpty = (p.hand.length - picked.length) === 0;
  if (wouldBeEmpty) {
    if (rank === "K") {
      // illegal finish: pick up 2, do not play
      p.hand.push(...draw(room.deck, 2));
      p.lastCalled = false;
      safeSend(p.ws, {t:"toast", msg:"Can't go out on a KING. Penalty: pick up 2."});
      broadcastState(room, `${p.name} tried to finish on K`);
      nextTurn(room, 1);
      return;
    }
    if (!p.lastCalled) {
      // penalty draw 2, do not play
      p.hand.push(...draw(room.deck, 2));
      safeSend(p.ws, {t:"toast", msg:"You must have called LAST before going out. Penalty: pick up 2."});
      broadcastState(room, `${p.name} forgot LAST`);
      nextTurn(room, 1);
      return;
    }
  }

  // Remove cards from hand
  const ids = new Set(cardIds);
  p.hand = p.hand.filter(c => !ids.has(c.id));
  room.discard.push(...picked);

  // Apply effects
  const eff = applyEffects(room, picked, suitChoice);
  if (eff.needSuit) {
    // Put cards back (rollback)
    // (only for human; bot always supplies)
    p.hand.push(...picked);
    room.discard.splice(room.discard.length - picked.length, picked.length);
    safeSend(p.ws, {t:"need_suit"});
    return;
  }

  // If player emptied hand, they win
  if (p.hand.length === 0) {
    room.ended = true;
    room.inGame = false;
    broadcast(room, {t:"ended", winner:{id:p.id, name:p.name}});
    broadcastState(room, `${p.name} wins!`);
    return;
  }

  // Move turn
  // skip?
  if (room.skipNext) {
    room.skipNext = false;
    nextTurn(room, 2);
  } else {
    nextTurn(room, 1);
  }

  broadcastState(room, `${p.name} played ${picked.length} card(s)`);

  // Let bot chain (in case next is bot)
  for (let i=0;i<10;i++) { // safety
    if (room.ended) break;
    const cur = room.players[room.turnIndex];
    if (cur && cur.isBot) {
      maybeBotAct(room);
      broadcastState(room, `🤖 ${cur.name} played`);
    } else break;
  }
}

function broadcastState(room, bannerMsg=null) {
  const state = {
    room: publicRoom(room),
    top: room.top,
    activeSuit: room.activeSuit,
    direction: room.direction,
    pendingDraw: room.pendingDraw,
    turnId: room.players[room.turnIndex]?.id,
    banner: bannerMsg || null,
    discardCount: room.discard.length,
  };
  broadcast(room, {t:"state", state});
  // Private hands (each client only sees their own hand)
  for (const p of room.players) {
    if (p.ws) safeSend(p.ws, {t:"hand", hand: p.hand});
  }
}

/** -------------------- Rooms -------------------- */
const rooms = new Map(); // code -> room

function makeBot(i) {
  return {
    id: uid("b"),
    name: `CPU ${i}`,
    isBot: true,
    ws: null,
    hand: [],
    lastCalled: false,
  };
}

function ensureBots(room) {
  while (room.players.length < room.seats) {
    room.players.push(makeBot(room.players.length));
  }
  // If too many players, trim only bots at end
  while (room.players.length > room.seats) {
    const idx = room.players.findIndex(p => p.isBot);
    if (idx === -1) break;
    room.players.splice(idx, 1);
  }
}

function startGame(room) {
  room.inGame = true;
  room.ended = false;

  room.deck = makeDeck();
  room.discard = [];
  room.pendingDraw = 0;
  room.direction = 1;
  room.skipNext = false;

  // reset hands
  for (const p of room.players) {
    p.hand = [];
    p.lastCalled = false;
  }

  // deal 7
  for (let i=0;i<7;i++) {
    for (const p of room.players) {
      p.hand.push(...draw(room.deck, 1));
    }
  }

  // flip top (ensure not wild? it's fine)
  room.top = draw(room.deck, 1)[0];
  room.discard.push(room.top);
  room.activeSuit = room.top.s;

  // choose starting player = host (human if possible)
  let idx = room.players.findIndex(p => p.id === room.hostId);
  if (idx < 0) idx = 0;
  room.turnIndex = idx;

  broadcast(room, {t:"room", room: publicRoom(room)});
  broadcastState(room, "Online match started!");

  // if starting player is bot, act
  for (let i=0;i<10;i++) {
    const cur = room.players[room.turnIndex];
    if (cur && cur.isBot) {
      maybeBotAct(room);
      broadcastState(room, `🤖 ${cur.name} played`);
    } else break;
  }
}

function listRooms() {
  const out = [];
  for (const r of rooms.values()) {
    out.push({ code:r.code, seats:r.seats, count:r.players.filter(p=>!p.isBot).length, inGame:r.inGame });
  }
  return out.sort((a,b)=>a.code.localeCompare(b.code)).slice(0,50);
}

function cleanupRoom(room) {
  // if no humans left, delete
  const humans = room.players.filter(p => !p.isBot);
  if (humans.length === 0) {
    rooms.delete(room.code);
  } else {
    // keep bots to fill seats
    ensureBots(room);
  }
}

/** -------------------- Connections -------------------- */
wss.on("connection", (ws) => {
  const you = { id: uid("p"), name: "Player", ws };
  let room = null;

  safeSend(ws, {t:"hello_ok", you:{id:you.id, name:you.name}});
  safeSend(ws, {t:"rooms", rooms: listRooms()});

  ws.on("message", (buf) => {
    let msg = null;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;

    if (msg.t === "hello") {
      const nm = String(msg.name || "Player").trim().slice(0, 24);
      you.name = nm || "Player";
      safeSend(ws, {t:"hello_ok", you:{id:you.id, name:you.name}});
      return;
    }

    if (msg.t === "create_room") {
      const seats = (msg.seats === 4) ? 4 : 2;
      let code = roomCode();
      while (rooms.has(code)) code = roomCode();

      room = {
        code,
        seats,
        hostId: you.id,
        players: [
          { id: you.id, name: you.name, isBot:false, ws, hand:[], lastCalled:false }
        ],
        inGame: false,
        ended: false,
        deck: [],
        discard: [],
        top: null,
        activeSuit: "S",
        direction: 1,
        turnIndex: 0,
        pendingDraw: 0,
        skipNext: false,
      };
      ensureBots(room);
      rooms.set(code, room);

      safeSend(ws, {t:"room", room: publicRoom(room)});
      broadcast(room, {t:"rooms", rooms: listRooms()});
      return;
    }

    if (msg.t === "join_room") {
      const code = String(msg.code || "").trim().toUpperCase();
      const r = rooms.get(code);
      if (!r) { safeSend(ws, {t:"toast", msg:"Room not found."}); return; }

      // If already in game, allow join as spectator? For now, block.
      if (r.inGame) { safeSend(ws, {t:"toast", msg:"Room already started."}); return; }

      // Add player (replace a bot slot if exists)
      const botIdx = r.players.findIndex(p => p.isBot);
      if (botIdx !== -1) r.players.splice(botIdx, 1);
      r.players.push({ id: you.id, name: you.name, isBot:false, ws, hand:[], lastCalled:false });
      ensureBots(r);

      room = r;
      broadcast(room, {t:"room", room: publicRoom(room)});
      broadcast(room, {t:"toast", msg:`${you.name} joined ${code}`});
      broadcast(room, {t:"rooms", rooms: listRooms()});
      return;
    }

    if (!room) { safeSend(ws, {t:"toast", msg:"Create or join a room first."}); return; }

    if (msg.t === "start") {
      if (room.hostId !== you.id) { safeSend(ws, {t:"toast", msg:"Only host can start."}); return; }
      if (room.inGame) return;
      startGame(room);
      broadcast(room, {t:"rooms", rooms: listRooms()});
      return;
    }

    if (msg.t === "last") {
      const p = room.players.find(p=>p.id===you.id);
      if (!p) return;
      // Mark last-called; can't be used to finish same turn (client flow)
      p.lastCalled = true;
      safeSend(ws, {t:"toast", msg:"LAST called."});
      broadcastState(room, `${p.name} called LAST!`);
      return;
    }

    if (msg.t === "draw") {
      if (!room.inGame || room.ended) return;
      const cur = room.players[room.turnIndex];
      if (!cur || cur.id !== you.id) { safeSend(ws, {t:"toast", msg:"Not your turn."}); return; }

      const p = room.players.find(p=>p.id===you.id);
      if (!p) return;

      if (room.pendingDraw > 0) {
        p.hand.push(...draw(room.deck, room.pendingDraw));
        room.pendingDraw = 0;
        broadcastState(room, `${p.name} picked up`);
      } else {
        p.hand.push(...draw(room.deck, 1));
        broadcastState(room, `${p.name} drew 1`);
      }

      if (room.skipNext) room.skipNext = false;
      nextTurn(room, 1);
      broadcastState(room);

      // bots
      for (let i=0;i<10;i++) {
        if (room.ended) break;
        const cur2 = room.players[room.turnIndex];
        if (cur2 && cur2.isBot) {
          maybeBotAct(room);
          broadcastState(room, `🤖 ${cur2.name} played`);
        } else break;
      }
      return;
    }

    if (msg.t === "play") {
      if (!room.inGame || room.ended) return;
      const cardIds = Array.isArray(msg.cardIds) ? msg.cardIds.map(String) : [];
      const suit = msg.suit ? String(msg.suit).toUpperCase() : null;
      doPlay(room, you.id, cardIds, suit, false);
      broadcast(room, {t:"room", room: publicRoom(room)});
      return;
    }

    if (msg.t === "leave") {
      ws.close();
      return;
    }
  });

  ws.on("close", () => {
    // remove from room if any
    if (room) {
      const idx = room.players.findIndex(p => p.id === you.id);
      if (idx !== -1) room.players.splice(idx, 1);
      ensureBots(room);
      broadcast(room, {t:"room", room: publicRoom(room)});
      broadcast(room, {t:"toast", msg:`${you.name} left`});
      cleanupRoom(room);
      broadcast(room, {t:"rooms", rooms: listRooms()});
    }
  });
});

server.listen(PORT, () => {
  console.log("Old Skool Blackjack server running on", PORT);
});
