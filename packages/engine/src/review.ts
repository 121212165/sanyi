import type { AnalysisPacket, MoveFacts, Side } from '@sanyi/core';
import { analyzeMoves, startPosition, tryMove, type GoPosition } from '@sanyi/core';

/** Asks the engine about the position reached by `moves`. Injected so this module needs no bridge. */
export type AnalyzeFn = (moves: string[]) => Promise<AnalysisPacket>;

export type Severity = 'unmeasured' | 'normal' | 'soft' | 'mistake' | 'blunder';

export const SEVERITY_PP = { soft: 4.0, mistake: 8.0, blunder: 15.0 };

export interface ReviewRow {
  ply: number;
  /** 1-based move number, as a human reads a record. */
  moveNumber: number;
  vertex: string;
  color: Side;
  by: 'user' | 'engine';
  facts: MoveFacts;
  /** Value of the position before this move, always from black's side so rows are comparable. */
  blackWinrateBefore: number | null;
  /** Value after this move — the same number the next row reports as its "before". */
  blackWinrateAfter: number | null;
  /** Percentage points the mover gave up by playing this instead of leaving the position as it was. */
  lossPp: number | null;
  engineBest: string | null;
  /** What the engine planned right after the move it would have played. */
  enginePv: string[];
  /** What the engine planned after the move that was actually played, when it searched it. */
  playedPv: string[];
  playedVisits: number | null;
  visits: number | null;
  severity: Severity;
  counterfactual?: { ifBest: string; blackWinrateIfBest: number; gainPp: number; replyLine: string[] };
}

export interface ReviewSummary {
  userMoves: number;
  measured: number;
  avgLossPp: number | null;
  medianLossPp: number | null;
  counts: Record<Severity, number>;
  worst: { ply: number; vertex: string; lossPp: number }[];
  /** Stones the user lost to capture across the record — a rule-level fact, not an opinion. */
  userStonesLost: number;
  userCaptures: number;
}

export interface ReviewBundle {
  game: string;
  mode: string;
  timeControl: unknown;
  userColor: Side;
  engine: { note: string; throughput?: unknown } | undefined;
  size: number;
  komi: number;
  rows: ReviewRow[];
  summary: ReviewSummary;
  /** Anything the review could not measure, stated rather than papered over. */
  gaps: string[];
}

export interface ReviewOptions {
  gameId?: string;
  size?: number;
  userColor?: Side;
  mode?: string;
  timeControl?: unknown;
  engine?: ReviewBundle['engine'];
  /** Restrict engine searches to these plies; the rest are reported as unmeasured. */
  onlyPlies?: Set<number>;
  /** Run the "what if you had played its move" search for losses at or above this many points. */
  counterfactualAtPp?: number;
  log?: (msg: string) => void;
}

function round(x: number, n: number): number {
  const p = 10 ** n;
  return Math.round(x * p) / p;
}

function severityOf(lossPp: number | null): Severity {
  if (lossPp === null) return 'unmeasured';
  if (lossPp >= SEVERITY_PP.blunder) return 'blunder';
  if (lossPp >= SEVERITY_PP.mistake) return 'mistake';
  if (lossPp >= SEVERITY_PP.soft) return 'soft';
  return 'normal';
}

/** Replays the whole record once, returning the position before each ply plus the final one. */
function replay(moves: string[], size: number): GoPosition[] {
  let pos = startPosition({ size });
  const out = [pos];
  for (const m of moves) {
    const r = tryMove(pos, m);
    if (!r.ok || !r.position) throw new Error(`record contains an illegal move at ply ${pos.moves.length}: ${m}`);
    pos = r.position;
    out.push(pos);
  }
  return out;
}

function candidateFor(packet: AnalysisPacket, vertex: string) {
  const v = vertex.toUpperCase();
  return packet.candidates.find((c) => c.move.toUpperCase() === v);
}

/**
 * Replays a recorded game, asks the engine about every position, and attaches the board facts.
 *
 * The loss of a move is defined as (value before) − (value after), both from black's side and
 * converted to the mover's point of view. The value after a move is simply the value before the
 * next one, so a single search per position serves two rows — that is what keeps a full-game
 * review affordable on a CPU/iGPU box.
 */
