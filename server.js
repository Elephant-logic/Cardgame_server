'use strict';

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

/**
 * Room model (NO game rules here):
 * - host is the only one allowed to broadcast authoritative "state"
 * - others send "action" to host via server relay
 */
const rooms = new Map(); // roomCode -> room

function makeRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 chars
}

function now() { return Date.now(); }

function getOrCreateRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      createdAt: now(),
      clients: new Map(), // ws -> {id,name,isHost,lastSeen}
      hostId: null,
      lastState: null,    // latest state snapshot (from host)
    };
    rooms.set(code, room);
  }
  return room;
}

function pruneEmptyRooms() {
  for (const [code, room] of rooms.entries()) {
    if (room.clients.size === 0) rooms.delete(code);
  }
}

function roomRoster(room) {
  const players = [];
  for (const meta of room.clients.values()) {
    players.push({ id: meta.id, name: meta.name, isHost: meta.id === room.hostId });
  }
  return players;
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptWs = null) {
  const payload = JSON.stringify(obj);
  for (const ws of room.clients.keys()) {
    if (ws !== exceptWs && ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

function pickHost(room) {
  // Keep existing host if still present
  if (room.hostId && [...room.clients.values()].some(m => m.id === room.hostId)) return;

  // Else pick the oldest connected
  const first = room.clients.values().next().value;
  room.hostId = first ? first.id : null;
}

function findRoomByWs(ws) {
  return ws._roomCode ? rooms.get(ws._roomCode) : null;
}

// Heartbeat
function heartbeat() { this.isAlive = true; }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // JOIN
    if (msg.type === 'join') {
      const code = String(msg.room || '').toUpperCase().trim();
      const name = String(msg.name || 'Player').slice(0, 20);

      if (!code) {
        send(ws, { type: 'error', message: 'Missing room code' });
        return;
      }

      const room = getOrCreateRoom(code);

      const id = crypto.randomBytes(6).toString('hex');
      room.clients.set(ws, { id, name, lastSeen: now() });
      ws._roomCode = code;
      ws._id = id;

      pickHost(room);

      send(ws, { type: 'joined', room: code, id, hostId: room.hostId, roster: roomRoster(room) });
      broadcast(room, { type: 'roster', roster: roomRoster(room), hostId: room.hostId }, ws);

      // If we have a last known state from host, give it to the joiner so they instantly see the table
      if (room.lastState) {
        send(ws, { type: 'state', state: room.lastState, from: 'server-cache' });
      }
      return;
    }

    const room = findRoomByWs(ws);
    if (!room) {
      send(ws, { type: 'error', message: 'Not in a room' });
      return;
    }

    const meta = room.clients.get(ws);
    if (!meta) return;
    meta.lastSeen = now();

    // CREATE ROOM (optional helper)
    if (msg.type === 'createRoom') {
      const code = makeRoomCode();
      send(ws, { type: 'roomCreated', room: code });
      return;
    }

    // AUTHORITATIVE STATE: only host may publish
    if (msg.type === 'state') {
      if (meta.id !== room.hostId) {
        send(ws, { type: 'error', message: 'Only host can publish state' });
        return;
      }
      room.lastState = msg.state;
      broadcast(room, { type: 'state', state: msg.state, from: meta.id }, ws);
      return;
    }

    // ACTIONS: non-host sends to host (and optionally others for UI hints)
    if (msg.type === 'action') {
      // Always send to host
      const hostWs = [...room.clients.entries()].find(([, m]) => m.id === room.hostId)?.[0];
      if (hostWs && hostWs.readyState === WebSocket.OPEN) {
        send(hostWs, { type: 'action', action: msg.action, from: meta.id, name: meta.name });
      } else {
        send(ws, { type: 'error', message: 'Host not available' });
      }
      return;
    }

    // Simple chat / debug passthrough
    if (msg.type === 'chat') {
      broadcast(room, { type: 'chat', from: meta.name, text: String(msg.text || '').slice(0, 400) });
      return;
    }
  });

  ws.on('close', () => {
    const room = findRoomByWs(ws);
    if (!room) return;

    room.clients.delete(ws);
    pickHost(room);

    broadcast(room, { type: 'roster', roster: roomRoster(room), hostId: room.hostId });
    pruneEmptyRooms();
  });
});

// Ping loop
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
  console.log('✅ Server live on', PORT);
});
