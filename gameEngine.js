export function createGame(names) {
  const game = {
    players: names.map(n => ({ name: n, hand: [], last: false })),
    deck: shuffle(deck()),
    discard: [],
    turn: 0,
    dir: 1,
    suit: null,
    draw: 0,
    skip: 0
  };

  for (let i = 0; i < 7; i++)
    game.players.forEach(p => p.hand.push(game.deck.pop()));

  while (true) {
    const c = game.deck.pop();
    if (!power(c.rank)) {
      game.discard.push(c);
      game.suit = c.suit;
      break;
    }
    game.deck.unshift(c);
  }

  game.publicState = () => ({
    players: game.players.map(p => ({
      name: p.name,
      count: p.hand.length,
      last: p.last
    })),
    top: game.discard.at(-1),
    suit: game.suit,
    turn: game.players[game.turn].name
  });

  return game;
}

export function handleAction(g, name, a) {
  const i = g.players.findIndex(p => p.name === name);
  if (i !== g.turn) return { error: "Not your turn" };

  const p = g.players[i];

  if (a.type === "last") {
    p.last = true;
    return {};
  }

  if (a.type === "draw") {
    draw(g, p, g.draw || 1);
    g.draw = 0;
    p.last = false;
    next(g);
    return {};
  }

  if (a.type === "play") {
    const cards = a.cards.map(x => p.hand[x]);
    if (!valid(g, p, cards)) return { error: "Illegal move" };

    cards.forEach(c => {
      p.hand.splice(p.hand.indexOf(c), 1);
      g.discard.push(c);
      apply(g, c);
    });

    const last = cards.at(-1);

    if (p.hand.length === 0 && power(last.rank)) {
      draw(g, p, 2);
      p.last = false;
      next(g);
      return {};
    }

    if (p.hand.length === 0) {
      g.winner = p.name;
      return {};
    }

    if (last.rank !== "A") g.suit = last.suit;
    next(g);
  }
}

function next(g) {
  g.turn = (g.turn + g.dir + g.players.length) % g.players.length;
}

function valid(g, p, cards) {
  if (p.hand.length - cards.length <= 1 && !p.last) return false;
  const f = cards[0], t = g.discard.at(-1);
  return f.rank === "A" || f.rank === t.rank || f.suit === g.suit;
}

function apply(g, c) {
  if (c.rank === "2") g.draw += 2;
  if (c.rank === "8") g.skip++;
  if (c.rank === "Q") g.dir *= -1;
}

function draw(g, p, n) {
  for (let i = 0; i < n; i++) {
    if (!g.deck.length) g.deck = shuffle(deck());
    p.hand.push(g.deck.pop());
  }
}

function power(r) {
  return ["A","2","8","J","Q","K"].includes(r);
}

function deck() {
  const s = ["♠","♥","♦","♣"];
  const r = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  return s.flatMap(x => r.map(y => ({ suit: x, rank: y })));
}

function shuffle(a) {
  return a.sort(() => Math.random() - 0.5);
}
