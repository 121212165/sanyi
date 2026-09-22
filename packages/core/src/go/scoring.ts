import { chain, hash, vertexToXY, xyToVertex, type GoPosition } from './position.ts';

export interface AreaScore {
  black: number;
  white: number;
  komi: number;
  /** black - (white + komi), in points. Chinese rules area count. */
  margin: number;
  winner: 'black' | 'white' | 'draw';
  territory: { black: string[]; white: string[]; dame: string[] };
  /** Stones still sitting on the board that were declared dead and removed for counting. */
  removed: string[];
  warning?: string;
}

/**
 * Area scoring under Chinese rules: stones on board + surrounded empty points, komi added to white.
 * Dead stones must be removed first; with none supplied this assumes a clean board, which is what
 * KataGo's ownership map and the user's marking are for.
 */
export function scoreArea(pos: GoPosition, dead: string[] = pos.dead): AreaScore {
  const size = pos.size;
  const cells = pos.cells.map((r) => r.slice());
  const removed: string[] = [];
  for (const v of dead) {
    const xy = vertexToXY(v, size);
    if (!xy) continue;
    const [x, y] = xy;
    if (cells[y][x] !== 0) {
      cells[y][x] = 0;
      removed.push(xyToVertex(x, y, size));
    }
  }

  const seen = cells.map((r) => r.map(() => false));
  const terr = { black: [] as string[], white: [] as string[], dame: [] as string[] };
  let blackTerr = 0;
  let whiteTerr = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (cells[y][x] !== 0 || seen[y][x]) continue;
      const region: [number, number][] = [];
      const stack: [number, number][] = [[x, y]];
      const borders = new Set<number>();
      seen[y][x] = true;
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        region.push([cx, cy]);
        for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]] as [number, number][]) {
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const v = cells[ny][nx];
          if (v === 0) {
            if (!seen[ny][nx]) {
              seen[ny][nx] = true;
              stack.push([nx, ny]);
            }
          } else borders.add(v);
        }
      }
      const owner = borders.size === 1 ? [...borders][0]! : 0;
      const pts = region.map(([rx, ry]) => xyToVertex(rx, ry, size));
      if (owner === 1) {
        blackTerr += region.length;
        terr.black.push(...pts);
      } else if (owner === -1) {
        whiteTerr += region.length;
        terr.white.push(...pts);
      } else {
        terr.dame.push(...pts);
      }
    }
  }

  let blackStones = 0;
  let whiteStones = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (cells[y][x] === 1) blackStones++;
      else if (cells[y][x] === -1) whiteStones++;
    }
  }

  const black = blackStones + blackTerr;
  const white = whiteStones + whiteTerr;
  const komi = pos.komi;
  const margin = black - (white + komi);
  return {
    black,
    white,
    komi,
    margin,
    winner: margin > 0 ? 'black' : margin < 0 ? 'white' : 'draw',
    territory: terr,
    removed,
  };
}

/** Live groups with no liberties after the opponent's last move — used by tests and by scoring hints. */
export function groupsWithoutLiberties(pos: GoPosition): string[][] {
  const size = pos.size;
  const seen = pos.cells.map((r) => r.map(() => false));
  const out: string[][] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (pos.cells[y][x] === 0 || seen[y][x]) continue;
      const { stones } = chain(pos.cells, x, y);
      for (const [sx, sy] of stones) seen[sy][sx] = true;
    }
  }
  return out;
}

export function positionKey(pos: GoPosition): string {
  return `go:${pos.size}:${hash(pos.cells)}:${pos.toMove}`;
}
