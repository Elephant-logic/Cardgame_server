const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve the index.html file specifically
app.get('/', (req, res) => {
    // FIX IS HERE: Added 'public' to the path
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- GAME LOGIC CONSTANTS ---
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const POWER_RANKS = new Set(["A", "2", "8", "J", "Q", "K"]);
const SUIT_MAP = { H: "♥", D: "♦", C: "♣", S: "♠" };

// --- ROOM STORAGE ---
const rooms = {};

// --- GAME HELPER FUNCTIONS ---
function createDeck() {
    let d = [];
    for (let s of SUITS) for (let r of RANKS) d.push({ suit: s, rank: r });
    return d;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

function draw(gameState, n) {
    let arr = [];
    for (let i = 0; i < n; i++) {
        if (gameState.deck.length === 0) {
            if (gameState.discard.length > 1) {
                let top = gameState.discard.pop();
                let rest = gameState.discard;
                gameState.discard = [top];
                shuffle(rest);
                gameState.deck = rest;
            } else {
                let newD = createDeck();
                shuffle(newD);
                gameState.deck = newD;
            }
        }
        if (gameState.deck.length > 0) arr.push(gameState.deck.pop());
    }
    return arr;
}

function rankVal(r) {
    if (r === "A") return 1;
    if (r === "J") return 11;
    if (r === "Q") return 12;
    if (r === "K") return 13;
    return parseInt(r);
}

function canStart(c, top, suit) {
    return c.rank === "A" || c.suit === suit || c.rank === top.rank;
}

function linkOk(p, n) {
    return p.rank === n.rank || (p.suit === n.suit && Math.abs(rankVal(p.rank) - rankVal(n.rank)) === 1);
}

// --- MAIN GAME LOGIC ---
function initGame(room) {
    const deck = createDeck();
    shuffle(deck);
    
    room.gameState = {
        deck: deck,
        discard: [],
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            hand: [],
            lastDeclared: false,
            wins: 0
        })),
        turnIndex: 0,
        direction: 1,
        activeSuit: null,
        pendingDraw2: 0,
        pendingDrawJ: 0,
        pendingSkip: 0,
        extraTurn: false,
        winner: null,
        status: 'playing',
        awaitingSuit: false
    };

    // Deal 7 cards
    for (let i = 0; i < 7; i++) {
        room.gameState.players.forEach(p => p.hand.push(room.gameState.deck.pop()));
    }

    // Flip starter
    while (true) {
        let start = room.gameState.deck.pop();
        if (!POWER_RANKS.has(start.rank)) {
            room.gameState.discard.push(start);
            room.gameState.activeSuit = start.suit;
            break;
        }
        room.gameState.deck.unshift(start);
    }
}

function handlePlay(room, playerId, cardIndices) {
    const state = room.gameState;
    const player = state.players[state.turnIndex];

    if (player.id !== playerId) return { error: "Not your turn" };

    // Sort descending to splice safely
    cardIndices.sort((a, b) => b - a);
    if (cardIndices.some(idx => idx < 0 || idx >= player.hand.length)) return { error: "Invalid cards" };

    const cards = cardIndices.map(idx => player.hand[idx]);
    // Client selection order is crucial, reverse to get play order
    cards.reverse(); 

    let err = null;
    let top = state.discard[state.discard.length - 1];

    if (state.pendingDraw2 > 0 && cards[0].rank !== "2") err = "Must play a 2!";
    else if (state.pendingDrawJ > 0 && cards[0].rank !== "J") err = "Must play a Jack!";
    else if (state.pendingSkip > 0 && cards[0].rank !== "8") err = "Play an 8 or Draw!";
    else if (!canStart(cards[0], top, state.activeSuit)) err = "Invalid Card";
    else {
        for (let i = 0; i < cards.length - 1; i++) {
            if (!linkOk(cards[i], cards[i + 1])) err = "Invalid Combo";
        }
    }

    if (err) return { error: err };

    // Execute Play
    cardIndices.forEach(idx => player.hand.splice(idx, 1));
    let isSet = cards.length > 1 && cards.every(c => c.rank === cards[0].rank);

    cards.forEach((c, i) => {
        state.discard.push(c);
        let isLast = i === cards.length - 1;
        
        if (POWER_RANKS.has(c.rank) && (isSet || isLast)) {
            if (c.rank === "A" && isLast) {
                state.awaitingSuit = true;
            } 
            else if (c.rank === "2") state.pendingDraw2 += 2;
            else if (c.rank === "8") state.pendingSkip++;
            else if (c.rank === "Q") { state.direction *= -1; }
            else if (c.rank === "K") state.extraTurn = true;
            else if (c.rank === "J") {
                 if (c.suit === "♥" || c.suit === "♦") {
                     if (state.pendingDrawJ > 0) state.pendingDrawJ = 0; 
                 } else state.pendingDrawJ += 5;
            }
        }
    });

    let lastCard = cards[cards.length - 1];
    if (lastCard.rank !== "A") state.activeSuit = lastCard.suit;

    // Check Finish
    if (player.hand.length === 0) {
        if (POWER_RANKS.has(lastCard.rank)) {
            // Illegal Finish
            player.hand.push(...draw(state, 2));
            player.lastDeclared = false;
            state.extraTurn = false; 
            state.awaitingSuit = false;
            finishTurn(state);
            return { message: "Can't finish on power card! Drew 2." };
        } else {
            state.winner = player.name;
            state.status = 'ended';
            return { success: true };
        }
    }

    if (state.awaitingSuit) return { success: true, action: "PICK_SUIT" };
    if (state.extraTurn) {
        state.extraTurn = false;
        return { success: true };
    }

    finishTurn(state);
    return { success: true };
}

