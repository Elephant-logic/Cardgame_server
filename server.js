const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const rooms = new Map(); // code -> { code, hostId, clients: Map(ws -> {id,name,seat}), state, version }

function roomPlayers(room) {
  const arr = [];
  for (const [ws, info] of room.clients) {
    arr.push({ name: info.name, seat: info.seat, isHost: room.hostId === info.id });
  }
  arr.sort((a, b) => a.seat - b.seat);
  return arr;
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const [ws] of room.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function getRoom(ws) {
  if (!ws._room) return null;
  return rooms.get(ws._room) || null;
}

let wsCounter = 1;

wss.on("connection", (ws) => {
  ws._id = wsCounter++;
  ws._room = null;
  ws._seat = null;

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || !msg.type) return;

    // Create room
    if (msg.type === "create_room") {
      leaveRoom(ws, true);

      let code;
      let requested = (msg.room || "").toString().trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(requested)) requested = "";
      if (requested && !rooms.has(requested)) code = requested;
      else { do { code = makeCode(6); } while (rooms.has(code)); }

      const room = { code, hostId: ws._id, clients: new Map(), state: null, version: 0 };
      rooms.set(code, room);

      const name = (msg.name || "Host").toString().slice(0, 16);
      ws._room = code;
      ws._seat = 0;
      room.clients.set(ws, { id: ws._id, name, seat: 0 });

      send(ws, { type: "room_created", room: code, seat: 0, hostSeat: 0, players: roomPlayers(room) });
      broadcast(room, { type: "players", hostSeat: 0, players: roomPlayers(room) });
      broadcast(room, { type: "toast", message: `${name} created room ${code}` });
      return;
    }

    // Join room
    if (msg.type === "join_room") {
      leaveRoom(ws, true);

      const code = (msg.room || "").toString().trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: "toast", message: "Room not found." });

      const used = new Set([...room.clients.values()].map(v => v.seat));
      let seat = 0;
      while (used.has(seat)) seat++;

      const name = (msg.name || "Player").toString().slice(0, 16);
      ws._room = code;
      ws._seat = seat;
      room.clients.set(ws, { id: ws._id, name, seat });

      const hostSeat = [...room.clients.values()].find(v => v.id === room.hostId)?.seat ?? 0;

      send(ws, { type: "joined", room: code, seat, hostSeat, players: roomPlayers(room) });
      broadcast(room, { type: "players", hostSeat, players: roomPlayers(room) });
      broadcast(room, { type: "toast", message: `${name} joined room ${code}` });

      if (room.state) send(ws, { type: "state", version: room.version, snap: room.state });
      return;
    }

    if (msg.type === "leave_room") {
      leaveRoom(ws, false);
      return;
    }

    if (msg.type === "ping") {
      send(ws, { type: "pong", t: Date.now() });
      return;
    }

    const room = getRoom(ws);
    if (!room) return send(ws, { type: "toast", message: "Not in a room." });

    // Host authoritative state
    if (msg.type === "state") {
      if (ws._id !== room.hostId) return;
      room.version = Number.isFinite(msg.version) ? msg.version : (room.version + 1);
      room.state = msg.snap;
      broadcast(room, { type: "state", version: room.version, snap: room.state });
      return;
    }

    // Chat broadcast
    if (msg.type === "chat") {
      const from = (msg.from || room.clients.get(ws)?.name || "Player").toString().slice(0, 16);
      const message = (msg.message || "").toString().slice(0, 200);
      broadcast(room, { type: "chat", from, seat: ws._seat, message, t: Date.now() });
      return;
    }

    // Anything else -> forward to host as an action
    const hostWs = [...room.clients.keys()].find(w => w._id === room.hostId);
    if (!hostWs) return send(ws, { type: "toast", message: "Host disconnected." });

    // Preserve existing client contract: msg.type === "action"
    if (msg.type === "action") {
      const action = msg.action || {};
      action.seat = ws._seat;
      send(hostWs, { type: "to_host_action", action });
      return;
    }

    // Fallback: forward unknown messages to host
    send(hostWs, { type: "to_host_misc", fromSeat: ws._seat, msg });
  });

  ws.on("close", () => leaveRoom(ws, true));
});

function leaveRoom(ws, silent = false) {
  const code = ws._room;
  if (!code) return;
  const room = rooms.get(code);

  ws._room = null;
  ws._seat = null;
  if (!room) return;

  const info = room.clients.get(ws);
  room.clients.delete(ws);

  if (room.clients.size === 0) {
    rooms.delete(code);
    return;
  }

  // If host left, pick new host (lowest seat)
  if (room.hostId === ws._id) {
    const remaining = [...room.clients.values()].sort((a, b) => a.seat - b.seat);
    room.hostId = remaining[0].id;
  }

  const hostSeat = [...room.clients.values()].find(v => v.id === room.hostId)?.seat ?? 0;
  broadcast(room, { type: "players", hostSeat, players: roomPlayers(room) });

  if (!silent && info?.name) {
    broadcast(room, { type: "toast", message: `${info.name} left the room.` });
  }
}

server.listen(PORT, () => console.log("Listening on", PORT));
