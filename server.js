const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// code -> { code, hostId, clients: Map(ws -> { wsId, name, seat }), state, version }
const rooms = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of room.clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function roomPlayers(room) {
  const arr = [];
  for (const info of room.clients.values()) {
    arr.push({ name: info.name, seat: info.seat, isHost: info.wsId === room.hostId });
  }
  arr.sort((a, b) => a.seat - b.seat);
  return arr;
}

function hostSeat(room) {
  for (const info of room.clients.values()) {
    if (info.wsId === room.hostId) return info.seat;
  }
  return 0;
}

function wsById(room, wsId) {
  for (const [ws, info] of room.clients.entries()) {
    if (info.wsId === wsId) return ws;
  }
  return null;
}

function wsBySeat(room, seat) {
  for (const [ws, info] of room.clients.entries()) {
    if (info.seat === seat) return ws;
  }
  return null;
}

function smallestFreeSeat(room) {
  const used = new Set([...room.clients.values()].map(v => v.seat));
  let seat = 0;
  while (used.has(seat)) seat++;
  return seat;
}

function leaveRoom(ws, silent = false) {
  const code = ws._room;
  if (!code) return;

  const room = rooms.get(code);
  ws._room = null;
  ws._seat = null;

  if (!room) return;
  const leavingInfo = room.clients.get(ws);
  room.clients.delete(ws);

  // If host left, pick new host = lowest seat remaining
  if (leavingInfo && leavingInfo.wsId === room.hostId) {
    const remaining = [...room.clients.values()].sort((a, b) => a.seat - b.seat);
    if (remaining.length) room.hostId = remaining[0].wsId;
  }

  if (room.clients.size === 0) {
    rooms.delete(code);
    return;
  }

  const players = roomPlayers(room);
  const hSeat = hostSeat(room);

  if (!silent) broadcast(room, { type: "toast", message: `${leavingInfo?.name || "A player"} left.` });
  broadcast(room, { type: "players", hostSeat: hSeat, players });
}

let wsCounter = 1;

wss.on("connection", (ws) => {
  ws._id = wsCounter++;
  ws._room = null;
  ws._seat = null;

  send(ws, { type: "hello", wsId: ws._id });

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || !msg.type) return;

    // --- LOBBY ---
    if (msg.type === "create_room") {
      if (ws._room) leaveRoom(ws, true);

      let requested = (msg.room || "").toString().trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(requested)) requested = "";

      let code = requested && !rooms.has(requested) ? requested : null;
      if (!code) {
        do { code = makeCode(6); } while (rooms.has(code));
      }

      const room = {
        code,
        hostId: ws._id,
        clients: new Map(),
        state: null,
        version: 0,
      };
      rooms.set(code, room);

      const name = (msg.name || "Host").toString().slice(0, 16);
      ws._room = code;
      ws._seat = 0;

      room.clients.set(ws, { wsId: ws._id, name, seat: 0 });

      send(ws, {
        type: "room_created",
        room: code,
        seat: 0,
        hostSeat: 0,
        players: roomPlayers(room),
      });

      broadcast(room, { type: "players", hostSeat: 0, players: roomPlayers(room) });
      broadcast(room, { type: "update", message: "Room created. Waiting for players..." });
      return;
    }

    if (msg.type === "join_room") {
      if (ws._room) leaveRoom(ws, true);

      const code = (msg.room || "").toString().trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: "toast", message: "Room not found." });

      const seat = smallestFreeSeat(room);
      const name = (msg.name || "Player").toString().slice(0, 16);

      ws._room = code;
      ws._seat = seat;

      room.clients.set(ws, { wsId: ws._id, name, seat });

      const players = roomPlayers(room);
      const hSeat = hostSeat(room);

      send(ws, { type: "joined", room: code, seat, hostSeat: hSeat, players });
      broadcast(room, { type: "players", hostSeat: hSeat, players });

      broadcast(room, { type: "toast", message: `${name} joined.` });

      // Tell joining player what's going on
      if (room.state) {
        send(ws, { type: "state", version: room.version, snap: room.state });
        send(ws, { type: "update", message: "Synced game state. You're in!" });
      } else {
        send(ws, { type: "update", message: "Joined room. Waiting for host to start the game..." });
      }
      return;
    }

    if (msg.type === "leave_room") {
      leaveRoom(ws);
      return;
    }

    // From here on: must be in a room
    const code = ws._room;
    if (!code) return send(ws, { type: "toast", message: "Not in a room." });

    const room = rooms.get(code);
    if (!room) {
      ws._room = null;
      ws._seat = null;
      return;
    }

    // --- AUTHORITATIVE STATE (host only) ---
    if (msg.type === "state") {
      if (ws._id !== room.hostId) return;

      const incomingVersion = Number(msg.version);
      room.version = Number.isFinite(incomingVersion) ? incomingVersion : (room.version + 1);
      room.state = msg.snap;

      broadcast(room, { type: "state", version: room.version, snap: room.state });
      return;
    }

    // --- ACTIONS (clients -> host) ---
    if (msg.type === "action") {
      const hostWs = wsById(room, room.hostId);
      if (!hostWs) return send(ws, { type: "toast", message: "Host disconnected." });

      const action = msg.action || {};
      action.seat = ws._seat;

      send(hostWs, { type: "to_host_action", action });
      return;
    }

    // --- ACE PROMPT (host -> specific seat) ---
    // Optional: use if your client wants server-routed prompts
    if (msg.type === "ace_prompt") {
      if (ws._id !== room.hostId) return;

      const seat = Number(msg.seat);
      const target = wsBySeat(room, seat);
      if (!target) return;

      send(target, { type: "ace_prompt", seat });
      return;
    }

    // --- CHAT (any -> room) ---
    if (msg.type === "chat") {
      const text = (msg.text || "").toString().slice(0, 200);
      const emoji = (msg.emoji || "").toString().slice(0, 10);
      if (!text && !emoji) return;

      const sender = room.clients.get(ws)?.name || "Player";
      broadcast(room, {
        type: "chat",
        from: sender,
        seat: ws._seat,
        text,
        emoji,
        ts: Date.now(),
      });
      return;
    }

    // Unknown type -> ignore
  });

  ws.on("close", () => leaveRoom(ws, true));
});

server.listen(PORT, () => console.log("Listening on", PORT));
