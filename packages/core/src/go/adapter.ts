import type { GameAdapter, Side } from '../types.ts';
import { legalVertices, startPosition, terminal, tryMove, type GoPosition } from './position.ts';
import { positionKey, scoreArea, type AreaScore } from './scoring.ts';
import { toSgf } from './sgf.ts';

/** Move type for Go is just the engine-native GTP-ish vertex string: 'D4' | 'PASS'. */
export const goAdapter: GameAdapter<GoPosition, string> = {
  game: 'go',
  start: () => startPosition({ size: 19, komi: 7.5 }),
  legalMoves: (p) => legalVertices(p),
  isLegal: (p, m) => tryMove(p, m).ok,
  apply: (p, m) => {
    const r = tryMove(p, m);
    if (!r.ok || !r.position) throw new Error(`illegal Go move ${m}: ${r.reason}`);
    return r.position;
  },
  terminal: (p) => {
    const t = terminal(p);
    return t ? { over: true, result: p.result ? formatResult(p.result) : undefined, reason: t.reason } : null;
  },
  sideToMove: (p) => p.toMove as Side,
  canonicalKey: (p) => positionKey(p),
  formatMove: (_p, m) => m,
  parseMove: (_p, raw) => (raw ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '') : null),
  serialize: (p, history) => {
    const colorAt = (i: number): 'B' | 'W' => {
      const flip = i % 2 === 1;
      const black = p.firstMover === 'black' ? !flip : flip;
      return black ? 'B' : 'W';
    };
    return toSgf(
      history.map((m, i) => ({ color: colorAt(i), vertex: m })),
      { size: p.size, komi: p.komi, result: p.result ? formatResult(p.result) : undefined },
    );
  },
};

export function formatResult(r: NonNullable<GoPosition['result']>): string {
  if (r.winner === 'draw') return 'Draw';
  const side = r.winner === 'black' ? 'B' : 'W';
  return r.method === 'resign' ? `${side}+R` : r.method === 'timeout' ? `${side}+T` : `${side}+${r.margin ?? '0'}`;
}

export function score(p: GoPosition, dead?: string[]): AreaScore {
  return scoreArea(p, dead);
}

export function resign(p: GoPosition, loser: Side): GoPosition {
  return { ...p, result: { winner: loser === 'black' ? 'white' : 'black', method: 'resign' } };
}
