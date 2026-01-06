// Old Skool Blackjack - Online Relay Server (Render-friendly)
// Host client is authoritative and broadcasts full state snapshots.
// Other clients send input actions; server relays within the room.

const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const app = express();
const server = http.createServer(app);

// Serve static files (index.html)
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const wss = new WebSocket.Server({ server, path: "/ws" });

/** rooms: code -> { host: ws, hostName: string, clients: Set<ws>, names: Map<ws,string> } */
const rooms = new Map();

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function safeSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function broadcast(room, fromWs, obj) {
  for (const c of room.clients) {
    if (c !== fromWs && c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify(obj));
    }
  }
}

function cleanupWs(ws) {
  // Find any room containing this ws
  for (const [code, room] of rooms.entries()) {
    if (!room.clients.has(ws)) continue;

    const wasHost = (room.host === ws);
    room.clients.delete(ws);
    room.names.delete(ws);

    if (wasHost) {
      // End room, notify others
      broadcast(room, ws, { type: "peer_left" });
      rooms.delete(code);
      return;
    } else {
      // Notify host
      safeSend(room.host, { type: "peer_left" });
      // Keep room alive for reconnection (optional)
      return;
    }
  }
}

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Room management
    if (msg.type === "create") {
      const name = String(msg.name || "Player 1").slice(0, 20);
      let code = makeCode();
      while (rooms.has(code)) code = makeCode();

      const room = {
        code,
        host: ws,
        hostName: name,
        clients: new Set([ws]),
        names: new Map([[ws, name]])
      };
      rooms.set(code, room);

      safeSend(ws, { type: "created", roomCode: code, playerIndex: 0, hostName: name });
      return;
    }

    if (msg.type === "join") {
      const code = String(msg.roomCode || "").toUpperCase();
      const name = String(msg.name || "Player 2").slice(0, 20);
      const room = rooms.get(code);

      if (!room) {
        safeSend(ws, { type: "error", message: "Room not found" });
        return;
      }
      if (room.clients.size >= 2) {
        safeSend(ws, { type: "error", message: "Room full" });
        return;
      }

      room.clients.add(ws);
      room.names.set(ws, name);

      safeSend(ws, { type: "joined", roomCode: code, playerIndex: 1, hostName: room.hostName });
      safeSend(room.host, { type: "peer_joined", name, playerIndex: 1 });

      // Tell joiner who host is (for UI if needed)
      safeSend(ws, { type: "peer_joined", name: room.hostName, playerIndex: 0 });
      return;
    }

    // Relay game messages within room
    // Determine room by membership
    let roomFound = null;
    for (const room of rooms.values()) {
      if (room.clients.has(ws)) { roomFound = room; break; }
    }
    if (!roomFound) return;

    // Only allow host to broadcast "state" (authoritative snapshot)
    if (msg.type === "state" && ws !== roomFound.host) return;

    // Otherwise relay to everyone else in room
    broadcast(roomFound, ws, msg);
  });

  ws.on("close", () => cleanupWs(ws));
  ws.on("error", () => cleanupWs(ws));
});

server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
