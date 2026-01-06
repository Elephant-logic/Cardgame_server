const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const app = express();

app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

/** -------------------- GAME RULES -------------------- */
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
const SUITS = ["S","H","D","C"];
const POWER_RANKS = new Set(["A", "2", "8", "J", "Q", "K"]); // Cannot finish on these

// Deck Helper
function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) {
    deck.push({ id: Math.random().toString(36).substr(2, 9), r, s });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function draw(deck, n) {
  const out = [];
  for(let i=0; i<n; i++) if(deck.length) out.push(deck.pop());
  return out;
}

// Logic: Can card be played?
function canPlayOn(card, top, activeSuit) {
  if (!card || !top) return false;
  // Ace is Wild
  if (card.r === "A") return true; 
  // Otherwise must match Rank or Suit (Active Suit if set)
  return card.r === top.r || card.s === (activeSuit || top.s);
}

/** -------------------- SERVER STATE -------------------- */
// Rooms: { code: { players:[], deck, discard, ... } }
const rooms = new Map();

function createRoom(code, hostId, name) {
  return {
    code,
    hostId,
    players: [{ id: hostId, name, ws: null, hand: [], lastCalled: false, isBot: false }],
    inGame: false,
    deck: [],
    discard: [],
    turnIndex: 0,
    direction: 1,
    activeSuit: null,
    // ATTACK STATES
    pendingDraw2: 0,
    pendingDrawJ: 0,
    pendingSkip: 0,
    extraTurn: false,
    awaitingSuit: false
  };
}

/** -------------------- PLAY LOGIC -------------------- */
function handlePlay(room, p, cardIds, suitChoice) {
  // 1. Validate Turn
  if (room.players[room.turnIndex].id !== p.id) return { err: "Not your turn" };
  if (room.awaitingSuit) return { err: "Waiting for suit selection" };

  // 2. Get Cards
  const hand = p.hand;
  const cards = cardIds.map(id => hand.find(c => c.id === id)).filter(Boolean);
  if (cards.length !== cardIds.length) return { err: "Cards not in hand" };
  if (cards.length === 0) return { err: "No cards selected" };

  // 3. Validate Combo (Must be same rank)
  const first = cards[0];
  if (!cards.every(c => c.r === first.r)) return { err: "Must play same ranks together" };

  // 4. Validate Move against Top Card
  const top = room.discard[room.discard.length - 1];
  
  // -- DEFENSE CHECK --
  // If getting attacked by 2, must play 2
  if (room.pendingDraw2 > 0 && first.r !== "2") return { err: `Must play a 2 (Draw ${room.pendingDraw2})` };
  // If getting attacked by Black Jack, must play Red Jack
  if (room.pendingDrawJ > 0) {
     if (first.r !== "J") return { err: `Must play a Jack (Draw ${room.pendingDrawJ})` };
     // Note: Any Jack plays on a Jack, but we handle the "Red blocks" logic in effects
  }
  // If skipped (8), usually you miss turn, but some rules allow playing an 8 to counter. 
  // Your rules say "8: Skip". Usually that means immediate skip. 
  // We'll enforce skipping in the `nextTurn` logic, but if player is active, they can play.
  
  if (!canPlayOn(first, top, room.activeSuit)) return { err: "Invalid card" };

  // 5. REMOVE CARDS & UPDATE DISCARD
  p.hand = p.hand.filter(c => !cardIds.includes(c.id));
  room.discard.push(...cards);
  
  // 6. CHECK WIN / DIRTY FINISH
  if (p.hand.length === 0) {
    const lastPlayed = cards[cards.length - 1];
    if (POWER_RANKS.has(lastPlayed.r)) {
      // Dirty Finish Penalty
      p.hand.push(...draw(room.deck, 2));
      p.lastCalled = false;
      // Reset any powers derived from this illegal play
      room.extraTurn = false;
      room.awaitingSuit = false;
      finishTurn(room);
      return { msg: "Can't finish on a Power Card! Drew 2." };
    } else {
      // WINNER!
      room.inGame = false;
      broadcast(room, { type: "ENDED", winner: p.name });
      return { msg: `${p.name} WINS!` };
    }
  }

  // 7. APPLY EFFECTS
  const last = cards[cards.length - 1];
  
  // Set Active Suit (Default to card suit, Ace overrides later)
  if (last.r !== "A") room.activeSuit = last.s;

  // Q: Reverse
  if (last.r === "Q") {
    room.direction *= -1;
  }
  
  // 2: Draw 2 (Stacks)
  if (last.r === "2") {
    room.pendingDraw2 += (2 * cards.length);
  }
  
  // 8: Skip
  if (last.r === "8") {
    room.pendingSkip += cards.length; 
  }
  
  // K: Go Again
  if (last.r === "K") {
    room.extraTurn = true;
  }
  
  // J: Black draws, Red blocks
  if (last.r === "J") {
    cards.forEach(c => {
      if (c.s === "S" || c.s === "C") {
        room.pendingDrawJ += 5; // Black Jack adds 5
      } else {
        room.pendingDrawJ = 0; // Red Jack clears ALL penalty
      }
    });
  }

  // A: Wild (Request Suit)
  if (last.r === "A") {
    if (suitChoice && SUITS.includes(suitChoice)) {
      room.activeSuit = suitChoice;
    } else {
      // Ask player for suit
      room.awaitingSuit = true;
      return { state: true }; // Stop here, don't advance turn
    }
  }

  finishTurn(room);
  return { state: true };
}

function handleDraw(room, p) {
  if (room.players[room.turnIndex].id !== p.id) return;

  // If under attack, draw the penalty
  let count = 1;
  if (room.pendingDraw2 > 0) {
    count = room.pendingDraw2;
    room.pendingDraw2 = 0;
  } else if (room.pendingDrawJ > 0) {
    count = room.pendingDrawJ;
    room.pendingDrawJ = 0;
  } else if (room.pendingSkip > 0) {
    // If skipped, you don't draw, you just miss turn. 
    // But if client hit "Draw" button, usually means they have no play.
    // We just clear skip and move on.
    room.pendingSkip = 0;
    count = 0; 
  }

  if (count > 0) {
    // Reshuffle if needed
    if (room.deck.length < count) {
      const top = room.discard.pop();
      room.deck = [...room.deck, ...room.discard].sort(() => Math.random() - 0.5);
      room.discard = [top];
    }
    p.hand.push(...draw(room.deck, count));
  }

  finishTurn(room);
}

function finishTurn(room) {
  // If Ace is pending suit selection, don't move turn
  if (room.awaitingSuit) return;

  // If King played (Extra Turn), don't move turn
  if (room.extraTurn) {
    room.extraTurn = false;
    return; // Same player goes again
  }

  const p = room.players[room.turnIndex];
  p.lastCalled = false; // Reset "Last" status

  // Advance
  let steps = 1 + room.pendingSkip;
  room.pendingSkip = 0; // consumed
  
  let n = room.players.length;
  room.turnIndex = (room.turnIndex + (room.direction * steps)) % n;
  if (room.turnIndex < 0) room.turnIndex += n;

  // Check if next player is a Bot
  const nextP = room.players[room.turnIndex];
  if (nextP.isBot) {
    setTimeout(() => botTurn(room), 1000);
  }
}

function botTurn(room) {
  if (!room.inGame) return;
  const p = room.players[room.turnIndex];
  if (!p.isBot) return;

  // Simple Bot Logic
  // 1. Can play?
  const top = room.discard[room.discard.length-1];
  const valid = p.hand.filter(c => canPlayOn(c, top, room.activeSuit));
  
  // Filter for defense if needed
  let candidates = valid;
  if (room.pendingDraw2 > 0) candidates = valid.filter(c => c.r === "2");
  if (room.pendingDrawJ > 0) candidates = valid.filter(c => c.r === "J");

  if (candidates.length > 0) {
    // Play first valid
    const c = candidates[0];
    // Check for multiples
    const others = p.hand.filter(x => x.r === c.r && x.id !== c.id);
    const toPlay = [c.id, ...others.map(x => x.id)];
    
    // Call last if needed
    if (p.hand.length - toPlay.length <= 1) p.lastCalled = true;

    // Pick random suit for Ace
    let suit = null;
    if (c.r === "A") suit = SUITS[Math.floor(Math.random()*4)];

    handlePlay(room, p, toPlay, suit);
  } else {
    handleDraw(room, p);
  }
  broadcastState(room);
}

/** -------------------- WEBSOCKETS -------------------- */
wss.on("connection", (ws) => {
  let myRoom = null;
  let myUser = null;

  function send(type, data) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
  }

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.type === "HELLO") {
      myUser = { id: Math.random().toString(36).substr(2), name: data.name };
      send("WELCOME", { id: myUser.id });
    }

    if (data.type === "CREATE_ROOM") {
      const code = Math.floor(1000 + Math.random() * 9000).toString(); // 4 digit code
      myRoom = createRoom(code, myUser.id, data.name || "Host");
      rooms.set(code, myRoom);
      myRoom.players[0].ws = ws;
      send("ROOM_JOINED", { code, isHost: true });
      broadcastRoom(myRoom);
    }

    if (data.type === "JOIN_ROOM") {
      const r = rooms.get(data.code);
      if (!r) return send("ERROR", { msg: "Room not found" });
      if (r.inGame) return send("ERROR", { msg: "Game already started" });
      
      myRoom = r;
      const newUser = { id: myUser.id, name: data.name, ws, hand:[], lastCalled:false, isBot:false };
      r.players.push(newUser);
      send("ROOM_JOINED", { code: r.code, isHost: false });
      broadcastRoom(r);
    }

    if (data.type === "START_GAME") {
      if (!myRoom || myRoom.hostId !== myUser.id) return;
      
      // Fill with bots if needed (min 2)
      while(myRoom.players.length < 2) {
        myRoom.players.push({ 
          id: "bot"+Math.random(), name: "Bot " + myRoom.players.length, 
          isBot: true, hand: [], lastCalled: false 
        });
      }

      // Init Deck
      myRoom.deck = makeDeck();
      // Deal 7
      myRoom.players.forEach(p => { p.hand = draw(myRoom.deck, 7); });
      // Top Card (Retry if power card)
      while(true) {
        let top = myRoom.deck.pop();
        if(!POWER_RANKS.has(top.r)) {
          myRoom.discard = [top];
          myRoom.activeSuit = top.s;
          break;
        }
        myRoom.deck.unshift(top);
      }
      
      myRoom.inGame = true;
      broadcastState(myRoom);
    }

    if (data.type === "ACTION_PLAY") {
      if (!myRoom) return;
      const res = handlePlay(myRoom, myRoom.players.find(p=>p.id===myUser.id), data.indices, data.suit); // Client sends card IDs in indices for P2P logic usually, or we map indices to IDs.
      // Wait, your client sends indices (0, 1, 2...). We need to map that to the server hand.
      // Correction: The new client code I gave sends `indices`.
      // Let's adjust handlePlay to take indices or IDs. 
      // Actually, safest is to map indices to objects here.
      const p = myRoom.players.find(p=>p.id===myUser.id);
      if(p) {
         // Map indices to IDs
         const cardIds = data.indices.map(i => p.hand[i] ? p.hand[i].id : null).filter(Boolean);
         const res = handlePlay(myRoom, p, cardIds, data.suitChar); 
         if(res.err) send("TOAST", { msg: res.err });
         broadcastState(myRoom);
      }
    }

    if (data.type === "ACTION_PICKUP") {
      if (!myRoom) return;
      handleDraw(myRoom, myRoom.players.find(p=>p.id===myUser.id));
      broadcastState(myRoom);
    }

    if (data.type === "ACTION_LAST") {
      if (!myRoom) return;
      const p = myRoom.players.find(p=>p.id===myUser.id);
      if(p) p.lastCalled = true;
      broadcastState(myRoom);
    }
    
    if (data.type === "ACTION_SUIT") {
       if (!myRoom) return;
       myRoom.activeSuit = (data.suitChar === "H" ? "♥" : data.suitChar === "D" ? "♦" : data.suitChar === "C" ? "♣" : "♠"); // Map char to symbol if needed, or just keep char
       // Wait, your logic uses symbols. Let's stick to symbols in server.
       const map = {H:"♥", D:"♦", C:"♣", S:"♠"};
       if(map[data.suitChar]) myRoom.activeSuit = map[data.suitChar];
       myRoom.awaitingSuit = false;
       finishTurn(myRoom);
       broadcastState(myRoom);
    }
  });

  ws.on("close", () => {
    if (myRoom) {
      myRoom.players = myRoom.players.filter(p => p.id !== myUser.id);
      if (myRoom.players.length === 0) rooms.delete(myRoom.code);
      else broadcastRoom(myRoom);
    }
  });
});

function broadcastRoom(room) {
  const names = room.players.map(p => p.name);
  room.players.forEach(p => {
    if (p.ws) safeSend(p.ws, { type: "PLAYER_UPDATE", names });
  });
}

function broadcastState(room) {
  room.players.forEach(p => {
    if (p.ws) {
      // Send FULL state but hide other hands
      const cleanPlayers = room.players.map(pl => ({
        id: pl.id,
        name: pl.name,
        isBot: pl.isBot,
        lastDeclared: pl.lastCalled,
        hand: pl.id === p.id ? pl.hand : pl.hand.map(() => ({ r:"?", s:"?" })), // Hide cards
        cardCount: pl.hand.length
      }));
      
      const state = {
        discard: room.discard,
        activeSuit: room.activeSuit, // Symbol
        players: cleanPlayers,
        turnIndex: room.turnIndex,
        pendingDraw2: room.pendingDraw2,
        pendingDrawJ: room.pendingDrawJ,
        pendingSkip: room.pendingSkip,
        awaitingSuit: room.awaitingSuit,
        winner: room.inGame ? null : (room.players.find(x=>x.hand.length===0)?.name)
      };
      
      safeSend(p.ws, { type: "GAME_STATE", state, playerId: p.id });
    }
  });
}

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
