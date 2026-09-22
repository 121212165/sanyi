import type { Side } from './types.ts';

/**
 * Match mode has exactly two formats: blitz (with a clock) and untimed. Go uses byo-yomi for its
 * blitz format; chess/xiangqi use Fischer increment with an optional simple delay.
 */
export type TimeControl =
  | { kind: 'untimed' }
  | { kind: 'blitz'; baseMs: number; incMs: number; delayMs: number }
  | { kind: 'byoyomi'; mainMs: number; periods: number; periodMs: number };

export const BLITZ_PRESETS: { label: string; tc: TimeControl }[] = [
  { label: '3+2', tc: { kind: 'blitz', baseMs: 180_000, incMs: 2_000, delayMs: 0 } },
  { label: '5+3', tc: { kind: 'blitz', baseMs: 300_000, incMs: 3_000, delayMs: 0 } },
  { label: '10+5', tc: { kind: 'blitz', baseMs: 600_000, incMs: 5_000, delayMs: 0 } },
  { label: '围棋 20分+30秒×5', tc: { kind: 'byoyomi', mainMs: 1_200_000, periods: 5, periodMs: 30_000 } },
  { label: '不限时', tc: { kind: 'untimed' } },
];

export interface ClockState {
  toMove: Side;
  /** Remaining main time per side, ms. */
  main: Record<Side, number>;
  /** Remaining byo-yomi periods per side; unused outside `byoyomi`. */
  periods: Record<Side, number>;
  /** Remaining ms of the current byo-yomi period, per side. */
  periodLeft: Record<Side, number>;
  /** Epoch ms of the anchor; the bridge owns this value, the browser only mirrors it. */
  anchorAt: number;
  finished: null | { winner: Side | 'none'; reason: 'timeout' | 'resign' | 'adjudication' | 'game-over' };
}

export function initialClock(tc: TimeControl, toMove: Side, now: number): ClockState {
  const inf = Number.MAX_SAFE_INTEGER;
  if (tc.kind === 'untimed') {
    return { toMove, main: { black: inf, white: inf }, periods: { black: 0, white: 0 }, periodLeft: { black: 0, white: 0 }, anchorAt: now, finished: null };
  }
  if (tc.kind === 'blitz') {
    return { toMove, main: { black: tc.baseMs, white: tc.baseMs }, periods: { black: 0, white: 0 }, periodLeft: { black: 0, white: 0 }, anchorAt: now, finished: null };
  }
  return {
    toMove,
    main: { black: tc.mainMs, white: tc.mainMs },
    periods: { black: tc.periods, white: tc.periods },
    periodLeft: { black: tc.periodMs, white: tc.periodMs },
    anchorAt: now,
    finished: null,
  };
}

/** Ms the side-to-move still has right now, computed from the bridge's anchor. */
export function remainingNow(state: ClockState, tc: TimeControl, now: number): number {
  if (tc.kind === 'untimed' || state.finished) return Number.POSITIVE_INFINITY;
  const spent = Math.max(0, now - state.anchorAt);
  if (tc.kind === 'blitz') return state.main[state.toMove] - spent;
  const main = state.main[state.toMove];
  return main > 0 ? main - spent : state.periodLeft[state.toMove] - spent;
}

export function isBlind(state: ClockState, tc: TimeControl): boolean {
  return tc.kind !== 'untimed' && remainingNow(state, tc, Date.now()) < 10_000;
}

/**
 * Commits the time the side-to-move just used and hands over the turn.
 * `now` must come from the bridge clock, never from the browser, or tab throttling steals time.
 */
export function playedMove(state: ClockState, tc: TimeControl, now: number): ClockState {
  if (state.finished || tc.kind === 'untimed') {
    return { ...state, toMove: other(state.toMove), anchorAt: now };
  }
  // The bridge is authoritative, so time can never run backwards here.
  const spent = Math.max(0, now - state.anchorAt);
  const s: ClockState = { ...state, main: { ...state.main }, periods: { ...state.periods }, periodLeft: { ...state.periodLeft } };
  const me = s.toMove;

  if (tc.kind === 'blitz') {
    const grace = Math.min(spent, tc.delayMs);
    s.main[me] = s.main[me] - (spent - grace) + tc.incMs;
    if (s.main[me] <= 0) return finish(s, other(me), 'timeout', now);
  } else {
    let owed = spent;
    const fromMain = Math.min(s.main[me], owed);
    s.main[me] -= fromMain;
    owed -= fromMain;
    while (owed > 0) {
      const fromPeriod = Math.min(s.periodLeft[me], owed);
      s.periodLeft[me] -= fromPeriod;
      owed -= fromPeriod;
      if (s.periodLeft[me] <= 0) {
        s.periods[me] -= 1;
        if (s.periods[me] <= 0) return finish(s, other(me), 'timeout', now);
        s.periodLeft[me] = tc.periodMs;
      }
    }
  }
  s.toMove = other(me);
  s.anchorAt = now;
  return s;
}

function finish(s: ClockState, winner: Side, reason: 'timeout' | 'resign', now: number): ClockState {
  return { ...s, anchorAt: now, finished: { winner, reason } };
}

export function other(side: Side): Side {
  return side === 'black' ? 'white' : 'black';
}

export function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms > 86_400_000) return '—';
  if (ms <= 0) return '0:00';
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const mm = h > 0 ? `${h}:${String(m).padStart(2, '0')}` : String(m);
  return `${mm}:${String(sec).padStart(2, '0')}${ms < 20_000 ? '.' + Math.floor((ms % 1000) / 100) : ''}`;
}
