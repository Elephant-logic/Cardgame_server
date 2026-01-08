const path = require("path");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const app = express();

// Serve static client
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

// --- STATS STATE --------------------------------------------------

const rooms = new Map(); // code -> { code, hostId, clients: Map(ws -> {id,name,seat}), state, version }

let totalConnections = 0;        // how many ws connections have ever been opened
let messagesThisMinute = 0;      // reset every 60s
let messagesPerMinute = 0;       // last complete minute count

// roll messages-per-minute every 60s
setInterval(() => {
  messagesPerMinute = messagesThisMinute;
  messagesThisMinute = 0;
}, 60 * 1000);

// Small helper to grab memory stats safely
function getMemoryMB() {
  const mu = process.memoryUsage();
  const toMB = (v) => Math.round((v / 1024 / 1024) * 10) / 10;
  return {
    rss: toMB(mu.rss),
    heapTotal: toMB(mu.heapTotal),
    heapUsed: toMB(mu.heapUsed),
    external: toMB(mu.external || 0)
  };
}

// Simple stats logger for your Render logs
function logStats() {
  console.log(
    `[STATS] uptime=${Math.round(process.uptime())}s ` +
    `rooms=${rooms.size} ` +
    `activeSockets=${wss.clients.size} ` +
    `totalConnections=${totalConnections} ` +
    `mpm=${messagesPerMinute}`
  );
}

// --- HTTP STATS/ROOM ROUTES --------------------------------------

// Raw JSON stats (you already tested this)
app.get("/stats", (req, res) => {
  res.json({
    uptimeSeconds: Math.round(process.uptime()),
    rooms: rooms.size,
    totalConnections,
    activeSockets: wss.clients.size,
    messagesPerMinute,
    memoryMB: getMemoryMB()
  });
});

// List of rooms + players (for you, not public UI)
app.get("/rooms", (req, res) => {
  const allRooms = [];
  for (const [code, room] of rooms.entries()) {
    const players = [];
    for (const [ws, info] of room.clients.entries()) {
      players.push({
        name: info.name,
        seat: info.seat,
        isHost: room.hostId === info.id,
        connected: ws.readyState === WebSocket.OPEN
      });
    }
    players.sort((a, b) => a.seat - b.seat);
    allRooms.push({
      code,
      playerCount: players.length,
      players
    });
  }
  res.json({
    uptimeSeconds: Math.round(process.uptime()),
    rooms: allRooms.length,
    data: allRooms
  });
});

