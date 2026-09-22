import { describe, expect, it } from 'vitest';
import { analyzeMoves } from '../src/go/facts.ts';

// 9x9. Black squeezes one white stone into atari and then takes it.
//   1.B D9   2.W E5   3.B C8   4.W C9 (one liberty left)   5.B B9 (captures C9)
const game = ['D9', 'E5', 'C8', 'C9', 'B9', 'A1'];
const facts = analyzeMoves(game, 9);

describe('move facts', () => {
  it('reports the stone that was put into atari', () => {
    const w = facts[3]!;
    expect([w.vertex, w.color]).toEqual(['C9', 'white']);
    expect(w.groupSize).toBe(1);
    expect(w.libertiesAfter).toBe(1);
    expect(w.inAtari).toBe(true);
    expect(w.touchedEnemy).toEqual([1, 1]); // D9 and C8 are diagonal, so two separate chains
    expect(w.capturedByMove).toBe(0);
  });

  it('follows that group to its death and names the killing move', () => {
    const w = facts[3]!;
    expect(w.fate.points).toEqual(['C9']);
    expect(w.fate.died).toBe(true);
    expect(w.fate.stonesLost).toBe(1);
    expect(w.fate.diedAtPly).toBe(4);
    expect(w.fate.killedBy).toBe('B9');
    expect(w.fate.survivedToEnd).toBe(false);
  });

  it('counts what a move captured', () => {
    const b = facts[4]!;
    expect(b.vertex).toBe('B9');
    expect(b.capturedByMove).toBe(1);
    expect(b.color).toBe('black');
  });

  it('marks groups that were never touched as surviving', () => {
    expect(facts[0]!.vertex).toBe('D9');
    expect(facts[0]!.fate.survivedToEnd).toBe(true);
    expect(facts[0]!.fate.died).toBe(false);
  });

  it('says whether the reply came locally', () => {
    expect(facts[3]!.answeredLocally).toBe(true); // B9 answers right next to C9
    expect(facts[1]!.replyVertex).toBe('C8');
    expect(facts[1]!.answeredLocally).toBe(false); // E5 and C8 are 5 lines apart, that is not a local answer
  });

  it('handles pass and a truncated record without inventing facts', () => {
    const withPass = analyzeMoves(['PASS', 'PASS'], 9);
    expect(withPass).toHaveLength(2);
    expect(withPass[0]!.fate.points).toEqual([]);
    expect(withPass[0]!.groupSize).toBe(0);
    expect(analyzeMoves([], 9)).toEqual([]);
  });

  it('tracks a whole group, not just the stone played', () => {
    // Black builds a two-stone chain, white takes one of them later; the fate must list both points.
    const seq = ['D9', 'E5', 'C9', 'A1', 'B9', 'A2'];
    const f = analyzeMoves(seq, 9);
    const c9 = f.find((x) => x.vertex === 'C9' && x.color === 'black')!;
    expect(c9.fate.points.sort()).toEqual(['C9', 'D9']);
    expect(c9.groupSize).toBe(2);
  });
});
