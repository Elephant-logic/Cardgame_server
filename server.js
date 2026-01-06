
const path = require("path");
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 10000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req,res)=>res.json({ok:true}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/**
 * Rooms:
 *  roomCode -> { hostId, players: Map(clientId -> {id,name,isHost}), sockets: Map(clientId -> ws) }
 */
const rooms = new Map();

function mkCode(len=6){
  const chars="ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s="";
  for(let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function safeSend(ws, obj){
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function broadcastRoom(roomCode){
  const room = rooms.get(roomCode);
  if(!room) return;
  const players = Array.from(room.players.values()).map(p=>({id:p.id,name:p.name,isHost:p.isHost}));
  for(const [cid, ws] of room.sockets.entries()){
    safeSend(ws, { t:"roomUpdate", roomCode, isHost: cid === room.hostId, players });
  }
}

function leaveRoom(clientId){
  // find room containing client
  for(const [code, room] of rooms.entries()){
    if(room.players.has(clientId)){
      room.players.delete(clientId);
      room.sockets.delete(clientId);

      // if host left, promote first remaining player
      if(room.hostId === clientId){
        const first = room.players.values().next().value;
        room.hostId = first ? first.id : null;
        if(first) first.isHost = true;
      }
      // update host flag for others
      for(const p of room.players.values()) p.isHost = (p.id === room.hostId);

      if(room.players.size === 0){
        rooms.delete(code);
      } else {
        broadcastRoom(code);
      }
      return;
    }
  }
}

wss.on("connection", (ws) => {
  const clientId = mkCode(10);
  let currentName = "Player";

  safeSend(ws, { t:"hello", clientId });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }
    if(!msg || !msg.t) return;

    if(msg.t === "setName"){
      const nm = (msg.name || "").toString().trim().slice(0,16);
      if(nm) currentName = nm;
      return;
    }

    if(msg.t === "createRoom"){
      // leave existing
      leaveRoom(clientId);

      const nm = (msg.name || currentName).toString().trim().slice(0,16) || "Player";
      currentName = nm;

      let code;
      do { code = mkCode(6); } while(rooms.has(code));

      const room = {
        hostId: clientId,
        players: new Map(),
        sockets: new Map(),
      };
      room.players.set(clientId, { id: clientId, name: nm, isHost: true });
      room.sockets.set(clientId, ws);
      rooms.set(code, room);
      broadcastRoom(code);
      return;
    }

    if(msg.t === "joinRoom"){
      const code = (msg.roomCode || "").toString().trim().toUpperCase();
      const room = rooms.get(code);
      if(!room){
        return safeSend(ws, { t:"roomError", message:"Room not found" });
      }
      // leave current
      leaveRoom(clientId);

      const nm = (msg.name || currentName).toString().trim().slice(0,16) || "Player";
      currentName = nm;

      room.players.set(clientId, { id: clientId, name: nm, isHost:false });
      room.sockets.set(clientId, ws);
      // ensure host flag
      for(const p of room.players.values()) p.isHost = (p.id === room.hostId);
      broadcastRoom(code);
      return;
    }

    if(msg.t === "leaveRoom"){
      leaveRoom(clientId);
      return;
    }

    // Relay: host -> everyone, or guest -> host
    if(msg.t === "startMatch"){
      // broadcast to everyone in room
      const code = findClientRoom(clientId);
      if(!code) return;
      const room = rooms.get(code);
      if(!room) return;
      if(room.hostId !== clientId) return; // only host
      for(const ws2 of room.sockets.values()){
        safeSend(ws2, { t:"startMatch" });
      }
      return;
    }

    if(msg.t === "hostAction"){
      const code = findClientRoom(clientId);
      if(!code) return;
      const room = rooms.get(code);
      if(!room) return;
      if(room.hostId !== clientId) return; // only host can send
      for(const [cid, ws2] of room.sockets.entries()){
        if(cid === clientId) continue;
        safeSend(ws2, { t:"hostAction", state: msg.state });
      }
      return;
    }

    if(msg.t === "inputRequest"){
      const code = findClientRoom(clientId);
      if(!code) return;
      const room = rooms.get(code);
      if(!room) return;
      const hostWs = room.sockets.get(room.hostId);
      if(!hostWs) return;
      safeSend(hostWs, { t:"inputRequest", fromId: clientId, action: msg.action });
      return;
    }
  });

  ws.on("close", () => {
    leaveRoom(clientId);
  });
});

function findClientRoom(clientId){
  for(const [code, room] of rooms.entries()){
    if(room.players.has(clientId)) return code;
  }
  return null;
}

server.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
