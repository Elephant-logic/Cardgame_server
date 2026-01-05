'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const app = express();

// Serve your client from /public (as you said)
app.use(express.static(path.join(__dirname, 'public')));

// health
app.get('/health', (_, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/* =========================
   GAME RULES (match client)
   ========================= */

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const POWER_RANKS = new Set(["A","2","8","J","Q","K"]); // power cards

function rankVal(r){
  if(r==="A") return 1;
  if(r==="J") return 11;
  if(r==="Q") return 12;
  if(r==="K") return 13;
  return parseInt(r,10);
}

// first card must match suit OR rank, or Ace
function canStart(c, top, suit){
  return c.rank==="A" || c.suit===suit || c.rank===top.rank;
}

// combo chain rule (your existing rule)
function linkOk(p, n){
  return p.rank===n.rank || (p.suit===n.suit && Math.abs(rankVal(p.rank)-rankVal(n.rank))===1);
}

function createDeck(){
  let d=[];
  for(const s of SUITS){
    for(const r of RANKS){
      d.push({id:'', suit:s, rank:r});
    }
  }
  return d;
}

function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]]=[arr[j],arr[i]];
  }
}

function randCode(len=6){
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out="";
  for(let i=0;i<len;i++) out += chars[Math.floor(Math.random()*chars.length)];
  return out;
}

function uid(){
  return Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
}

/* =========================
   ROOMS
   =========================
room = {
  code,
  clients: Map(ws -> {id,name,isHost}),
  players: [{id,name,isHost,hand:[card], lastDeclared:false}],
  started: bool,
  deck: [card],
  discard: [card],
  state: {
    turnIndex, direction, activeSuit,
    pendingDraw2, pendingDrawJ, pendingSkip,
    topCard, feed,
    lastCalledThisTurn: { [playerId]: true }  // <-- IMPORTANT
  }
}
*/

const rooms = new Map();

function send(ws, msg){
  if(ws.readyState === WebSocket.OPEN){
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room, msg){
  const data = JSON.stringify(msg);
  for(const ws of room.clients.keys()){
    if(ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function roomPlayers(room){
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    isHost: !!p.isHost
  }));
}

function findRoomByWs(ws){
  for(const room of rooms.values()){
    if(room.clients.has(ws)) return room;
  }
  return null;
}

function removeClient(ws){
  const room = findRoomByWs(ws);
  if(!room) return;

  const info = room.clients.get(ws);
  room.clients.delete(ws);
  room.players = room.players.filter(p => p.id !== info.id);

  // reassign host if needed
  if(room.players.length && !room.players.some(p => p.isHost)){
    room.players[0].isHost = true;
  }

  // delete empty room
  if(room.players.length === 0){
    rooms.delete(room.code);
    return;
  }

  // if game started, end it (simple + avoids desync)
  if(room.started){
    room.started = false;
    broadcast(room, { t:'error', message:'Player left — game ended' });
  }

  broadcast(room, { t:'players', players: roomPlayers(room) });
}

function broadcastState(room){
  const s = room.state;
  const payload = {
    t:'state',
    state: {
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        lastDeclared: !!p.lastDeclared,
        hand: p.hand.map(c => ({id:c.id, rank:c.rank, suit:c.suit}))
      })),
      turnIndex: s.turnIndex,
      direction: s.direction,
      activeSuit: s.activeSuit,
      pendingDraw2: s.pendingDraw2,
      pendingDrawJ: s.pendingDrawJ,
      pendingSkip: s.pendingSkip,
      topCard: s.topCard,
      feed: s.feed
    }
  };
  broadcast(room, payload);
}

function currentPlayer(room){
  return room.players[room.state.turnIndex];
}

function advanceTurn(room){
  const s = room.state;
  if(s._extraTurn){
    s._extraTurn = false;
    return;
  }
  const n = room.players.length;
  s.turnIndex = (s.turnIndex + s.direction + n) % n;
  // reset per-turn last calls when turn advances
  s.lastCalledThisTurn = {};
}

function reshuffleIfNeeded(room){
  if(room.deck.length > 0) return;
  if(room.discard.length <= 1) return;
  const top = room.discard[room.discard.length-1];
  const rest = room.discard.slice(0,-1);
  shuffle(rest);
  room.deck = rest;
  room.discard = [top];
}

function drawN(room, player, n){
  for(let i=0;i<n;i++){
    reshuffleIfNeeded(room);
    if(room.deck.length === 0) break;
    player.hand.push(room.deck.pop());
  }
}

