import { describe, expect, it } from 'vitest';
import { audit, explain, resolvePath } from '../src/explain.ts';
import type { ReviewBundle } from '../src/review.ts';

function row(over: Partial<ReviewBundle['rows'][number]> = {}): ReviewBundle['rows'][number] {
  return {
    ply: 0,
    moveNumber: 1,
    vertex: 'D4',
    color: 'black',
    by: 'user',
    facts: {
      ply: 0, vertex: 'D4', color: 'black', capturedByMove: 0, libertiesAfter: 4, groupSize: 1, inAtari: false,
      touchedEnemy: [], touchedFriend: [], answeredLocally: false, replyPly: null, replyVertex: null,
      fate: { points: ['D4'], died: false, diedAtPly: null, stonesLost: 0, killedBy: null, survivedToEnd: true },
    },
    blackWinrateBefore: 0.4,
    blackWinrateAfter: 0.3,
    lossPp: 10,
    engineBest: 'Q4',
    enginePv: ['Q4', 'D16'],
    playedPv: [],
    playedVisits: null,
    visits: 80,
    severity: 'mistake',
    ...over,
  } as ReviewBundle['rows'][number];
}

const bundle = (rows: ReviewBundle['rows']): ReviewBundle =>
  ({
    game: 'test', mode: 'learn', timeControl: { kind: 'untimed' }, userColor: 'black', engine: undefined,
    size: 19, komi: 7.5, rows,
    summary: { userMoves: rows.length, measured: rows.length, avgLossPp: 10, medianLossPp: 10, counts: { unmeasured: 0, normal: 0, soft: 0, mistake: rows.length, blunder: 0 }, worst: [], userStonesLost: 0, userCaptures: 0 },
    gaps: [],
  }) as ReviewBundle;

describe('resolvePath', () => {
  it('walks arrays and objects', () => {
    const b = bundle([row()]);
    expect(resolvePath(b, 'rows[0].facts.capturedByMove')).toBe(0);
    expect(resolvePath(b, 'summary.avgLossPp')).toBe(10);
    expect(resolvePath(b, 'rows[9].vertex')).toBeUndefined();
  });
});

describe('audit', () => {
  it('passes a review whose every sentence cites real fields', () => {
    const ex = explain(bundle([row()]), { minPpToShow: 4 });
    const res = audit(ex, bundle([row()]));
    expect(res.total).toBeGreaterThan(5);
    expect(res.bad).toEqual([]);
    expect(ex.moves[0]!.sentences.some((s) => s.text.includes('Q4'))).toBe(true);
  });

  it('catches a sentence that cites a field which is not there', () => {
    const ex = explain(bundle([row()]), { minPpToShow: 4 });
    ex.moves[0]!.sentences.push({ text: '它认为这手是必胜', evidence: ['rows[0].mateScore'], provenance: 'measured' });
    const res = audit(ex, bundle([row()]));
    expect(res.ok).toBe(false);
    expect(res.bad[0]!.path).toBe('rows[0].mateScore');
  });

  it('catches a sentence citing a field that exists but is null', () => {
    const ex = explain(bundle([row()]), { minPpToShow: 4 });
    // playedVisits exists on the row but is null: citing it would be inventing a number.
    ex.moves[0]!.sentences.push({ text: '它给这手分了 999 次访问', evidence: ['rows[0].playedVisits'], provenance: 'measured' });
    const res = audit(ex, bundle([row()]));
    expect(res.ok).toBe(false);
    expect(res.bad[0]!.reason).toMatch(/空/);
  });

  it('does not describe an unsearched move as a mistake', () => {
    const ex = explain(bundle([row({ lossPp: null, severity: 'unmeasured', blackWinrateAfter: null })]), { minPpToShow: 4 });
    expect(ex.moves).toHaveLength(0);
  });

  it('reports a captured group as a board fact with its killing move', () => {
    const dead = row({
      facts: { ...row().facts, fate: { points: ['D4', 'D5'], died: true, diedAtPly: 20, stonesLost: 2, killedBy: 'D6', survivedToEnd: false } },
    });
    const ex = explain(bundle([dead]), { minPpToShow: 4 });
    const text = ex.moves[0]!.sentences.map((s) => s.text).join(' ');
    expect(text).toContain('被全部提掉');
    expect(text).toContain('D6');
    expect(audit(ex, bundle([dead])).ok).toBe(true);
  });
});
