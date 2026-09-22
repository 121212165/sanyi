import type { Side } from '../types.ts';

export const LETTERS = 'ABCDEFGHJKLMNOPQRSTUVWXYZ'; // GTP skips I

/** y is row index from the TOP (0) — GTP numbers rows from the bottom, hence the flip. */
export function vertexToXY(vertex: string, size: number): [number, number] | null {
  const v = vertex.trim().toUpperCase();
  if (v === 'PASS' || v === 'PA') return null;
  const col = LETTERS.indexOf(v[0] ?? '');
  const row = Number(v.slice(1));
  if (col < 0 || !Number.isInteger(row) || row < 1 || row > size) return null;
  const y = size - row;
  if (col >= size || y < 0 || y >= size) return null;
  return [col, y];
}

export function xyToVertex(x: number, y: number, size: number): string {
  return `${LETTERS[x] ?? '?'}${size - y}`;
}

export interface GoPosition {
  game: 'go';
  size: number;
  /** cells[y][x]: 0 empty, 1 black, -1 white. y=0 is the top row. */
  cells: number[][];
  toMove: Side;
  /** Who plays the first move of the game — colours strictly alternate from here. */
  firstMover: Side;
  /** Move strings played this game, 'PASS' included. */
  moves: string[];
  /** Board hash after every move (index 0 = empty board), for positional superko. */
  history: string[];
  /** Stones placed before the first move (handicap, SGF AB/AW). Not moves, so colours don't alternate over them. */
  setup: { black: string[]; white: string[] };
  /** Consecutive passes before the current position. */
  passes: number;
  captures: { black: number; white: number };
  komi: number;
  /** Stones the player has conceded as dead; only used for scoring. */
  dead: string[];
  result: null | { winner: Side | 'draw'; method: 'resign' | 'score' | 'timeout' | 'forfeit'; margin?: string };
}

export function emptyCells(size: number): number[][] {
  return Array.from({ length: size }, () => new Array<number>(size).fill(0));
}

export function startPosition(opts: { size?: number; komi?: number; handicap?: number } = {}): GoPosition {
  const size = opts.size ?? 19;
  const komi = opts.komi ?? 7.5;
  const pos: GoPosition = {
    game: 'go',
    size,
    cells: emptyCells(size),
    toMove: 'black',
    firstMover: 'black',
    moves: [],
    history: [],
    setup: { black: [], white: [] },
    passes: 0,
    captures: { black: 0, white: 0 },
    komi,
    dead: [],
    result: null,
  };
  pos.history = [hash(pos.cells)];
  const h = opts.handicap ?? 0;
  if (h >= 2) {
    const m = size >= 13 ? 3 : 2;
    const c = Math.floor(size / 2);
    const f = size - 1 - m;
    const corners: [number, number][] = [[m, f], [f, m], [f, f], [m, m]];
    const sides: [number, number][] = [[m, c], [f, c], [c, m], [c, f]];
    const center: [number, number][] = [[c, c]];
    const order: [number, number][] = [
      ...corners.slice(0, Math.min(h, 4)),
      ...(h >= 6 ? sides.slice(0, Math.min(h - 4, 4)) : []),
      ...(h === 5 || h === 7 || h === 9 ? center : []),
    ];
    for (const [x, y] of order.slice(0, h)) {
      pos.cells[y][x] = 1;
      pos.setup.black.push(xyToVertex(x, y, size));
    }
    // The handicap stones are setup, not moves: white opens the play.
    pos.history = [hash(pos.cells)];
    pos.toMove = 'white';
    pos.firstMover = 'white';
  }
  return pos;
}

export function hash(cells: number[][]): string {
  return cells.map((r) => r.join('')).join('/');
}

export function clone(pos: GoPosition): GoPosition {
  return {
    ...pos,
    cells: pos.cells.map((r) => r.slice()),
    moves: pos.moves.slice(),
    history: pos.history.slice(),
    captures: { ...pos.captures },
    dead: pos.dead.slice(),
    setup: { black: pos.setup.black.slice(), white: pos.setup.white.slice() },
  };
}

