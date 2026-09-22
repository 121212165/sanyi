import { chain, hash, startPosition, tryMove, vertexToXY, xyToVertex, type GoPosition } from './position.ts';

/**
 * Facts about a single move, computed from the rules only — nothing here is inferred from an
 * evaluation, so every field can be shown to the player as "this happened on the board".
 */
export interface MoveFacts {
  ply: number;
  vertex: string;
  color: 'black' | 'white';
  /** Stones of the opponent this move took off the board. */
  capturedByMove: number;
  /** Liberties of the stone's group once this move's captures are done. */
  libertiesAfter: number;
  /** Size of the group the played stone joined. */
  groupSize: number;
  /** True when the group was left with exactly one liberty. */
  inAtari: boolean;
  /** Enemy chains standing next to the played stone, with their sizes. */
  touchedEnemy: number[];
  /** Friendly chains next to the played stone, with their sizes. */
  touchedFriend: number[];
  /** Fate of the exact points this move put down, followed to the end of the record. */
  fate: GroupFate;
  /** Did the opponent answer within three lines of this stone? */
  answeredLocally: boolean;
  /** Ply at which the opponent's reply landed, if any. */
  replyPly: number | null;
  replyVertex: string | null;
}

export interface GroupFate {
  /** Intersections the played stone's group occupied right after the move. */
  points: string[];
  /** All of them gone (captured) at some later point. */
  died: boolean;
  /** Ply of the move that removed the last of them. */
  diedAtPly: number | null;
  /** How many of the original points were captured before the game ended. */
  stonesLost: number;
  /** The capturing move, when known. */
  killedBy: string | null;
  survivedToEnd: boolean;
}

function applyAll(moves: string[], size: number): GoPosition[] {
  let pos = startPosition({ size });
  const out: GoPosition[] = [pos];
  for (const m of moves) {
    const r = tryMove(pos, m);
    if (!r.ok || !r.position) break;
    pos = r.position;
    out.push(pos);
  }
  return out;
}

function chainsAround(pos: GoPosition, x: number, y: number): { enemy: number[]; friend: number[] } {
  const size = pos.size;
  const sign = pos.cells[y]?.[x];
  const enemy: number[] = [];
  const friend: number[] = [];
  if (!sign) return { enemy, friend };
  const seenEnemy = new Set<string>();
  const seenFriend = new Set<string>();
  for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as [number, number][]) {
    if (!pos.cells[ny] || pos.cells[ny][nx] === undefined) continue;
    const v = pos.cells[ny][nx];
    if (v === 0) continue;
    const key = `${nx},${ny}`;
    if (v === sign) {
      if (seenFriend.has(key)) continue;
      for (const [sx, sy] of chain(pos.cells, nx, ny).stones) seenFriend.add(`${sx},${sy}`);
      friend.push(chain(pos.cells, nx, ny).stones.length);
    } else {
      if (seenEnemy.has(key)) continue;
      for (const [sx, sy] of chain(pos.cells, nx, ny).stones) seenEnemy.add(`${sx},${sy}`);
      enemy.push(chain(pos.cells, nx, ny).stones.length);
    }
  }
  return { enemy, friend };
}

/** Follows the points this move placed until the end of the record. */
export function traceGroup(positions: GoPosition[], ply: number, vertex: string): GroupFate {
  const after = positions[ply + 1];
  const size = after.size;
  const xy = vertexToXY(vertex, size);
  const empty: GroupFate = { points: [], died: false, diedAtPly: null, stonesLost: 0, killedBy: null, survivedToEnd: true };
  if (!xy) return empty;
  const sign = after.cells[xy[1]][xy[0]];
  if (!sign) return empty;
  const points = chain(after.cells, xy[0], xy[1]).stones.map(([x, y]) => xyToVertex(x, y, size));
  const wanted = new Set(points);

  let lost = 0;
  let diedAtPly: number | null = null;
  let killedBy: string | null = null;
  for (let p = ply + 2; p < positions.length; p++) {
    const pos = positions[p];
    let goneThisPly = 0;
    for (const v of wanted) {
      const c = vertexToXY(v, size);
      if (!c) continue;
      if (pos.cells[c[1]][c[0]] !== sign) goneThisPly++;
    }
    if (goneThisPly > lost) {
      lost = goneThisPly;
      killedBy = pos.moves[p - 1] ?? null;
    }
    if (lost === points.length) {
      diedAtPly = p - 1;
      break;
    }
  }
  return {
    points,
    died: lost === points.length && lost > 0,
    diedAtPly,
    stonesLost: lost,
    killedBy,
    survivedToEnd: lost === 0,
  };
}

function near(a: string, b: string, size: number, radius: number): boolean {
  const [ax, ay] = vertexToXY(a, size) ?? [-1, -1];
  const [bx, by] = vertexToXY(b, size) ?? [-1, -1];
  return Math.abs(ax - bx) + Math.abs(ay - by) <= radius;
}

/** Facts for every move of a recorded game. `moves` are engine-native vertices ('D4', 'PASS'). */
export function analyzeMoves(moves: string[], size = 19): MoveFacts[] {
  const positions = applyAll(moves, size);
  const out: MoveFacts[] = [];
  for (let ply = 0; ply + 1 < positions.length; ply++) {
    const before = positions[ply]!;
    const after = positions[ply + 1]!;
    const vertex = moves[ply]!;
    const mover = before.toMove;
    const xy = vertexToXY(vertex, size);
    if (!xy) {
      out.push({
        ply, vertex, color: mover, capturedByMove: 0, libertiesAfter: 0, groupSize: 0, inAtari: false,
        touchedEnemy: [], touchedFriend: [], fate: { points: [], died: false, diedAtPly: null, stonesLost: 0, killedBy: null, survivedToEnd: true },
        answeredLocally: false, replyPly: null, replyVertex: null,
      });
      continue;
    }
    const capBefore = before.captures[mover];
    const capAfter = after.captures[mover];
    const { enemy, friend } = chainsAround(after, xy[0], xy[1]);
    const grp = chain(after.cells, xy[0], xy[1]);
    const reply = moves[ply + 1] ?? null;
    out.push({
      ply,
      vertex,
      color: mover,
      capturedByMove: capAfter - capBefore,
      libertiesAfter: grp.liberties,
      groupSize: grp.stones.length,
      inAtari: grp.liberties === 1,
      touchedEnemy: enemy,
      touchedFriend: friend,
      fate: traceGroup(positions, ply, vertex),
      answeredLocally: reply ? near(vertex, reply, size, 4) : false,
      replyPly: reply ? ply + 1 : null,
      replyVertex: reply,
    });
  }
  return out;
}

/** Compact enough to print next to a sentence; useful for spotting stale records. */
export function positionSignature(pos: GoPosition): string {
  return `${hash(pos.cells).length}:${pos.moves.length}`;
}
