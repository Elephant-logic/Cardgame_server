import WebSocket, { WebSocketServer } from "ws";
import { createGame, handleAction } from "./gameEngine.js";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 3000;
const wss = new WebSocketServer({ port: PORT });

const clients = new Map(); // ws -> { name, room }
const rooms = new Map();   // id -> room

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function broadcastLobby() {
  const lobby = [...rooms.values()]
    .filter(r => !r.started)
    .map(r => ({ id: r.id, players: r.players.length, max: 4 }));

  clients.forEach((_, ws) => send(ws, { type: "lobby", rooms: lobby }));
}

function sendRoom(room) {
  room.players.forEach(p =>
    send(p.ws, {
      type: "room",
      id: room.id,
      players: room.players.map(x => x.name),
      started: room.started
    })
  );
}

function sendGame(room) {
  room.players.forEach(p =>
    send(p.ws, {
      type: "game",
      state: room.game.publicState()
    })
  );
}

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.players.length === 0 && now - room.emptyAt > 60000) {
      rooms.delete(id);
    }
  }
  broadcastLobby();
}, 5000);

wss.on("connection", ws => {
  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    let client = clients.get(ws);

    // LOGIN
    if (msg.type === "hello") {
      clients.set(ws, { ws, name: msg.name, room: null });
      broadcastLobby();
      return;
    }

    if (!client) return;

    // CREATE ROOM
    if (msg.type === "create") {
      const room = {
        id: randomUUID().slice(0, 6),
        players: [],
        started: false,
        game: null,
        emptyAt: Date.now()
      };
      rooms.set(room.id, room);
      broadcastLobby();
      return;
    }

    // JOIN ROOM
    if (msg.type === "join") {
      const room = rooms.get(msg.id);
      if (!room || room.players.length >= 4) return;

      room.players.push(client);
      client.room = room;
      sendRoom(room);
      broadcastLobby();
      return;
    }

    // START GAME
    if (msg.type === "start") {
      const room = client.room;
      if (!room || room.started || room.players.length < 2) return;

      room.started = true;
      room.game = createGame(room.players.map(p => p.name));
      sendGame(room);
      return;
    }

    // GAME ACTION
    if (msg.type === "action") {
      const room = client.room;
      if (!room || !room.game) return;

      const result = handleAction(room.game, client.name, msg.action);
      if (result?.error) send(ws, { type: "error", error: result.error });
      else sendGame(room);
    }
  });

  ws.on("close", () => {
    const c = clients.get(ws);
    if (!c) return;

    if (c.room) {
      c.room.players = c.room.players.filter(p => p !== c);
      c.room.emptyAt = Date.now();
      sendRoom(c.room);
    }

    clients.delete(ws);
    broadcastLobby();
  });
});

console.log("Old Skool Blackjack server running on", PORT);