function applyPower(room, card, pidx, isLast){
  const s = room.state;
  const r = card.rank;

  // Ace: suit picking (server can auto-pick if player doesn't)
  if(r==="A" && isLast){
    const counts = {"♠":0,"♥":0,"♦":0,"♣":0};
    room.players[pidx].hand.forEach(x => counts[x.suit]++);
    const bestSuit = Object.keys(counts).reduce((a,b)=>counts[a]>counts[b]?a:b);
    s.activeSuit = bestSuit;
    s.feed = `Suit is ${bestSuit}`;
    return;
  }

  if(r==="2"){
    s.pendingDraw2 += 2;
  } else if(r==="8"){
    s.pendingSkip += 1;
  } else if(r==="Q"){
    s.direction *= -1;
    s.feed = (s.direction===1) ? "Direction: Clockwise" : "Direction: Reversed!";
  } else if(r==="K"){
    s._extraTurn = true;
  } else if(r==="J"){
    const isRed = (card.suit==="♥" || card.suit==="♦");
    if(isRed){
      s.pendingDrawJ = 0;
      s.feed = "Attack Blocked!";
    } else {
      s.pendingDrawJ += 5;
    }
  }
}

/* =========================
   LAST RULE (your wording)
   =========================
- If you try to finish (go to 0 cards), you MUST have said LAST previously.
- If you go down to 1 card and you DIDN’T say LAST that turn, penalty: draw 1.
- LAST is a button you hit on your turn, BEFORE you play your cards.
*/

function markLastThisTurn(room, playerId){
  room.state.lastCalledThisTurn[playerId] = true;
  room.state.feed = `LAST called`;
}

function doDraw(room){
  const s = room.state;
  const p = currentPlayer(room);

  // skip pending
  if(s.pendingSkip > 0){
    s.pendingSkip -= 1;
    p.lastDeclared = false;
    s.feed = `${p.name} missed turn! (${s.pendingSkip} left)`;
    advanceTurn(room);
    broadcastState(room);
    return;
  }

  let n = 1;
  if(s.pendingDraw2 > 0) n = s.pendingDraw2;
  else if(s.pendingDrawJ > 0) n = s.pendingDrawJ;

  if(s.pendingDraw2 > 0){ s.pendingDraw2 = 0; s.feed = `${p.name} drew ${n}`; }
  else if(s.pendingDrawJ > 0){ s.pendingDrawJ = 0; s.feed = `${p.name} drew ${n}`; }
  else { s.feed = `${p.name} drew 1`; }

  drawN(room, p, n);

  // drawing ends your turn + clears your LAST status
  p.lastDeclared = false;
  advanceTurn(room);
  broadcastState(room);
}

function doPlay(room, playerId, cardIds){
  const s = room.state;
  const pidx = s.turnIndex;
  const p = room.players[pidx];
  const top = room.discard[room.discard.length-1];

  if(!Array.isArray(cardIds) || cardIds.length === 0){
    return {ok:false, err:"No cards selected"};
  }

  const handMap = new Map(p.hand.map(c => [c.id, c]));
  const cards = [];
  for(const id of cardIds){
    const c = handMap.get(id);
    if(!c) return {ok:false, err:"Invalid selection"};
    cards.push(c);
  }

  // pending requirements
  if(s.pendingDraw2 > 0 && cards[0].rank !== "2") return {ok:false, err:"Must play a 2!"};
  if(s.pendingDrawJ > 0 && cards[0].rank !== "J") return {ok:false, err:"Must play a Jack (or DRAW)!"};
  if(s.pendingSkip > 0 && cards[0].rank !== "8") return {ok:false, err:"Can only stack an 8!"};

  // start validity
  if(!canStart(cards[0], top, s.activeSuit)) return {ok:false, err:"Invalid Card"};

  // combo chain validity
  for(let i=0;i<cards.length-1;i++){
    if(!linkOk(cards[i], cards[i+1])) return {ok:false, err:"Invalid Combo"};
  }

  // remove from hand
  const removeSet = new Set(cardIds);
  p.hand = p.hand.filter(c => !removeSet.has(c.id));

  const isSet = cards.length>1 && cards.every(c=>c.rank===cards[0].rank);

  // push to discard + apply power (only if last or set)
  cards.forEach((c, i) => {
    room.discard.push(c);
    const isLast = (i===cards.length-1);
    if(POWER_RANKS.has(c.rank) && (isSet || isLast)){
      applyPower(room, c, pidx, isLast);
    }
  });

  const lastCard = cards[cards.length-1];
  s.topCard = {id:lastCard.id, rank:lastCard.rank, suit:lastCard.suit};
  if(lastCard.rank !== "A") s.activeSuit = lastCard.suit;

  // RULE: can't end on a power card (your game rule)
  if(p.hand.length === 0 && POWER_RANKS.has(lastCard.rank)){
    drawN(room, p, 1);
    p.lastDeclared = false;
    s.feed = "Can't end on Power! Pick up 1";
    advanceTurn(room);
    return {ok:true};
  }

  // LAST rule enforcement
  const calledLastNow = !!s.lastCalledThisTurn[playerId];

  // If player now has 1 card, they must have called LAST this turn:
  if(p.hand.length === 1){
    if(!calledLastNow){
      // penalty
      drawN(room, p, 1);
      p.lastDeclared = false;
      s.feed = `${p.name} forgot LAST — penalty draw 1`;
      advanceTurn(room);
      return {ok:true};
    }
    // mark them as officially "declared" for their next finish attempt
    p.lastDeclared = true;
    s.feed = `${p.name} is on LAST card`;
    advanceTurn(room);
    return {ok:true};
  }

  // If player hits 0 cards (tries to go out), they must already have lastDeclared=true from earlier:
  if(p.hand.length === 0){
    if(!p.lastDeclared){
      // penalty, cannot win
      drawN(room, p, 1);
      s.feed = `${p.name} tried to finish without LAST — penalty draw 1`;
      advanceTurn(room);
      return {ok:true};
    }

    // WIN
    s.winner = p.name;
    s.feed = `Winner: ${p.name}`;
    broadcast(room, {t:'ended', winner:p.name});
    broadcastState(room);
    room.started = false;
    return {ok:true};
  }

  // normal play continues, reset “last called this turn” doesn’t matter now
  s.feed = `${p.name} played ${cards.length} card(s)`;
  advanceTurn(room);
  return {ok:true};
}

