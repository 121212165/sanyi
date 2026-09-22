import type { AnalysisPacket, Candidate, Flag, GoPosition, Score, Side, StrengthLabel, Tier } from '@sanyi/core';
import { other, startPosition, tryMove } from '@sanyi/core';
import type { KatagoMoveInfo, KatagoResponse } from './katago.ts';

/** KataGo reports winrate from Black's point of view by default; the app reasons from the mover's. */
export function toSideWinrate(winrateAsBlack: number, side: Side): number {
  return side === 'black' ? winrateAsBlack : 1 - winrateAsBlack;
}

export function ownershipGrid(flat: number[] | undefined, size: number): number[][] | undefined {
  if (!flat || flat.length < size * size) return undefined;
  const rows: number[][] = [];
  for (let y = 0; y < size; y++) rows.push(flat.slice(y * size, y * size + size));
  return rows;
}

function scoreOf(m: { winrate: number; scoreLead: number }, side: Side): Score {
  return { kind: 'points', lead: side === 'black' ? m.scoreLead : -m.scoreLead, side };
}

/**
 * Mistake taxonomy for Go. Centipawns are meaningless here, so thresholds are winrate and score-lead
 * swings measured between the best move and the move actually played.
 */
export function classifyGo(opts: {
  bestWinrateAsBlack: number;
  playedWinrateAsBlack?: number;
  bestScoreLead: number;
  playedScoreLead?: number;
  mover: Side;
  visits: number;
}): { flags: Flag[]; vsBest: number } {
  const flags: Flag[] = [];
  if (opts.playedWinrateAsBlack === undefined || opts.playedScoreLead === undefined) {
    return { flags, vsBest: 0 };
  }
  const bestW = toSideWinrate(opts.bestWinrateAsBlack, opts.mover);
  const playedW = toSideWinrate(opts.playedWinrateAsBlack, opts.mover);
  const swing = bestW - playedW;
  const bestLead = opts.mover === 'black' ? opts.bestScoreLead : -opts.bestScoreLead;
  const playedLead = opts.mover === 'black' ? opts.playedScoreLead : -opts.playedScoreLead;
  const leadLoss = bestLead - playedLead;
  if (opts.visits < 50) return { flags: ['time-pressure'], vsBest: swing };
  if (swing >= 0.15 || leadLoss >= 9) flags.push('blunder');
  else if (swing >= 0.08 || leadLoss >= 3.5) flags.push('mistake');
  else if (swing >= 0.04 || leadLoss >= 1.5) flags.push('inaccuracy');
  if (swing <= -0.06) flags.push('brilliancy');
  return { flags, vsBest: swing };
}

export interface PacketMeta {
  backendId: string;
  tier: Tier;
  strength: StrengthLabel;
  engineVersion: string;
  threads?: number;
}

/** Turns one KataGo analysis response into the packet the UI and the coach are allowed to talk about. */
export function toPacket(
  res: KatagoResponse,
  pos: GoPosition,
  meta: PacketMeta,
  opts: { elapsedMs?: number; midSearch?: boolean; vsBest?: number; flags?: Flag[] } = {},
): AnalysisPacket {
  const mover = pos.toMove;
  const totalVisits = res.moveInfos.reduce((a, m) => a + m.visits, 0) || res.rootInfo?.visits || 0;
  const candidates: Candidate[] = res.moveInfos
    .slice()
    .sort((a, b) => b.visits - a.visits)
    .map((m) => ({
      move: m.move,
      label: m.move.toUpperCase() === 'PASS' ? '虚着 (pass)' : m.move,
      score: scoreOf(m, mover),
      winrate: toSideWinrate(m.winrate, mover),
      visits: m.visits,
      share: totalVisits ? m.visits / totalVisits : undefined,
      lcb: m.lcb,
      prior: m.prior,
      pv: m.pv ?? [],
    }));

  const insufficiency: AnalysisPacket['insufficiency'] = [];
  if (meta.tier !== 'native') insufficiency.push('tier-too-shallow');
  if (totalVisits < 50) insufficiency.push('visits<50');
  if (opts.midSearch) insufficiency.push('mid-search');
  if (!res.ownership) insufficiency.push('no-ownership');

  return {
    game: 'go',
    meta: {
      backendId: meta.backendId,
      tier: meta.tier,
      strength: meta.strength,
      params: { visits: res.rootInfo?.visits ?? totalVisits, multipv: res.moveInfos.length, threads: meta.threads },
      engineVersion: meta.engineVersion,
      elapsedMs: Math.round(opts.elapsedMs ?? 0),
    },
    position: { key: `go:${pos.size}:${res.rootInfo?.thisHash ?? ''}:${mover}`, sideToMove: mover, ply: pos.moves.length },
    candidates,
    score: { ownershipGrid: ownershipGrid(res.ownership ?? res.moveInfos[0]?.ownership, pos.size) },
    // Atari/cut detection is derived from the search tree, not asserted from thin air; until that is
    // implemented the honest answer is "no tactics measured".
    tactics: [],
    delta: opts.vsBest !== undefined ? { vsBest: opts.vsBest } : undefined,
    flags: opts.flags ?? [],
    insufficiency,
  };
}

/** Plays the engine's top choice, so a caller can ask "what does KataGo itself do here". */
export function bestMoveOf(res: KatagoResponse, pos: GoPosition): string | null {
  const legal = new Set<string>(['PASS']);
  for (let y = 0; y < pos.size; y++) {
    for (let x = 0; x < pos.size; x++) {
      if (pos.cells[y][x] === 0 && tryMove(pos, `${'ABCDEFGHJKLMNOPQRSTUVWXYZ'[x]}${pos.size - y}`).ok) {
        legal.add(`${'ABCDEFGHJKLMNOPQRSTUVWXYZ'[x]}${pos.size - y}`);
      }
    }
  }
  for (const m of res.moveInfos.slice().sort((a, b) => b.visits - a.visits)) {
    const v = m.move.toUpperCase() === 'PASS' ? 'PASS' : m.move;
    if (legal.has(v)) return v;
  }
  return null;
}