function neighbors(x: number, y: number, size: number): [number, number][] {
  const out: [number, number][] = [];
  if (x > 0) out.push([x - 1, y]);
  if (x < size - 1) out.push([x + 1, y]);
  if (y > 0) out.push([x, y - 1]);
  if (y < size - 1) out.push([x, y + 1]);
  return out;
}

export function chain(cells: number[][], x: number, y: number): { stones: [number, number][]; liberties: number } {
  const sign = cells[y]?.[x];
  if (sign === undefined || sign === 0) return { stones: [], liberties: 0 };
  const size = cells.length;
  const seen = new Set<string>([`${x},${y}`]);
  const stack: [number, number][] = [[x, y]];
  const lib = new Set<string>();
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    for (const [nx, ny] of neighbors(cx, cy, size)) {
      const v = cells[ny][nx];
      if (v === 0) lib.add(`${nx},${ny}`);
      else if (v === sign && !seen.has(`${nx},${ny}`)) {
        seen.add(`${nx},${ny}`);
        stack.push([nx, ny]);
      }
    }
  }
  return { stones: [...seen].map((s) => s.split(',').map(Number) as [number, number]), liberties: lib.size };
}

export interface MoveOutcome {
  ok: boolean;
  reason?: 'occupied' | 'off-board' | 'suicide' | 'superko';
  position?: GoPosition;
}

/** Applies a stone with captures, suicide and positional-superko enforcement. */
export function tryMove(pos: GoPosition, vertex: string): MoveOutcome {
  if (pos.result) return { ok: false, reason: 'off-board' };
  if (vertex.toUpperCase() === 'PASS') {
    const next = clone(pos);
    next.moves.push('PASS');
    next.history.push(hash(next.cells));
    next.passes += 1;
    next.toMove = pos.toMove === 'black' ? 'white' : 'black';
    return { ok: true, position: next };
  }
  const xy = vertexToXY(vertex, pos.size);
  if (!xy) return { ok: false, reason: 'off-board' };
  const [x, y] = xy;
  if (pos.cells[y][x] !== 0) return { ok: false, reason: 'occupied' };

  const sign = pos.toMove === 'black' ? 1 : -1;
  const opp = -sign as 1 | -1;
  const cells = pos.cells.map((r) => r.slice());
  cells[y][x] = sign;
  let captured = 0;
  for (const [nx, ny] of neighbors(x, y, pos.size)) {
    if (cells[ny][nx] === opp) {
      const c = chain(cells, nx, ny);
      if (c.liberties === 0) {
        captured += c.stones.length;
        for (const [sx, sy] of c.stones) cells[sy][sx] = 0;
      }
    }
  }
  if (captured === 0 && chain(cells, x, y).liberties === 0) return { ok: false, reason: 'suicide' };
  const h = hash(cells);
  if (pos.history.includes(h)) return { ok: false, reason: 'superko' };

  const next = clone(pos);
  next.cells = cells;
  next.moves.push(xyToVertex(x, y, pos.size));
  next.history.push(h);
  next.passes = 0;
  if (sign === 1) next.captures.black += captured;
  else next.captures.white += captured;
  next.toMove = sign === 1 ? 'white' : 'black';
  return { ok: true, position: next };
}

export function legalVertices(pos: GoPosition): string[] {
  const out: string[] = ['PASS'];
  for (let y = 0; y < pos.size; y++) {
    for (let x = 0; x < pos.size; x++) {
      if (pos.cells[y][x] !== 0) continue;
      if (tryMove(pos, xyToVertex(x, y, pos.size)).ok) out.push(xyToVertex(x, y, pos.size));
    }
  }
  return out;
}

/** Two passes end the game; the score still has to be settled (dead stones). */export function terminal(pos: GoPosition): { over: boolean; reason?: string } | null {
  if (pos.result) return { over: true, reason: 'finished' };
  if (pos.passes >= 2) return { over: true, reason: 'two-passes' };
  return null;
}
