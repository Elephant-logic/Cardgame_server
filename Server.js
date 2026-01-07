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
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/*
 room = {
   code,
   host,          // ws id
   clients: Map(ws -> { wsId, name, seat }),
   state,
   version
 }
*/
const rooms = new Map();
let wsCounter = 1;

function roomPlayers(room) {
  const arr = [];
  for (const [, info] of room.clients) {
    arr.push({
      name: info.name,
      seat: info.seat,
      isHost: room.host === info.wsId,
    });
  }
  arr.sort((a, b) => a.seat - b.seat);
  return arr;
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of room.clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function systemMessage(room, text) {
  broadcast(room, {
    type: "chat",
    name: "SYSTEM",
    text,
    system: true,
  });
}

function leaveRoom(ws, silent = false) {
  const code = ws._room;
  if (!code) return;

  const room = rooms.get(code);
  ws._room = null;
  ws._seat = null;

  if (!room) return;

  const info = room.clients.get(ws);
  const leaverName = info?.name || "A player";
  room.clients.delete(ws);

  if (!silent && info) {
    systemMessage(room, `${info.name} left the room`);
  }

  // Host left → promote lowest seat
  if (room.host === ws._id) {
    const remaining = [...room.clients.values()].sort((a, b) => a.seat - b.seat);
    if (remaining.length) {
      room.host = remaining[0].wsId;
      systemMessage(room, `${remaining[0].name} is now host`);
    }
  }

  if (room.clients.size === 0) {
    rooms.delete(code);
    return;
  }

  const hostSeat =
    [...room.clients.values()].find(v => v.wsId === room.host)?.seat ?? 0;

  broadcast(room, {
    type: "players",
    hostSeat,
    players: roomPlayers(room),
  });
}

wss.on("connection", (ws) => {
  ws._id = wsCounter++;
  ws._room = null;
  ws._seat = null;

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (!msg || !msg.type) return;

    /* ================= CREATE ROOM ================= */
    if (msg.type === "create_room") {
      if (ws._room) leaveRoom(ws);

      let code;
      let requested = (msg.room || "").toUpperCase().trim();

      if (/^[A-Z0-9]{4,8}$/.test(requested) && !rooms.has(requested)) {
        code = requested;
      } else {
        do {
          code = makeCode(6);
        } while (rooms.has(code));
      }

      const room = {
        code,
        host: ws._id,
        clients: new Map(),
        state: null,
        version: 0,
      };

      rooms.set(code, room);

      const name = (msg.name || "Host").slice(0, 16);
      ws._room = code;
      ws._seat = 0;

      room.clients.set(ws, {
        wsId: ws._id,
        name,
        seat: 0,
      });

      send(ws, {
        type: "room_created",
        room: code,
        seat: 0,
        hostSeat: 0,
        players: roomPlayers(room),
      });

      systemMessage(room, `${name} created the room`);

      broadcast(room, {
        type: "players",
        hostSeat: 0,
        players: roomPlayers(room),
      });
      return;
    }

    /* ================= JOIN ROOM ================= */
    if (msg.type === "join_room") {
      if (ws._room) leaveRoom(ws);

      const code = (msg.room || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: "toast", message: "Room not found" });
        return;
      }

      const usedSeats = new Set([...room.clients.values()].map(v => v.seat));
      let seat = 0;
      while (usedSeats.has(seat)) seat++;

      const name = (msg.name || "Player").slice(0, 16);

      ws._room = code;
      ws._seat = seat;

      room.clients.set(ws, {
        wsId: ws._id,
        name,
        seat,
      });

      const hostSeat =
        [...room.clients.values()].find(v => v.wsId === room.host)?.seat ?? 0;

      send(ws, {
        type: "joined",
        room: code,
        seat,
        hostSeat,
        players: roomPlayers(room),
      });

      systemMessage(room, `${name} joined the room`);

      broadcast(room, {
        type: "players",
        hostSeat,
        players: roomPlayers(room),
      });

      if (room.state) {
        send(ws, {
          type: "state",
          version: room.version,
          snap: room.state,
        });
      }
      return;
    }

    /* ================= LEAVE ================= */
    if (msg.type === "leave_room") {
      leaveRoom(ws);
      return;
    }

    /* ================= MUST BE IN ROOM ================= */
    const room = rooms.get(ws._room);
    if (!room) return;

    /* ================= CHAT ================= */
    if (msg.type === "chat") {
      const info = room.clients.get(ws);
      if (!info) return;

      broadcast(room, {
        type: "chat",
        name: info.name,
        text: (msg.text || "").slice(0, 200),
      });
      return;
    }

    /* ================= GAME STATE ================= */
    if (msg.type === "state") {
      if (ws._id !== room.host) return;

      room.version = Number(msg.version || room.version + 1);
      room.state = msg.snap;

      broadcast(room, {
        type: "state",
        version: room.version,
        snap: room.state,
      });
      return;
    }

    /* ================= ACTION ================= */
    
    if (msg.type === "chat") {
      const info = room.clients.get(ws);
      const from = (info?.name || msg.from || "Player").toString().slice(0,16);
      const text = (msg.message || msg.text || "").toString().trim().slice(0,200);
      if (!text) return;
      broadcast(room, { type: "chat", from, message: text, ts: Date.now() });
      return;
    }

if (msg.type === "action") {
      const hostWs = [...room.clients.keys()].find(w => w._id === room.host);
      if (!hostWs) return;

      const action = msg.action || {};
      action.seat = ws._seat;

      send(hostWs, {
        type: "to_host_action",
        action,
      });
      return;
    }
  });

  ws.on("close", () => leaveRoom(ws, true));
});

server.listen(PORT, () =>
  console.log("✅ Server running on port", PORT)
);
      // helpful status for the joining player
      if (!room.state) {
        send(ws, { type: "toast", message: "Joined room. Waiting for the host to start the game." });
      } else {
        send(ws, { type: "toast", message: "Joined room. Game is already in progress." });
      }

      systemMessage(room, `${name} created the room.`);
      systemMessage(room, `$lastToastMsg joined.`);