function startGame(room){
  room.started = true;

  room.deck = createDeck();
  room.deck.forEach((c, idx) => c.id = `${idx}_${uid()}`);
  shuffle(room.deck);

  room.players.forEach(p => { p.hand = []; p.lastDeclared = false; });

  // deal 7 each
  for(let i=0;i<7;i++){
    for(const p of room.players) p.hand.push(room.deck.pop());
  }

  // choose a non-power top card to start clean
  let top = room.deck.pop();
  let safety=0;
  while(POWER_RANKS.has(top.rank) && safety < 50){
    room.deck.unshift(top);
    top = room.deck.pop();
    safety++;
  }
  room.discard = [top];

  room.state = {
    turnIndex: 0,
    direction: 1,
    activeSuit: top.suit,
    pendingDraw2: 0,
    pendingDrawJ: 0,
    pendingSkip: 0,
    topCard: {id:top.id, rank:top.rank, suit:top.suit},
    feed: "Online match started!",
    lastCalledThisTurn: {}
  };

  broadcastState(room);
}

/* =========================
   WEBSOCKET API
   ========================= */

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    const room = findRoomByWs(ws);

    // CREATE room
    if(msg.t === 'create'){
      if(room) removeClient(ws);

      let code = randCode(6);
      while(rooms.has(code)) code = randCode(6);

      const playerId = uid();
      const name = String(msg.name || 'Player').slice(0,24);

      const newRoom = {
        code,
        clients: new Map(),
        players: [],
        started: false,
        deck: [],
        discard: [],
        state: null
      };

      newRoom.clients.set(ws, {id:playerId, name, isHost:true});
      newRoom.players.push({id:playerId, name, isHost:true, hand:[], lastDeclared:false});
      rooms.set(code, newRoom);

      send(ws, {t:'created', room:code, you:playerId, players:roomPlayers(newRoom)});
      broadcast(newRoom, {t:'players', players:roomPlayers(newRoom)});
      return;
    }

    // JOIN room
    if(msg.t === 'join'){
      if(room) removeClient(ws);

      const code = String(msg.room || '').toUpperCase().trim();
      const target = rooms.get(code);
      if(!target){ send(ws,{t:'error', message:'Room not found'}); return; }
      if(target.started){ send(ws,{t:'error', message:'Game already started'}); return; }
      if(target.players.length >= 4){ send(ws,{t:'error', message:'Room full (max 4)'}); return; }

      const playerId = uid();
      const name = String(msg.name || 'Player').slice(0,24);

      target.clients.set(ws, {id:playerId, name, isHost:false});
      target.players.push({id:playerId, name, isHost:false, hand:[], lastDeclared:false});

      send(ws, {t:'joined', room:code, you:playerId, isHost:false, players:roomPlayers(target)});
      broadcast(target, {t:'players', players:roomPlayers(target)});
      return;
    }

    // must be in a room after this
    if(!room){
      send(ws,{t:'error', message:'Not in a room'});
      return;
    }

    const info = room.clients.get(ws);

    if(msg.t === 'leave'){
      removeClient(ws);
      return;
    }

    if(msg.t === 'start'){
      const host = room.players.find(p => p.isHost);
      if(!host || host.id !== info.id){
        send(ws,{t:'error', message:'Only host can start'});
        return;
      }
      if(room.players.length < 2){
        send(ws,{t:'error', message:'Need 2–4 players'});
        return;
      }
      startGame(room);
      return;
    }

    if(!room.started || !room.state){
      send(ws,{t:'error', message:'Game not started'});
      return;
    }

    const cur = currentPlayer(room);
    if(!cur || cur.id !== info.id){
      send(ws,{t:'error', message:'Not your turn'});
      return;
    }

    if(msg.t === 'draw'){
      doDraw(room);
      return;
    }

    if(msg.t === 'last'){
      markLastThisTurn(room, info.id);
      broadcastState(room);
      return;
    }

    if(msg.t === 'play'){
      const res = doPlay(room, info.id, msg.cards);
      if(!res.ok){
        send(ws,{t:'error', message:res.err || 'Invalid move'});
      } else {
        broadcastState(room);
      }
      return;
    }
  });

  ws.on('close', () => removeClient(ws));
});

server.listen(PORT, () => {
  console.log(`Old Skool Blackjack server running on ${PORT}`);
});
