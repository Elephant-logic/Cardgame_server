let WS = null;
let mySeat = null;
let room = null;
let view = null;

let selected = []; // indices in your hand, in order

function toast(msg){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(toast._tm);
  toast._tm = setTimeout(()=> t.style.display = "none", 1800);
}

function show(id){
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function wsUrl(){
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function connect(){
  return new Promise((resolve, reject) => {
    if (WS && (WS.readyState === 0 || WS.readyState === 1)) return resolve();
    WS = new WebSocket(wsUrl());
    WS.addEventListener("open", () => resolve(), { once:true });
    WS.addEventListener("error", () => reject(), { once:true });

    WS.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === "toast") toast(msg.msg || "!");
      if (msg.type === "name_ok"){
        document.getElementById("meName").textContent = msg.name;
        show("screen-menu");
      }
      if (msg.type === "room_created"){
        room = msg.room;
        mySeat = msg.seat;
        renderOnline();
      }
      if (msg.type === "room_joined"){
        room = msg.room;
        mySeat = msg.seat;
        renderOnline();
      }
      if (msg.type === "state"){
        room = msg.room;
        view = msg.view;
        if (room.started) show("screen-game");
        renderOnline();
        renderGame();
      }
    });
  });
}

function send(obj){
  if (!WS || WS.readyState !== 1) return toast("Not connected.");
  WS.send(JSON.stringify(obj));
}

// ========================
// UI Wiring
// ========================
document.getElementById("btn-enter").onclick = async () => {
  const name = (document.getElementById("name").value || "").trim();
  if (!name) return toast("Enter name.");
  await connect();
  send({ type:"set_name", name });
};

document.getElementById("btn-online").onclick = async () => {
  await connect();
  show("screen-online");
};

document.getElementById("btn-offline").onclick = () => {
  toast("Offline test not included in this WS build yet.");
};

document.getElementById("btn-back").onclick = () => show("screen-menu");

document.getElementById("btn-create").onclick = async () => {
  await connect();
  send({ type:"create_room" });
};

document.getElementById("btn-join").onclick = async () => {
  await connect();
  const code = (document.getElementById("joinCode").value || "").trim().toUpperCase();
  if (!code) return toast("Paste a code.");
  send({ type:"join_room", code });
};

document.getElementById("btn-deal").onclick = () => {
  send({ type:"start_game" });
};

document.getElementById("btn-draw").onclick = () => send({ type:"action", action:"draw" });
document.getElementById("btn-last").onclick = () => send({ type:"action", action:"last" });
document.getElementById("btn-play").onclick = () => {
  if (!selected.length) return;
  send({ type:"action", action:"play", indices: selected });
  selected = [];
  renderGame();
};

document.getElementById("drawPile").onclick = () => send({ type:"action", action:"draw" });

document.querySelectorAll(".suit").forEach(btn => {
  btn.onclick = () => {
    const s = btn.dataset.s;
    hideSuitModal();
    send({ type:"action", action:"ace", suit: s });
  };
});

function showSuitModal(){ document.getElementById("modal-suit").classList.add("show"); }
function hideSuitModal(){ document.getElementById("modal-suit").classList.remove("show"); }

// ========================
// Render
// ========================
function renderOnline(){
  const codeEl = document.getElementById("roomCode");
  const statusEl = document.getElementById("roomStatus");
  const playersEl = document.getElementById("players");
  const dealBtn = document.getElementById("btn-deal");

  if (!room){
    codeEl.textContent = "—";
    statusEl.textContent = "Not in a room.";
    playersEl.innerHTML = "";
    dealBtn.disabled = true;
    return;
  }

  codeEl.textContent = room.code;
  statusEl.textContent = room.started ? "Game started." : "Waiting in lobby…";
  playersEl.innerHTML = "";

  room.players.forEach(p => {
    const div = document.createElement("div");
    div.className = "other";
    div.innerHTML = `<span>${p.seat === mySeat ? "👉 " : ""}${p.name}</span><span>${p.connected ? "✅" : "❌"}</span>`;
    playersEl.appendChild(div);
  });

  dealBtn.disabled = !(mySeat === 0 && !room.started && room.players.length >= 2);
}

function renderGame(){
  if (!view || !room || !room.started) return;

  document.getElementById("feed").textContent = view.feed || "";
  const myTurn = (view.turn === view.you.seat) && (view.awaitingAceSeat === null);

  let atk = "";
  if (view.pendingDraw2) atk = `DRAW +${view.pendingDraw2} (2 stack)`;
  else if (view.pendingDrawJ) atk = `DRAW +${view.pendingDrawJ} (J stack)`;
  else if (view.pendingSkip) atk = `SKIP x${view.pendingSkip} (8 stack)`;

  document.getElementById("turnText").textContent = myTurn ? "YOUR TURN" : `Waiting… (Turn: ${view.turn})`;
  document.getElementById("attackText").textContent = atk;

  const top = view.top;
  document.getElementById("topCard").textContent = top ? `${top.rank}${top.suit}` : "—";
  document.getElementById("activeSuit").textContent = view.activeSuit || "—";

  const others = document.getElementById("others");
  others.innerHTML = "";
  view.others.forEach(o => {
    const div = document.createElement("div");
    div.className = "other";
    div.innerHTML = `<span>${o.seat === view.turn ? "⭐ " : ""}${o.name}</span><span>${o.count} cards</span>`;
    others.appendChild(div);
  });

  const handEl = document.getElementById("hand");
  handEl.innerHTML = "";
  (view.you.hand || []).forEach((c, idx) => {
    const div = document.createElement("div");
    div.className = "card" + ((c.suit === "♥" || c.suit === "♦") ? " red" : "") + (selected.includes(idx) ? " sel" : "");
    div.innerHTML = `<div class="corner">${c.rank}${c.suit}</div><div class="mid">${c.suit}</div>`;
    div.onclick = () => {
      if (!myTurn) return;
      const i = selected.indexOf(idx);
      if (i >= 0) selected.splice(i, 1);
      else selected.push(idx);
      renderGame();
      renderControls();
    };
    handEl.appendChild(div);
  });

  if (view.awaitingAceSeat === view.you.seat){
    showSuitModal();
  } else {
    hideSuitModal();
  }

  renderControls();
}

function renderControls(){
  if (!view || !room || !room.started) return;
  const myTurn = (view.turn === view.you.seat) && (view.awaitingAceSeat === null);
  document.getElementById("btn-play").disabled = !myTurn || selected.length === 0;
  document.getElementById("btn-draw").disabled = !myTurn;
  document.getElementById("btn-last").disabled = !myTurn;
}

show("screen-login");
