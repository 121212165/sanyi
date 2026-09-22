/**
 * Game recorder: one JSONL per game under .local/records/.
 *
 * Recording the *pre-move* baseline next to the move actually played is what makes "这手亏了多少"
 * answerable at all; without a baseline a review is just opinion.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** What the engine believed about the position right before a move was played. */
export interface Baseline {
  best: string;
  bestWinrate?: number;
  bestScoreLead?: number;
  visits?: number;
  /** The played move as the engine had it pre-search; null when it never got searched. */
  playedWinrate?: number | null;
  playedScoreLead?: number | null;
  playedVisits?: number;
  /** How much of the root's visits went to the played move — low means the numbers are soft. */
  playedShare?: number;
  /** 'no-baseline' when the position was never analysed, so the analyzer can distrust the row. */
  note?: string;
}

export type RecorderEvent =
  | { t: 'start'; at: string; gameId: string; mode: string; timeControl: unknown; engine: unknown; userColor: string }
  | { t: 'move'; at: string; gameId: string; ply: number; color: 'black' | 'white'; by: 'user' | 'engine'; vertex: string; clock?: unknown; baseline?: Baseline }
  | { t: 'eval'; at: string; gameId: string; ply: number; vertex: string; winrate: number | null; scoreLead: number | null; visits: number; note?: string }
  | { t: 'end'; at: string; gameId: string; result: string; reason: string };

export class Recorder {
  private readonly dir: string;
  /** gameId -> file path, for the games currently being written. */
  private readonly open = new Map<string, string>();

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(gameId: string): string {
    return join(this.dir, `${gameId.replace(/[^A-Za-z0-9_.-]/g, '_')}.jsonl`);
  }

  start(ev: Extract<RecorderEvent, { t: 'start' }>): string {
    let gameId = ev.gameId;
    let path = this.pathFor(gameId);
    // A reload can hand back the same id; never overwrite a finished game.
    for (let n = 1; existsSync(path); n++) {
      gameId = `${ev.gameId}-${n}`;
      path = this.pathFor(gameId);
    }
    this.open.set(gameId, path);
    appendFileSync(path, JSON.stringify({ ...ev, gameId }) + '\n');
    return gameId;
  }

  write(ev: RecorderEvent): void {
    const path = this.open.get(ev.gameId);
    if (path) appendFileSync(path, JSON.stringify(ev) + '\n');
  }

  end(gameId: string, result: string, reason: string): void {
    const path = this.open.get(gameId);
    if (!path) return;
    appendFileSync(path, JSON.stringify({ t: 'end', at: new Date().toISOString(), gameId, result, reason }) + '\n');
    this.open.delete(gameId);
  }

  isOpen(gameId: string): boolean {
    return this.open.has(gameId);
  }

  list(): string[] {
    return readdirSync(this.dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));
  }

  read(gameId: string): RecorderEvent[] {
    const path = this.pathFor(gameId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RecorderEvent);
  }
}