export async function buildReview(moves: string[], analyze: AnalyzeFn, opts: ReviewOptions = {}): Promise<ReviewBundle> {
  const size = opts.size ?? 19;
  const facts = analyzeMoves(moves, size);
  const positions = replay(moves, size);
  const gaps: string[] = [];
  const log = opts.log ?? (() => {});

  // One search per position, keyed by ply.
  const packets: (AnalysisPacket | null)[] = [];
  for (let ply = 0; ply < moves.length; ply++) {
    const wanted = !opts.onlyPlies || opts.onlyPlies.has(ply);
    if (!wanted) {
      packets.push(null);
      continue;
    }
    try {
      packets.push(await analyze(moves.slice(0, ply)));
    } catch (e) {
      packets.push(null);
      gaps.push(`第 ${ply + 1} 手搜索失败：${(e as Error).message}`);
    }
    log(`ply ${ply + 1}/${moves.length} ${moves[ply]}`);
  }

  /** Black-side value of the position at `ply`, from the engine's top candidate. */
  const valueAt = (ply: number): number | null => {
    const p = packets[ply];
    const top = p?.candidates[0];
    if (!top || top.winrate === undefined) return null;
    const mover = positions[ply].toMove;
    return mover === 'black' ? top.winrate : 1 - top.winrate;
  };

  const rows: ReviewRow[] = [];
  for (let ply = 0; ply < facts.length; ply++) {
    const f = facts[ply]!;
    const packet = packets[ply] ?? null;
    const best = packet?.candidates[0] ?? null;
    const played = packet ? candidateFor(packet, f.vertex) : undefined;
    const before = valueAt(ply);
    const after = valueAt(ply + 1);
    const lossPp =
      before !== null && after !== null
        ? round((f.color === 'black' ? before - after : after - before) * 100, 1)
        : null;

    rows.push({
      ply,
      moveNumber: ply + 1,
      vertex: f.vertex,
      color: f.color,
      by: opts.userColor ? (f.color === opts.userColor ? 'user' : 'engine') : ply % 2 === 0 ? 'user' : 'engine',
      facts: f,
      blackWinrateBefore: before,
      blackWinrateAfter: after,
      lossPp,
      engineBest: best?.move ?? null,
      enginePv: best?.pv ?? [],
      playedPv: played?.pv ?? [],
      playedVisits: played?.visits ?? null,
      visits: best?.visits ?? null,
      severity: severityOf(lossPp),
    });
    if (!packet && opts.onlyPlies?.has(ply) === false) gaps.push(`第 ${ply + 1} 手未搜索`);
  }

  const cfAt = opts.counterfactualAtPp ?? SEVERITY_PP.mistake;
  for (const r of rows) {
    if (r.by !== 'user' || r.lossPp === null || r.lossPp < cfAt || !r.engineBest) continue;
    try {
      const alt = await analyze([...moves.slice(0, r.ply), r.engineBest]);
      const top = alt.candidates[0];
      if (!top || top.winrate === undefined) continue;
      const nextMover = positions[r.ply + 1].toMove; // the opponent's turn, i.e. the reply being searched
      const bw = nextMover === 'black' ? top.winrate : 1 - top.winrate;
      const mineIfBest = r.color === 'black' ? bw : 1 - bw;
      const mineActual = r.blackWinrateAfter === null ? null : r.color === 'black' ? r.blackWinrateAfter : 1 - r.blackWinrateAfter;
      r.counterfactual = {
        ifBest: r.engineBest,
        blackWinrateIfBest: bw,
        gainPp: mineActual === null ? 0 : round(mineIfBest - mineActual, 3) * 100,
        replyLine: top.pv.slice(0, 8),
      };
    } catch (e) {
      gaps.push(`第 ${r.moveNumber} 手反事实搜索失败：${(e as Error).message}`);
    }
  }

  const userRows = rows.filter((r) => r.by === 'user');
  const losses = userRows.map((r) => r.lossPp).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const counts: Record<Severity, number> = { unmeasured: 0, normal: 0, soft: 0, mistake: 0, blunder: 0 };
  for (const r of userRows) counts[r.severity]++;

  return {
    game: opts.gameId ?? 'review',
    mode: opts.mode ?? 'unknown',
    timeControl: opts.timeControl ?? null,
    userColor: opts.userColor ?? 'black',
    engine: opts.engine,
    size,
    komi: 7.5,
    rows,
    summary: {
      userMoves: userRows.length,
      measured: losses.length,
      avgLossPp: losses.length ? round(losses.reduce((a, b) => a + b, 0) / losses.length, 2) : null,
      medianLossPp: losses.length ? round(losses[Math.floor(losses.length / 2)], 2) : null,
      counts,
      worst: userRows
        .filter((r) => r.lossPp !== null)
        .sort((a, b) => (b.lossPp ?? 0) - (a.lossPp ?? 0))
        .slice(0, 6)
        .map((r) => ({ ply: r.ply, vertex: r.vertex, lossPp: r.lossPp as number })),
      userStonesLost: userRows.reduce((a, r) => a + r.facts.fate.stonesLost, 0),
      userCaptures: userRows.reduce((a, r) => a + r.facts.capturedByMove, 0),
    },
    gaps,
  };
}