// Simple live dashboard page (HTML) polling /stats + /rooms
app.get("/stats/live", (req, res) => {
  res.type("html").send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Old Skool Blackjack – Live Stats</title>
  <style>
    body {
      background:#050608;
      color:#eee;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin:0;
      padding:16px;
    }
    h1 { margin-top:0; font-size:20px; }
    pre {
      background:#111;
      padding:12px;
      border-radius:8px;
      overflow:auto;
      max-height:45vh;
      font-size:12px;
    }
    .grid {
      display:grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap:16px;
    }
    .card {
      background:#111;
      border-radius:10px;
      padding:12px;
      box-shadow:0 0 0 1px rgba(255,255,255,0.05);
    }
    .pill {
      display:inline-block;
      padding:2px 8px;
      border-radius:999px;
      font-size:11px;
      background:#222;
      margin-right:4px;
    }
    .ok { color:#7CFC00; }
    .warn { color:#ffd54f; }
    .bad { color:#ff5252; }
  </style>
</head>
<body>
  <h1>Old Skool Blackjack – Live Server Stats</h1>
  <div class="grid">
    <div class="card">
      <h2>Stats</h2>
      <div id="summary">Loading…</div>
      <pre id="statsPre"></pre>
    </div>
    <div class="card">
      <h2>Rooms</h2>
      <pre id="roomsPre">Loading…</pre>
    </div>
  </div>
  <script>
    async function fetchJson(path) {
      try {
        const res = await fetch(path + "?t=" + Date.now());
        if (!res.ok) throw new Error(res.status);
        return await res.json();
      } catch (e) {
        console.error("Fetch error", path, e);
        return null;
      }
    }

    function fmt(num) { return typeof num === "number" ? num.toString() : "-"; }

    async function tick() {
      const [stats, rooms] = await Promise.all([
        fetchJson("/stats"),
        fetchJson("/rooms")
      ]);

      const summaryEl = document.getElementById("summary");
      const statsPre = document.getElementById("statsPre");
      const roomsPre = document.getElementById("roomsPre");

      if (stats) {
        const cls =
          stats.activeSockets > 40 ? "bad" :
          stats.activeSockets > 15 ? "warn" : "ok";

        summaryEl.innerHTML =
          '<span class="pill ' + cls + '">Sockets: ' + fmt(stats.activeSockets) + '</span>' +
          '<span class="pill">Rooms: ' + fmt(stats.rooms) + '</span>' +
          '<span class="pill">MPM: ' + fmt(stats.messagesPerMinute) + '</span>' +
          '<span class="pill">Uptime: ' + fmt(stats.uptimeSeconds) + 's</span>';

        statsPre.textContent = JSON.stringify(stats, null, 2);
      } else {
        summaryEl.textContent = "Error fetching /stats";
      }

      if (rooms) {
        roomsPre.textContent = JSON.stringify(rooms, null, 2);
      } else {
        roomsPre.textContent = "Error fetching /rooms";
      }
    }

    tick();
    setInterval(tick, 2000);
  </script>
</body>
</html>
  `);
});

// --- WEBSOCKET SETUP ---------------------------------------------

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function makeCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

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

  totalConnections++;
  logStats();

  ws.on("message", (data) => {
    messagesThisMinute++;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || !msg.type) return;

    // Create room
    if (msg.type === "create_room") {
      leaveRoom(ws, true);

      let code;
      let requested = (msg.room || "").toString().trim().toUpperCase();
      if (!/^[A-Z0-9]{4,8}$/.test(requested)) requested = "";
      if (requested && !rooms.has(requested)) code = requested;
      else {
        do {
          code = makeCode(6);
        } while (rooms.has(code));
      }

      const room = { code, hostId: ws._id, clients: new Map(), state: null, version: 0 };
      rooms.set(code, room);

      const name = (msg.name || "Host").toString().slice(0, 16);
      ws._room = code;
      ws._seat = 0;
      room.clients.set(ws, { id: ws._id, name, seat: 0 });

      send(ws, { type: "room_created", room: code, seat: 0, hostSeat: 0, players: roomPlayers(room) });
      broadcast(room, { type: "players", hostSeat: 0, players: roomPlayers(room) });
      broadcast(room, { type: "toast", message: `${name} created room ${code}` });

      logStats();
      return;
    }

    // Join room
    if (msg.type === "join_room") {
      leaveRoom(ws, true);

      const code = (msg.room || "").toString().trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: "toast", message: "Room not found." });

      const used = new Set([...room.clients.values()].map((v) => v.seat));
      let seat = 0;
      while (used.has(seat)) seat++;

      const name = (msg.name || "Player").toString().slice(0, 16);
      ws._room = code;
      ws._seat = seat;
      room.clients.set(ws, { id: ws._id, name, seat });

      const hostSeat = [...room.clients.values()].find((v) => v.id === room.hostId)?.seat ?? 0;

      send(ws, { type: "joined", room: code, seat, hostSeat, players: roomPlayers(room) });
      broadcast(room, { type: "players", hostSeat, players: roomPlayers(room) });
      broadcast(room, { type: "toast", message: `${name} joined room ${code}` });

      if (room.state) {
        send(ws, { type: "state", version: room.version, snap: room.state });
      }

      logStats();
      return;
    }

    if (msg.type === "leave_room") {
      leaveRoom(ws, false);
      logStats();
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
      room.version = Number.isFinite(msg.version) ? msg.version : room.version + 1;
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
    const hostWs = [...room.clients.keys()].find((w) => w._id === room.hostId);
    if (!hostWs) return send(ws, { type: "toast", message: "Host disconnected." });

    if (msg.type === "action") {
      const action = msg.action || {};
      action.seat = ws._seat;
      send(hostWs, { type: "to_host_action", action });
      return;
    }

    // Fallback: forward unknown messages to host
    send(hostWs, { type: "to_host_misc", fromSeat: ws._seat, msg });
  });

  ws.on("close", () => {
    leaveRoom(ws, true);
    logStats();
  });
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

  const hostSeat = [...room.clients.values()].find((v) => v.id === room.hostId)?.seat ?? 0;
  broadcast(room, { type: "players", hostSeat, players: roomPlayers(room) });

  if (!silent && info?.name) {
    broadcast(room, { type: "toast", message: `${info.name} left the room.` });
  }
}

server.listen(PORT, () => {
  console.log("Listening on", PORT);
  logStats();
});
