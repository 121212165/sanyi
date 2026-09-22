import { describe, expect, it } from 'vitest';
import { hash, legalVertices, startPosition, terminal, tryMove, xyToVertex, type GoPosition } from '../src/go/position.ts';
import { scoreArea } from '../src/go/scoring.ts';

/** Rows top-to-bottom; '#'=black, 'O'=white, '.'=empty. `prior` seeds the superko history. */
function fromDiagram(rows: string[], toMove: 'black' | 'white', prior: number[][][] = []): GoPosition {
  const size = rows.length;
  const cells = rows.map((r) => [...r].map((c) => (c === '#' ? 1 : c === 'O' ? -1 : 0)));
  if (cells.some((r) => r.length !== size)) throw new Error('diagram must be square');
  return {
    game: 'go',
    size,
    cells,
    toMove,
    firstMover: 'black',
    moves: [],
    setup: { black: [], white: [] },
    history: [...prior.map(hash), hash(cells)],
    passes: 0,
    captures: { black: 0, white: 0 },
    komi: 7.5,
    dead: [],
    result: null,
  };
}

const toCells = (rows: string[]) => rows.map((r) => [...r].map((c) => (c === '#' ? 1 : c === 'O' ? -1 : 0)));

function play(pos: GoPosition, ...vertices: string[]): GoPosition {
  let p = pos;
  for (const v of vertices) {
    const r = tryMove(p, v);
    if (!r.ok || !r.position) throw new Error(`test move ${v} rejected: ${r.reason}`);
    p = r.position;
  }
  return p;
}

/**
 * Side ko on a 5x5. C4 is the ko point, B4 the single black stone in atari.
 *   BEFORE           AFTER white plays C4 (capturing B4)
 *   . O # . .        . O # . .
 *   O # . # .   -->  O . O # .
 *   . O # . .        . O # . .
 * White's new stone has exactly one liberty (B4), so black recapturing at B4 reproduces BEFORE.
 */
const KO_BEFORE = ['.O#..', 'O#.#.', '.O#..', '.....', '.....'];
const KO_AFTER = ['.O#..', 'O.O#.', '.O#..', '.....', '.....'];

describe('vertices', () => {
  it('maps coordinates the way GTP does', () => {
    expect(xyToVertex(3, 15, 19)).toBe('D4');
    expect(xyToVertex(0, 0, 19)).toBe('A19');
    expect(xyToVertex(18, 18, 19)).toBe('T1');
  });

  it('offers every point plus pass on an empty 19x19, skipping the letter I', () => {
    const moves = legalVertices(startPosition());
    expect(moves).toHaveLength(362);
    expect(moves).toContain('PASS');
    expect(moves).toContain('D4');
    expect(moves).toContain('T19');
    expect(moves).not.toContain('I4');
  });

  it('rejects occupied points and off-board vertices', () => {
    const p = play(startPosition({ size: 9 }), 'E5');
    expect(tryMove(p, 'E5').reason).toBe('occupied');
    expect(tryMove(p, 'K9').reason).toBe('off-board'); // 9x9 columns run A..J, I skipped
    expect(tryMove(p, 'Z1').reason).toBe('off-board');
  });
});

describe('captures and suicide', () => {
  it('captures a surrounded stone and credits the capture', () => {
    const p = fromDiagram(['.O.', 'O#O', '...'], 'white');
    const r = tryMove(p, 'B1');
    expect(r.ok).toBe(true);
    expect(r.position!.cells[1][1]).toBe(0);
    expect(r.position!.captures.white).toBe(1);
  });

  it('forbids suicide', () => {
    const p = fromDiagram(['...', 'O..', '.OO'], 'black');
    const r = tryMove(p, 'A1');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('suicide');
  });

  it('allows a move that would be suicide but captures instead', () => {
    // White's two stones share exactly one liberty at A3; black filling it captures rather than self-killing.
    const p = fromDiagram(['.O#', 'O#.', '#..'], 'black');
    const r = tryMove(p, 'A3');
    expect(r.ok).toBe(true);
    expect(r.position!.captures.black).toBe(2);
    expect(r.position!.cells[0][0]).toBe(1);
    expect(r.position!.cells[0][1]).toBe(0);
    expect(r.position!.cells[1][0]).toBe(0);
  });
});

describe('ko and positional superko', () => {
  it('lets white take the ko', () => {
    const p = fromDiagram(KO_BEFORE, 'white');
    const r = tryMove(p, 'C4');
    expect(r.ok).toBe(true);
    expect(r.position!.cells.map((row) => row.join(''))).toEqual(toCells(KO_AFTER).map((row) => row.join('')));
    expect(r.position!.captures.white).toBe(1);
  });

  it('rejects an immediate recapture that repeats a previous position', () => {
    const p = fromDiagram(KO_AFTER, 'black', [toCells(KO_BEFORE)]);
    const r = tryMove(p, 'B4');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('superko');
  });

  it('allows the ko point once the board has changed elsewhere', () => {
    const p = fromDiagram(KO_AFTER, 'black', [toCells(KO_BEFORE)]);
    expect(tryMove(p, 'B4').reason).toBe('superko');
    const after = play(p, 'E1', 'A1'); // black threat, white answer
    expect(tryMove(after, 'B4').ok).toBe(true);
  });

  it('has nothing to forbid when the position is not in history', () => {
    expect(tryMove(fromDiagram(KO_AFTER, 'black'), 'B4').ok).toBe(true);
  });
});

describe('game end', () => {
  it('ends after two passes', () => {
    const p = play(startPosition({ size: 9 }), 'PASS', 'PASS');
    expect(terminal(p)).toEqual({ over: true, reason: 'two-passes' });
    expect(terminal(startPosition())).toBeNull();
  });

  it('resets the pass counter on a real move', () => {
    expect(play(startPosition({ size: 9 }), 'PASS', 'E5').passes).toBe(0);
  });
});

describe('area scoring (Chinese rules)', () => {
  it('counts stones plus enclosed points, then komi', () => {
    const s = scoreArea(fromDiagram(['#####', '#...#', '#...#', '#...#', '#####'], 'white'));
    expect(s.black).toBe(16 + 9); // perimeter stones + the enclosed 3x3
    expect(s.white).toBe(0);
    expect(s.margin).toBeCloseTo(25 - 7.5, 5);
    expect(s.winner).toBe('black');
  });

  it('gives an open region to the only colour bordering it', () => {
    const s = scoreArea(fromDiagram(['#O...', '#O...', '#O...', '#O...', '#O...'], 'black'));
    expect(s.black).toBe(5);
    expect(s.white).toBe(5 + 15);
    expect(s.winner).toBe('white');
  });

  it('treats regions touching both colours as dame', () => {
    const s = scoreArea(fromDiagram(['#O.', '...', '.O#'], 'black'));
    expect(s.territory.dame).toHaveLength(5);
    expect(s.territory.black).toHaveLength(0);
    expect(s.margin).toBeCloseTo(2 - (2 + 7.5), 5);
  });

  it('counts a conceded dead stone as the capturer’s area', () => {
    const p = fromDiagram(['##...', '#O#..', '##...', '.....', '.....'], 'black');
    const alive = scoreArea(p);
    expect(alive.black).toBe(24);
    expect(alive.white).toBe(1);
    const counted = scoreArea(p, ['B4']);
    expect(counted.black).toBe(25);
    expect(counted.white).toBe(0);
    expect(counted.removed).toEqual(['B4']);
  });
});