function finishTurn(state) {
    state.players[state.turnIndex].lastDeclared = false;
    let num = state.players.length;
    state.turnIndex = (state.turnIndex + state.direction + num) % num;
}

// --- WEBSOCKET HANDLER ---
wss.on('connection', (ws) => {
    let currentRoom = null;
    let myId = uuidv4();

    const send = (type, data) => ws.send(JSON.stringify({ type, ...data }));

    ws.on('message', (message) => {
        let msg;
        try { msg = JSON.parse(message); } catch(e) { return; }

        if (msg.type === 'CREATE_ROOM') {
            const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
            rooms[roomCode] = {
                code: roomCode,
                players: [{ id: myId, name: msg.name, ws: ws }],
                gameState: null
            };
            currentRoom = roomCode;
            send('ROOM_JOINED', { code: roomCode, isHost: true, playerId: myId });
        }

        else if (msg.type === 'JOIN_ROOM') {
            const room = rooms[msg.code];
            if (!room) return send('ERROR', { msg: "Room not found" });
            if (room.gameState) return send('ERROR', { msg: "Game already started" });
            
            room.players.push({ id: myId, name: msg.name, ws: ws });
            currentRoom = msg.code;
            send('ROOM_JOINED', { code: msg.code, isHost: false, playerId: myId });
            broadcast(room, 'PLAYER_UPDATE', { names: room.players.map(p => p.name) });
        }

        else if (msg.type === 'START_GAME') {
            const room = rooms[currentRoom];
            if (!room || room.players[0].id !== myId) return;
            initGame(room);
            broadcastState(room);
        }

        else if (msg.type === 'ACTION_PICKUP') {
            const room = rooms[currentRoom];
            if (!room || !room.gameState) return;
            const state = room.gameState;
            const p = state.players[state.turnIndex];
            
            if (p.id !== myId) return;

            if (state.pendingSkip > 0) {
                state.pendingSkip = 0;
            } else {
                let pen = state.pendingDraw2 || state.pendingDrawJ || 1;
                let cards = draw(state, pen);
                p.hand.push(...cards);
                state.pendingDraw2 = 0;
                state.pendingDrawJ = 0;
            }
            finishTurn(state);
            broadcastState(room);
        }

        else if (msg.type === 'ACTION_PLAY') {
            const room = rooms[currentRoom];
            if (!room) return;
            const result = handlePlay(room, myId, msg.indices);
            if (result.error) send('TOAST', { msg: result.error });
            else broadcastState(room);
        }

        else if (msg.type === 'ACTION_SUIT') {
             const room = rooms[currentRoom];
             if (!room || !room.gameState.awaitingSuit) return;
             const state = room.gameState;
             if (state.players[state.turnIndex].id !== myId) return;
             state.activeSuit = SUIT_MAP[msg.suitChar] || "♠";
             state.awaitingSuit = false;
             finishTurn(state);
             broadcastState(room);
        }

        else if (msg.type === 'ACTION_LAST') {
            const room = rooms[currentRoom];
            if (!room) return;
            const p = room.gameState.players.find(pl => pl.id === myId);
            if (p) p.lastDeclared = true;
            broadcastState(room);
        }
    });

    ws.on('close', () => {
        if (currentRoom && rooms[currentRoom]) {
            const room = rooms[currentRoom];
            room.players = room.players.filter(p => p.id !== myId);
            if (room.players.length === 0) delete rooms[currentRoom];
            else broadcast(room, 'PLAYER_UPDATE', { names: room.players.map(p => p.name) });
        }
    });
});

function broadcast(room, type, data) {
    room.players.forEach(p => {
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify({ type, ...data }));
    });
}

function broadcastState(room) {
    room.players.forEach(p => {
        const safeState = JSON.parse(JSON.stringify(room.gameState));
        safeState.players.forEach(pl => {
            if (pl.id !== p.id) {
                pl.cardCount = pl.hand.length;
                pl.hand = []; 
            }
        });
        if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({ type: 'GAME_STATE', state: safeState, myId: p.id }));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
