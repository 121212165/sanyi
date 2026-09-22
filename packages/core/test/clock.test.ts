import { describe, expect, it } from 'vitest';
import { BLITZ_PRESETS, formatRemaining, initialClock, playedMove, remainingNow, type TimeControl } from '../src/clock.ts';

const blitz: TimeControl = { kind: 'blitz', baseMs: 10_000, incMs: 2_000, delayMs: 0 };
const delayed: TimeControl = { kind: 'blitz', baseMs: 10_000, incMs: 0, delayMs: 3_000 };
const byo: TimeControl = { kind: 'byoyomi', mainMs: 5_000, periods: 2, periodMs: 1_000 };

describe('blitz clock', () => {
  it('charges thinking time and grants the increment', () => {
    let s = initialClock(blitz, 'black', 1_000);
    s = playedMove(s, blitz, 4_000); // 3s spent
    expect(s.main.black).toBe(10_000 - 3_000 + 2_000);
    expect(s.toMove).toBe('white');
    expect(s.anchorAt).toBe(4_000);
  });

  it('loses the game on flag fall', () => {
    let s = initialClock(blitz, 'black', 0);
    s = playedMove(s, blitz, 12_000);
    expect(s.finished).toEqual({ winner: 'white', reason: 'timeout' });
  });

  it('does not charge time inside the delay window, per move', () => {
    let s = initialClock(delayed, 'black', 0);
    s = playedMove(s, delayed, 2_000); // black's 2s sits entirely inside its 3s delay
    expect(s.main.black).toBe(10_000);
    s = playedMove(s, delayed, 2_500); // white's move
    expect(s.main.white).toBe(10_000);
    s = playedMove(s, delayed, 7_500); // black spent 5s, 3s delayed
    expect(s.main.black).toBe(8_000);
  });

  it('counts down from the bridge anchor for display', () => {
    const s = initialClock(blitz, 'black', 1_000);
    expect(remainingNow(s, blitz, 3_500)).toBe(10_000 - 2_500);
    expect(remainingNow(s, { kind: 'untimed' }, 3_500)).toBe(Number.POSITIVE_INFINITY);
  });

  it('never advances when the browser claims time travelled backwards', () => {
    const s = initialClock(blitz, 'black', 5_000);
    const next = playedMove(s, blitz, 4_000);
    expect(next.main.black).toBe(10_000 + 2_000);
  });
});

describe('byo-yomi clock', () => {
  it('spends main time first, then carries the overage into periods', () => {
    let s = initialClock(byo, 'black', 0);
    s = playedMove(s, byo, 4_000); // black 4s of main
    expect(s.main.black).toBe(1_000);
    expect(s.toMove).toBe('white');
    s = playedMove(s, byo, 4_500); // white 0.5s
    expect(s.main.white).toBe(4_500);
    s = playedMove(s, byo, 6_000); // black 1.5s: main, then 0.5s of a period
    expect(s.main.black).toBe(0);
    expect(s.periodLeft.black).toBe(500);
    expect(s.periods.black).toBe(2);
    s = playedMove(s, byo, 6_100); // white
    s = playedMove(s, byo, 6_300); // black spends the rest of that period's clock
    expect(s.periodLeft.black).toBe(300);
    expect(s.periods.black).toBe(2);
  });

  it('loses when the last period expires', () => {
    let s = initialClock(byo, 'black', 0);
    s = playedMove(s, byo, 5_000); // main time used exactly
    expect(s.main.black).toBe(0);
    expect(s.periods.black).toBe(2);
    for (let i = 0; i < 6 && !s.finished; i++) {
      s = playedMove(s, byo, s.anchorAt + 200); // white answers quickly
      if (s.finished) break;
      s = playedMove(s, byo, s.anchorAt + 1_500); // black keeps overrunning the period
    }
    expect(s.finished?.reason).toBe('timeout');
    expect(s.finished?.winner).toBe('white');
    expect(s.periods.black).toBe(0);
  });
});

describe('untimed', () => {
  it('just passes the move along', () => {
    let s = initialClock({ kind: 'untimed' }, 'black', 0);
    s = playedMove(s, { kind: 'untimed' }, 9_999_999);
    expect(s.toMove).toBe('white');
    expect(s.finished).toBeNull();
  });
});

describe('presets and formatting', () => {
  it('exposes exactly the two match formats: blitz presets and untimed', () => {
    const kinds = BLITZ_PRESETS.map((p) => p.tc.kind);
    expect(kinds.filter((k) => k === 'blitz').length).toBeGreaterThan(0);
    expect(kinds.filter((k) => k === 'untimed')).toHaveLength(1);
    expect(BLITZ_PRESETS.some((p) => p.label === '3+2')).toBe(true);
  });

  it('formats remaining time for the low seconds case', () => {
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(65_000)).toBe('1:05');
    expect(formatRemaining(3_600_000)).toBe('1:00:00');
    expect(formatRemaining(9_500)).toBe('0:09.5');
  });
});
