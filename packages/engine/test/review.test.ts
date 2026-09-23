import { describe, expect, it } from 'vitest';
import { startPosition, tryMove, type AnalysisPacket, type Side } from '@sanyi/core';
import { buildReview, explain, audit } from '../src/browser.ts';

function fake(pos: ReturnType<typeof startPosition>, best: string, winrateForMover: number, visits = 100): AnalysisPacket {
  const mover = pos.toMove;
  const mk = (move: string, wr: number) => ({
    move,
    label: move,
    score: { kind: 'points' as const, lead: (wr - 0.5) * 20, side: mover as Side },
    winrate: wr,
    visits,
    share: 0.5,
    pv: [move],
  });
  return {
    game: 'go',
    meta: { backendId: 'fake', tier: 'native', strength: { band: 'max', measured: true, note: 'test' }, params: { visits }, engineVersion: 'test', elapsedMs: 1 },
    position: { key: 'k', sideToMove: mover, ply: pos.moves.length },
    candidates: [mk(best, winrateForMover), mk(best === 'PASS' ? 'A1' : 'PASS', Math.max(0.01, winrateForMover - 0.05))],
    tactics: [],
    flags: [],
    insufficiency: [],
    score: {},
  } as AnalysisPacket;
}

function posAfter(moves: string[]) {
  let p = startPosition();
  for (const m of moves) p = tryMove(p, m).position ?? p;
  return p;
}

// Black's winrate after each ply, chosen so the losses are obvious:
//   before move1 40% → after 40% (fine) → move3 costs 15pp → move5 costs 6pp
const GAME = ['D4', 'Q16', 'D16', 'C3', 'C17', 'E3'];
const BLACK_BY_PLY = [0.4, 0.4, 0.4, 0.25, 0.25, 0.19, 0.19];

function analyzeFor(log: string[]) {
  return async (moves: string[]) => {
    log.push(moves.join(','));
    const bw = BLACK_BY_PLY[moves.length] ?? 0.5;
    const pos = posAfter(moves);
    return fake(pos, moves.length % 2 === 0 ? 'F3' : 'F16', pos.toMove === 'black' ? bw : 1 - bw);
  };
}

describe('buildReview', () => {
  it('computes each move as (value before) - (value after) from the mover’s side', async () => {
    const calls: string[] = [];
    const b = await buildReview(GAME, analyzeFor(calls), { userColor: 'black', mode: 'learn' });
    const user = b.rows.filter((r) => r.by === 'user');
    expect(user.map((r) => r.vertex)).toEqual(['D4', 'D16', 'C17']);
    expect(user.map((r) => r.lossPp)).toEqual([0, 15, 6]);
    expect(user.map((r) => r.severity)).toEqual(['normal', 'blunder', 'soft']);
    expect(b.summary.avgLossPp).toBeCloseTo(7, 5);
    expect(b.summary.counts.blunder).toBe(1);
  });

  it('asks the engine once per position, and again only for counterfactuals', async () => {
    const calls: string[] = [];
    await buildReview(GAME, analyzeFor(calls), { userColor: 'black' });
    expect(calls.filter((c) => c === '')).toHaveLength(1); // the empty prefix searched once
    // The 15pp move triggers a "what if you had played its pick" search.
    expect(calls.some((c) => c.endsWith(',F3'))).toBe(true);
  });

  it('marks a move unmeasured when a position has no numbers rather than inventing zero', async () => {
    const b = await buildReview(GAME, async (moves) => {
      if (moves.length >= 3) throw new Error('engine down');
      return analyzeFor([])(moves);
    }, { userColor: 'black' });
    const third = b.rows.find((r) => r.vertex === 'C17')!;
    expect(third.lossPp).toBeNull();
    expect(third.severity).toBe('unmeasured');
    expect(b.gaps.length).toBeGreaterThan(0);
  });

  it('refuses to review an illegal record instead of silently truncating', async () => {
    await expect(buildReview(['D4', 'D4'], analyzeFor([]), { userColor: 'black' })).rejects.toThrow(/illegal move/);
  });
});

describe('explain over a review', () => {
  it('produces sentences that all survive the audit', async () => {
    const b = await buildReview(GAME, analyzeFor([]), { userColor: 'black', mode: 'learn' });
    const ex = explain(b, { minPpToShow: 4 });
    expect(ex.moves.map((m) => m.vertex)).toEqual(['D16', 'C17']);
    expect(ex.headline.some((s) => s.text.includes('平均每手亏'))).toBe(true);
    const res = audit(ex, b);
    expect(res.bad).toEqual([]);
    expect(res.total).toBeGreaterThan(8);
  });

  it('states the counterfactual only where one was actually searched', async () => {
    const b = await buildReview(GAME, analyzeFor([]), { userColor: 'black' });
    const ex = explain(b, { minPpToShow: 4 });
    const blunder = ex.moves.find((m) => m.vertex === 'D16')!;
    expect(blunder.sentences.some((s) => s.text.includes('如果这手改走'))).toBe(true);
    const soft = ex.moves.find((m) => m.vertex === 'C17')!;
    expect(soft.sentences.some((s) => s.text.includes('如果这手改走'))).toBe(false);
  });
});
