'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

const app = express();

// ---- STATIC FILES (Render-safe) ----
// Your repo has /public/index.html. Some older versions used root /index.html.
// This serves BOTH, and always picks the one that exists.
const PUBLIC_DIR = path.join(__dirname, 'public');
const HAS_PUBLIC = fs.existsSync(PUBLIC_DIR);

if (HAS_PUBLIC) {
  app.use(express.static(PUBLIC_DIR));
}
// Also serve repo root as fallback (for older layouts)
app.use(express.static(__dirname));

// Root: serve /public/index.html if present, else /index.html in root
app.get('/', (req, res) => {
  const publicIndex = path.join(PUBLIC_DIR, 'index.html');
  const rootIndex = path.join(__dirname, 'index.html');
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  return res.sendFile(rootIndex);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// ========================
// GAME SERVER (rooms / turns)
// ========================
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function makeDeck() {
  const d=[];
  for (const s of SUITS) for (const r of RANKS) d.push({rank:r, suit:s});
  for (let i=d.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [d[i],d[j]] = [d[j],d[i]];
  }
  return d;
}

function cardStr(c){ return `[${c.rank}${c.suit}]`; }

function send(ws, msg){
  if(ws.readyState === WebSocket.OPEN){
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room, msg){
  const payload = JSON.stringify(msg);
  for(const ws of room.clients.keys()){
    if(ws.readyState === WebSocket.OPEN){
      try{ ws.send(payload); }catch{}
    }
  }
}

function addLog(room, t){
  room.log.push(t);
  if(room.log.length>250) room.log.shift();
}

function topCard(room){
  return room.discard[room.discard.length-1];
}

function nextIndex(room, from){
  const n = room.players.length;
  if(n<=1) return 0;
  const step = room.direction;
  return (from + step + n) % n;
}

function draw(room, pid, count){
  const p = room.players.find(x=>x.id===pid);
  if(!p) return;
  for(let i=0;i<count;i++){
    if(room.deck.length===0){
      // reshuffle discard except top
      const top = room.discard.pop();
      room.deck = room.discard;
      room.discard = [top];
      for (let k=room.deck.length-1;k>0;k--){
        const j = Math.floor(Math.random()*(k+1));
        [room.deck[k],room.deck[j]] = [room.deck[j],room.deck[k]];
      }
    }
    p.hand.push(room.deck.pop());
  }
}

function canPlay(card, top, activeSuit){
  const suit = activeSuit || top.suit;
  return card.rank==="A" || card.suit===suit || card.rank===top.rank;
}

function stateFor(room){
  return {
    type:'state',
    roomId: room.roomId,
    phase: room.phase, // lobby | playing | over
    players: room.players.map(p=>({
      id:p.id,
      name:p.name,
      isHost: !!p.isHost,
      saidLast: !!p.saidLast,
      cardCount: p.hand.length,
      hand: p.hand, // client hides other hands itself
    })),
    turnId: room.players[room.turnIndex]?.id || null,
    direction: room.direction,
    top: room.discard.length ? topCard(room) : null,
    activeSuit: room.activeSuit,
    pending: room.pending,
    log: room.log.slice(-80),
  };
}

function makeRoom(){
  const roomId = Math.random().toString(36).slice(2,7).toUpperCase();
  return {
    roomId,
    clients: new Map(), // ws -> {id,name}
    players: [],        // {id,name,isHost,hand,saidLast}
    phase: 'lobby',
    deck: [],
    discard: [],
    turnIndex: 0,
    direction: 1,
    activeSuit: null,   // suit chosen after Ace
    pending: null,      // { type:'chooseSuit', by: playerId }
    log: [],
  };
}

const rooms = new Map();

function findRoomByWs(ws){
  for(const r of rooms.values()){
    if(r.clients.has(ws)) return r;
  }
  return null;
}

// ========================
// WEBSOCKET MESSAGES
// ========================
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try{ msg = JSON.parse(raw.toString()); }catch{ return; }

    // ---- CREATE ROOM ----
    if(msg.type === 'createRoom'){
      const room = makeRoom();
      rooms.set(room.roomId, room);

      const id = Math.random().toString(36).slice(2,10);
      const name = String(msg.name || 'Player').slice(0,20);

      room.clients.set(ws, {id, name});
      room.players.push({id, name, isHost:true, hand:[], saidLast:false});

      addLog(room, `${name} created room ${room.roomId}`);
      send(ws, {type:'joined', roomId: room.roomId, id});
      broadcast(room, stateFor(room));
      return;
    }

    // ---- JOIN ROOM ----
    if(msg.type === 'joinRoom'){
      const roomId = String(msg.roomId||'').toUpperCase();
      const room = rooms.get(roomId);
      if(!room){ send(ws, {type:'error', message:'Room not found'}); return; }
      if(room.phase !== 'lobby'){ send(ws, {type:'error', message:'Game already started'}); return; }

      const id = Math.random().toString(36).slice(2,10);
      const name = String(msg.name || 'Player').slice(0,20);

      room.clients.set(ws, {id, name});
      room.players.push({id, name, isHost:false, hand:[], saidLast:false});

      addLog(room, `${name} joined`);
      send(ws, {type:'joined', roomId: room.roomId, id});
      broadcast(room, stateFor(room));
      return;
    }

    const room = findRoomByWs(ws);
    if(!room){ send(ws, {type:'error', message:'Not in a room'}); return; }
    const me = room.clients.get(ws);
    if(!me){ send(ws, {type:'error', message:'Not in a room'}); return; }

    // ---- START GAME (host) ----
    if(msg.type === 'startGame'){
      const p = room.players.find(x=>x.id===me.id);
      if(!p || !p.isHost){ send(ws, {type:'error', message:'Only host can start'}); return; }
      if(room.players.length < 2){ send(ws, {type:'error', message:'Need at least 2 players'}); return; }

      room.phase = 'playing';
      room.deck = makeDeck();
      room.discard = [];
      room.activeSuit = null;
      room.pending = null;
      room.direction = 1;
      room.turnIndex = 0;

      for(const pl of room.players){
        pl.hand = [];
        pl.saidLast = false;
        draw(room, pl.id, 7);
      }

      room.discard.push(room.deck.pop());
      addLog(room, `Game started. Top: ${cardStr(topCard(room))}`);
      broadcast(room, stateFor(room));
      return;
    }

    if(room.phase !== 'playing') return;

    // ---- Pending Ace suit choice ----
    if(room.pending && room.pending.type === 'chooseSuit'){
      if(msg.type !== 'chooseSuit'){
        send(ws, {type:'error', message:'Choose a suit first'}); 
        return;
      }
      if(me.id !== room.pending.by){
        send(ws, {type:'error', message:'Not your suit choice'});
        return;
      }
      const suit = msg.suit;
      if(!SUITS.includes(suit)){
        send(ws, {type:'error', message:'Invalid suit'});
        return;
      }
      room.activeSuit = suit;
      addLog(room, `${me.name} chose suit ${suit}`);
      room.pending = null;

      // move to next player after suit chosen
      room.turnIndex = nextIndex(room, room.turnIndex);
      broadcast(room, stateFor(room));
      return;
    }

    // ---- LAST ----
    if(msg.type === 'sayLast'){
      const pl = room.players.find(x=>x.id===me.id);
      if(!pl) return;
      pl.saidLast = true;
      addLog(room, `${me.name} said LAST`);
      broadcast(room, stateFor(room));
      return;
    }

    // ---- Turn check ----
    const current = room.players[room.turnIndex];
    if(!current || current.id !== me.id){
      send(ws, {type:'error', message:'Not your turn'});
      return;
    }

    // ---- DRAW / PICKUP ----
    if(msg.type === 'draw'){
      draw(room, me.id, 1);
      room.activeSuit = null;
      current.saidLast = false; // reset after action
      addLog(room, `${me.name} drew 1`);
      room.turnIndex = nextIndex(room, room.turnIndex);
      broadcast(room, stateFor(room));
      return;
    }

    // ---- PLAY ----
    if(msg.type === 'play'){
      const pl = current;
      const idx = msg.index;

      if(typeof idx !== 'number' || idx<0 || idx>=pl.hand.length){
        send(ws, {type:'error', message:'Bad card index'});
        return;
      }

      const card = pl.hand[idx];
      const top = topCard(room);

      if(!canPlay(card, top, room.activeSuit)){
        send(ws, {type:'error', message:'Cannot play that card'});
        return;
      }

      // play card
      pl.hand.splice(idx, 1);
      room.discard.push(card);
      addLog(room, `${me.name} played ${cardStr(card)}`);

      // default reset suit unless Ace triggers
      room.activeSuit = null;

      // POWER CARDS (basic; your client applies visuals)
      // Q reverses direction
      // K makes next draw 2
      // J skips next
      let skip = 0;
      let drawNext = 0;

      if(card.rank === 'Q'){
        room.direction *= -1;
        addLog(room, `Direction reversed`);
      } else if(card.rank === 'K'){
        drawNext = 2;
        addLog(room, `Next draws 2`);
      } else if(card.rank === 'J'){
        skip = 1;
        addLog(room, `Next skipped`);
      }

      // FINISH RULE (your rule): you can ONLY go to 0 if you said LAST beforehand
      if(pl.hand.length === 0){
        if(pl.saidLast){
          room.phase = 'over';
          addLog(room, `${me.name} wins!`);
          broadcast(room, stateFor(room));
          return;
        } else {
          draw(room, me.id, 2);
          addLog(room, `${me.name} forgot LAST — penalty draw 2`);
        }
      }

      // ACE: must choose suit before turn advances
      if(card.rank === 'A'){
        room.pending = {type:'chooseSuit', by: me.id};
        addLog(room, `${me.name} must choose a suit`);
        broadcast(room, stateFor(room));
        return;
      }

      // advance turn
      let ni = nextIndex(room, room.turnIndex);

      if(drawNext){
        const np = room.players[ni];
        if(np) draw(room, np.id, drawNext);
      }

      for(let i=0;i<skip;i++){
        ni = nextIndex(room, ni);
      }

      // end turn resets LAST flag (so it must be declared for the win attempt)
      pl.saidLast = false;

      room.turnIndex = ni;
      broadcast(room, stateFor(room));
      return;
    }
  });

  ws.on('close', () => {
    const room = findRoomByWs(ws);
    if(!room) return;

    const info = room.clients.get(ws);
    room.clients.delete(ws);

    if(info){
      room.players = room.players.filter(p => p.id !== info.id);
      addLog(room, `${info.name} left`);

      if(room.players.length && !room.players.some(p=>p.isHost)){
        room.players[0].isHost = true;
      }
      if(room.turnIndex >= room.players.length) room.turnIndex = 0;

      if(room.pending && room.pending.by === info.id){
        room.pending = null;
        room.activeSuit = null;
      }
    }

    if(room.players.length === 0){
      rooms.delete(room.roomId);
      return;
    }

    broadcast(room, stateFor(room));
  });
});

server.listen(PORT, () => {
  console.log('Server listening on', PORT);
});
