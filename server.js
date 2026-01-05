const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, "public")));

/* =========================
   GAME STATE
========================= */

const rooms = new Map();

function makeDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function createRoom() {
  return {
    id: crypto.randomUUID(),
    players: [],
    deck: makeDeck(),
    discard: [],
    turn: 0,
    started: false
  };
}

function buildState(room) {
  return {
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      hand: p.hand.length
    })),
    discardTop: room.discard.at(-1) || null,
    turn: room.players[room.turn]?.id || null,
    started: room.started
  };
}

/* =========================
   WEBSOCKET HANDLING
========================= */

wss.on("connection", ws => {
  ws.id = crypto.randomUUID();
  ws.room = null;

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    /* CREATE ROOM */
    if (msg.type === "create") {
      const room = createRoom();
      rooms.set(room.id, room);

      const player = {
        id: ws.id,
        name: msg.name,
        ws,
        hand: []
      };

      room.players.push(player);
      ws.room = room;

      ws.send(JSON.stringify({ type: "room", roomId: room.id }));
      sendState(room);
      return;
    }

    /* JOIN ROOM */
    if (msg.type === "join") {
      const room = rooms.get(msg.roomId);
      if (!room || room.players.length >= 4) return;

      const player = {
        id: ws.id,
        name: msg.name,
        ws,
        hand: []
      };

      room.players.push(player);
      ws.room = room;

      ws.send(JSON.stringify({ type: "room", roomId: room.id }));
      sendState(room);
      return;
    }

    /* START GAME */
    if (msg.type === "start") {
      const room = ws.room;
      if (!room || room.started) return;

      room.started = true;
      room.players.forEach(p => {
        p.hand = room.deck.splice(0, 7);
      });
      room.discard.push(room.deck.pop());

      sendState(room);
      return;
    }

    /* PLAY CARD */
    if (msg.type === "play") {
      const room = ws.room;
      if (!room) return;

      const idx = room.players.findIndex(p => p.id === ws.id);
      if (idx !== room.turn) return;

      const player = room.players[idx];
      const card = player.hand.splice(msg.cardIndex, 1)[0];
      if (!card) return;

      room.discard.push(card);
      room.turn = (room.turn + 1) % room.players.length;

      sendState(room);
      return;
    }

    /* DRAW */
    if (msg.type === "draw") {
      const room = ws.room;
      if (!room) return;

      const idx = room.players.findIndex(p => p.id === ws.id);
      if (idx !== room.turn) return;

      const player = room.players[idx];
      if (room.deck.length) {
        player.hand.push(room.deck.pop());
      }

      room.turn = (room.turn + 1) % room.players.length;
      sendState(room);
      return;
    }
  });

  ws.on("close", () => {
    const room = ws.room;
    if (!room) return;

    room.players = room.players.filter(p => p.id !== ws.id);
    if (room.players.length === 0) {
      rooms.delete(room.id);
    } else {
      room.turn %= room.players.length;
      sendState(room);
    }
  });
});

/* =========================
   SEND STATE (AUTHORITATIVE)
========================= */

function sendState(room) {
  const base = buildState(room);
  for (const p of room.players) {
    p.ws.send(JSON.stringify({
      type: "state",
      state: { ...base, you: p.id }
    }));
  }
}

/* =========================
   START SERVER
========================= */

server.listen(PORT, () => {
  console.log("Old Skool Blackjack server running on", PORT);
});
