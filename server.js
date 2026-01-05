
'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;
const app = express();

// Serve static files from repo root (index.html, assets if any)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --------------------
// Game rules (match client)
// --------------------
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const POWER_RANKS = new Set(["A","2","8","J","Q","K"]);

function rankVal(r){
  if(r==="A") return 1;
  if(r==="J") return 11;
  if(r==="Q") return 12;
  if(r==="K") return 13;
  return parseInt(r,10);
}
function canStart(c, top, suit){
  return c.rank==="A" || c.suit===suit || c.rank===top.rank;
}
function linkOk(p, n){
  return p.rank===n.rank || (p.suit===n.suit && Math.abs(rankVal(p.rank)-rankVal(n.rank))===1);
}

function createDeck(){
  let d=[];
  for(const s of SUITS){
    for(const r of RANKS){
      d.push({id: '', suit:s, rank:r});
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

// --------------------
// Room store
// --------------------
/**
room = {
  code,
  clients: Map(ws -> {id,name,isHost}),
  players: [ {id,name,isHost,hand:[card], lastDeclared:false} ],
  started: false,
  state: { turnIndex,direction,activeSuit,pendingDraw2,pendingDrawJ,pendingSkip,topCard,feed,winner? },
  deck: [card],
  discard: [card],
}
*/
const rooms = new Map();

function broadcast(room, msg){
  const data = JSON.stringify(msg);
  for(const ws of room.clients.keys()){
    if(ws.readyState === WebSocket.OPEN){
      ws.send(data);
    }
  }
}
function send(ws, msg){
  if(ws.readyState === WebSocket.OPEN){
    ws.send(JSON.stringify(msg));
  }
}

function roomPlayers(room){
  return room.players.map(p => ({id:p.id, name:p.name, isHost: p.isHost}));
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
  if(room.players.length){
    if(!room.players.some(p=>p.isHost)){
      room.players[0].isHost = true;
    }
  }

  if(room.players.length === 0){
    rooms.delete(room.code);
    return;
  }

  // if game started, end it (simpler)
  if(room.started){
    room.started = false;
    broadcast(room, {t:'error', message:'Player left - game ended'});
  }

  broadcast(room, {t:'players', players: roomPlayers(room)});
}

function startGame(room){
  room.started = true;

  // Build deck w/ unique ids
  room.deck = createDeck();
  // assign ids
  room.deck.forEach((c, idx) => c.id = `${idx}_${uid()}`);
  shuffle(room.deck);

  // init players
  room.players.forEach(p => {
    p.hand = [];
    p.lastDeclared = false;
  });

  // deal 7 each
  for(let i=0;i<7;i++){
    for(const p of room.players){
      p.hand.push(room.deck.pop());
    }
  }

  // choose a non-power start card to keep things sane
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
    topCard: {id: top.id, rank: top.rank, suit: top.suit},
    feed: "Online match started!"
  };

  broadcastState(room);
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

function applyPower(room, card, pidx, isLast){
  const s = room.state;
  const r = card.rank;

  if(r==="A" && isLast){
    // Auto-pick suit based on remaining hand (like bot)
    const counts = {"♠":0,"♥":0,"♦":0,"♣":0};
    room.players[pidx].hand.forEach(x => counts[x.suit]++);
    const bestSuit = Object.keys(counts).reduce((a,b)=>counts[a]>counts[b]?a:b);
    s.activeSuit = bestSuit;
    s.feed = `Suit is ${bestSuit}`;
  } else if(r==="2"){
    s.pendingDraw2 += 2;
  } else if(r==="8"){
    s.pendingSkip += 1;
  } else if(r==="Q"){
    s.direction *= -1;
    s.feed = (s.direction===1) ? "Direction: Clockwise" : "Direction: Reversed!";
  } else if(r==="K"){
    // extra turn flag handled in play action
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

function advanceTurn(room){
  const s = room.state;
  if(s._extraTurn){
    s._extraTurn = false;
    return;
  }
  const n = room.players.length;
  s.turnIndex = (s.turnIndex + s.direction + n) % n;
}

function doDraw(room, ws){
  const s = room.state;
  const p = currentPlayer(room);
  if(!p) return;

  // Skip mechanic: drawing while skip pending consumes skip and passes (matches client)
  if(s.pendingSkip > 0){
    s.pendingSkip -= 1;
    p.lastDeclared = false;
    s.feed = `${p.name} missed turn! (${s.pendingSkip} left)`;
    advanceTurn(room);
    broadcastState(room);
    return;
  }

  let pen = 1;
  if(s.pendingDraw2 > 0) pen = s.pendingDraw2;
  else if(s.pendingDrawJ > 0) pen = s.pendingDrawJ;

  if(s.pendingDraw2 > 0){
    s.pendingDraw2 = 0;
    s.feed = `${p.name} drew ${pen}`;
  } else if(s.pendingDrawJ > 0){
    s.pendingDrawJ = 0;
    s.feed = `${p.name} drew ${pen}`;
  } else {
    s.feed = `${p.name} drew 1`;
  }

  for(let i=0;i<pen;i++){
    if(room.deck.length === 0){
      // reshuffle discard except top
      if(room.discard.length > 1){
        const top = room.discard[room.discard.length-1];
        const rest = room.discard.slice(0,-1);
        shuffle(rest);
        room.deck = rest;
        room.discard = [top];
      } else {
        break;
      }
    }
    const card = room.deck.pop();
    if(card) p.hand.push(card);
  }
  p.lastDeclared = false;

  advanceTurn(room);
  broadcastState(room);
}

function doLast(room){
  const p = currentPlayer(room);
  if(!p) return;
  p.lastDeclared = true;
  room.state.feed = `${p.name} shouts LAST!`;
  broadcastState(room);
}

function doPlay(room, cardIds){
  const s = room.state;
  const pidx = s.turnIndex;
  const p = room.players[pidx];
  const top = room.discard[room.discard.length-1];

  if(!Array.isArray(cardIds) || cardIds.length === 0){
    return {ok:false, err:"No cards"};
  }

  // map ids to cards in hand in the order received
  const handMap = new Map(p.hand.map(c => [c.id, c]));
  const cards = [];
  for(const id of cardIds){
    const c = handMap.get(id);
    if(!c) return {ok:false, err:"Invalid selection"};
    cards.push(c);
  }

  // validate pending requirements
  if(s.pendingDraw2 > 0 && cards[0].rank !== "2") return {ok:false, err:"Must play a 2!"};
  if(s.pendingDrawJ > 0 && cards[0].rank !== "J") return {ok:false, err:"Must play a Jack (or DRAW)!"};
  if(s.pendingSkip > 0 && cards[0].rank !== "8") return {ok:false, err:"Can only stack an 8!"};

  // validate start
  if(!canStart(cards[0], top, s.activeSuit)) return {ok:false, err:"Invalid Card"};

  // validate combo chain
  for(let i=0;i<cards.length-1;i++){
    if(!linkOk(cards[i], cards[i+1])) return {ok:false, err:"Invalid Combo"};
  }

  // remove from hand (all instances)
  const removeSet = new Set(cardIds);
  p.hand = p.hand.filter(c => !removeSet.has(c.id));

  // apply to discard and powers
  const finishedNow = (p.hand.length === 0);
  const isSet = cards.length>1 && cards.every(c=>c.rank===cards[0].rank);

  cards.forEach((c, i) => {
    room.discard.push(c);
    const isLast = (i===cards.length-1);
    if(POWER_RANKS.has(c.rank) && (isSet || isLast)){
      applyPower(room, c, pidx, isLast);
    }
  });

  // active suit is last card suit unless Ace
  const lastCard = cards[cards.length-1];
  if(lastCard.rank !== "A"){
    s.activeSuit = lastCard.suit;
  }

  // feed
  s.topCard = {id: lastCard.id, rank:lastCard.rank, suit:lastCard.suit};
  s.feed = `${p.name} played ${cards.length} card(s)`;

  // Power finish rule (match client)
  if(finishedNow && POWER_RANKS.has(lastCard.rank)){
    // Can't end on power: DRAW 2
    // Recycle deck if needed
    if(room.deck.length < 2 && room.discard.length > 1){
      const top2 = room.discard[room.discard.length-1];
      const rest = room.discard.slice(0,-1);
      shuffle(rest);
      room.deck = rest;
      room.discard = [top2];
    }
    const drawN = Math.min(2, room.deck.length);
    for(let i=0;i<drawN;i++) p.hand.push(room.deck.pop());

    // cancel any extra-turn chain
    room.state._extraTurn = false;

    // if last was Ace, pick suit based on new hand (best suit)
    if(lastCard.rank === "A"){
      const counts = {"♠":0,"♥":0,"♦":0,"♣":0};
      p.hand.forEach(x => counts[x.suit]++);
      const bestSuit = Object.keys(counts).reduce((a,b)=>counts[a]>counts[b]?a:b);
      s.activeSuit = bestSuit;
    }

    p.lastDeclared = false;
    s.feed = "Can't end on a power card! Drew 2";
    advanceTurn(room);
    return {ok:true};
  }

  // Win condition
  if(p.hand.length === 0){
    s.winner = p.name;
    s.feed = `Winner: ${p.name}`;
    broadcast(room, {t:'ended', winner: p.name});
    // keep state broadcast for final view
    broadcastState(room);
    room.started = false;
    return {ok:true};
  }

  // clear last declared if finished? (client resets)
  if(finishedNow) p.lastDeclared = false;

  // advance
  advanceTurn(room);
  return {ok:true};
}

// --------------------
// WS handlers
// --------------------
wss.on('connection', (ws) => {
  ws._id = uid();
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    const room = findRoomByWs(ws);

    if(msg.t === 'create'){
      // leave old room if any
      if(room) removeClient(ws);

      let code = randCode(6);
      while(rooms.has(code)) code = randCode(6);

      const playerId = uid();
      const name = (msg.name || 'Player').toString().slice(0,24);

      const newRoom = {
        code,
        clients: new Map(),
        players: [],
        started: false,
        state: null,
        deck: [],
        discard: []
      };

      newRoom.clients.set(ws, {id: playerId, name, isHost:true});
      newRoom.players.push({id: playerId, name, isHost:true, hand:[], lastDeclared:false});
      rooms.set(code, newRoom);

      send(ws, {t:'created', room: code, you: playerId, players: roomPlayers(newRoom)});
      return;
    }

    if(msg.t === 'join'){
      if(room) removeClient(ws);
      const code = (msg.room || '').toString().toUpperCase().trim();
      const target = rooms.get(code);
      if(!target) { send(ws, {t:'error', message:'Room not found'}); return; }
            if(target.players.length >= 4) { send(ws, {t:'error', message:'Room full'}); return; }
      if(target.started) { send(ws, {t:'error', message:'Game already started'}); return; }

      const playerId = uid();
      const name = (msg.name || 'Player').toString().slice(0,24);
      const isHost = false;

      target.clients.set(ws, {id: playerId, name, isHost});
      target.players.push({id: playerId, name, isHost, hand:[], lastDeclared:false});

      // Notify all
      broadcast(target, {t:'players', players: roomPlayers(target)});
      send(ws, {t:'joined', room: code, you: playerId, isHost:false, players: roomPlayers(target)});
      return;
    }

    if(!room){
      send(ws, {t:'error', message:'Not in a room'}); 
      return;
    }

    // Identify player
    const info = room.clients.get(ws);
    const s = room.state;

    if(msg.t === 'leave'){
      removeClient(ws);
      return;
    }

    if(msg.t === 'start'){
      // only host
      const host = room.players.find(p=>p.isHost);
      if(!host || host.id !== info.id){ send(ws,{t:'error',message:'Only host can start'}); return; }
      if(room.players.length < 2){ send(ws,{t:'error',message:'Need 2+ players'}); return; }
      startGame(room);
      return;
    }

    if(!room.started || !s){
      send(ws, {t:'error', message:'Game not started'});
      return;
    }

    const cur = currentPlayer(room);
    if(!cur || cur.id !== info.id){
      send(ws, {t:'error', message:'Not your turn'});
      return;
    }

    if(msg.t === 'draw'){
      doDraw(room, ws);
      return;
    }
    if(msg.t === 'last'){
      doLast(room);
      return;
    }
    if(msg.t === 'play'){
      const res = doPlay(room, msg.cards);
      if(!res.ok){
        send(ws, {t:'error', message: res.err || 'Invalid move'});
      } else {
        broadcastState(room);
      }
      return;
    }
    if(msg.t === 'suit'){
      // suit is auto-picked in applyPower; accept but ignore for now
      return;
    }
  });

  ws.on('close', () => removeClient(ws));
});

server.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
