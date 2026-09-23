import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { GoPosition } from '@sanyi/core';

export interface KatagoQuery {
  id: string;
  /** [color, GTP vertex] pairs, colour alternating from the game's first mover. */
  moves: [string, string][];
  rules: string;
  komi: number;
  boardXSize: number;
  boardYSize: number;
  initialStones?: [string, string][];
  analyzeTurns?: number[];
  maxVisits?: number;
  includeOwnership?: boolean;
  includePVVisits?: boolean;
  /** Seconds between partial reports while a position is still being searched. */
  reportDuringSearchEvery?: number;
  priority?: number;
  /** Restrict the root to these moves — how "what about this move?" gets a real answer. */
  allowMoves?: { player: string; moves: string[]; untilDepth: number }[];
  avoidMoves?: { player: string; moves: string[]; untilDepth: number }[];
  rootInfo?: boolean;
}

export interface KatagoMoveInfo {
  move: string;
  visits: number;
  winrate: number;
  scoreMean: number;
  scoreLead: number;
  scoreStdev: number;
  prior: number;
  lcb: number;
  utility: number;
  pv: string[];
  ownership?: number[];
}

export interface KatagoResponse {
  id: string;
  isDuringSearch?: boolean;
  turnNumber: number;
  nodeCount: number;
  moveInfos: KatagoMoveInfo[];
  /** Top-level (not inside rootInfo): 361 values in row-major order from A19, -1..1. */
  ownership?: number[];
  rootInfo?: {
    currentPlayer: string;
    visits: number;
    winrate: number;
    scoreLead: number;
    scoreSelfplay: number;
    scoreStdev: number;
    utility: number;
    lcb: number;
    thisHash: string;
    symHash: string;
    ownership?: number[];
  };
  warning?: string;
  error?: string;
  field?: string;
}

export interface KatagoOptions {
  exe: string;
  config: string;
  model: string;
  /** Optional second model for human-like play (rank ladder), `-human-model`. */
  humanModel?: string;
  /** `numAnalysisThreads`, how many positions KataGo analyses in parallel. */
  numAnalysisThreads?: number;
  numSearchThreadsPerAnalysisThread?: number;
  /** Any other `key = value` config overrides. */
  overrides?: Record<string, string | number | boolean>;
  quiet?: boolean;
}

/**
 * Client for `katago analysis`: JSON lines over stdin/stdout, no port.
 * One request can analyse many turns; every turn produces its own line with the same id,
 * and `reportDuringSearchEvery` produces extra lines flagged isDuringSearch before the final one.
 */
export class KatagoClient {
  private readonly opts: KatagoOptions;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private waiters = new Map<string, (r: KatagoResponse) => void>();
  private ready: Promise<void> | null = null;
  readonly stderrTail: string[] = [];

  constructor(opts: KatagoOptions) {
    this.opts = opts;
  }

  get isRunning(): boolean {
    return this.proc !== null;
  }

  start(): Promise<void> {
    if (this.ready) return this.ready;
    // KataGo rejects `-analysis-threads` when the config already names numAnalysisThreads, so both
    // thread knobs go through the single override channel.
    const overrides: Record<string, string | number | boolean> = { ...(this.opts.overrides ?? {}) };
    if (this.opts.numAnalysisThreads) overrides.numAnalysisThreads = this.opts.numAnalysisThreads;
    if (this.opts.numSearchThreadsPerAnalysisThread) {
      overrides.numSearchThreadsPerAnalysisThread = this.opts.numSearchThreadsPerAnalysisThread;
    }
    const args = ['analysis', '-config', this.opts.config, '-model', this.opts.model];
    if (this.opts.humanModel) args.push('-human-model', this.opts.humanModel);
    if (Object.keys(overrides).length) {
      args.push('-override-config', Object.entries(overrides).map(([k, v]) => `${k}=${v}`).join(', '));
    }
    const proc = spawn(this.opts.exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.on('exit', (code) => {
      if (!this.opts.quiet) this.log(`exited code=${code}`);
      for (const [, reject] of this.waiters) reject(undefined as never);
      this.waiters.clear();
      this.proc = null;
    });
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      let msg: KatagoResponse;
      try {
        msg = JSON.parse(t) as KatagoResponse;
      } catch {
        return;
      }
      const cb = this.waiters.get(msg.id);
      // The handler owns its own lifetime: an analyzeTurns query expects many responses for one id.
      if (cb) cb(msg);
    });
    const errl = createInterface({ input: proc.stderr, crlfDelay: Infinity });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`katago did not become ready in 120s; last: ${this.stderrTail.slice(-4).join(' | ')}`)), 120_000);
      errl.on('line', (line) => {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 200) this.stderrTail.shift();
        if (!this.opts.quiet) this.log(line);
        if (/Started, ready to begin handling requests/.test(line)) {
          clearTimeout(timer);
          resolve();
        }
        if (/\bError:/.test(line) && !/warnUnusedFields/i.test(line)) {
          clearTimeout(timer);
          reject(new Error(line));
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`katago exited early (code ${code}); last: ${this.stderrTail.slice(-4).join(' | ')}`));
      });
    });
    return this.ready;
  }

  /**
   * One query with `analyzeTurns` produces one response per analyzed turn, all sharing the id.
   * Collects `expected` of them and returns them ordered by turnNumber.
   */
  async askTurns(query: KatagoQuery, expected: number): Promise<KatagoResponse[]> {
    await this.start();
    const proc = this.proc;
    if (!proc) throw new Error('katago not running');
    return new Promise<KatagoResponse[]>((resolve, reject) => {
      const got: KatagoResponse[] = [];
      this.waiters.set(query.id, (r) => {
        if (r.error) {
          this.waiters.delete(query.id);
          return reject(new Error(`${r.error} (field=${r.field})`));
        }
        if (r.isDuringSearch) return;
        got.push(r);
        if (got.length >= expected) {
          this.waiters.delete(query.id);
          resolve(got.sort((a, b) => a.turnNumber - b.turnNumber));
        }
      });
      proc.stdin.write(JSON.stringify(query) + '\n');
    });
  }

  /** Resolves on the final report for this query id; intermediate reports go to `onPartial`. */
  async ask(query: KatagoQuery, onPartial?: (r: KatagoResponse) => void): Promise<KatagoResponse> {
    await this.start();
    const proc = this.proc;
    if (!proc) throw new Error('katago not running');
    return new Promise<KatagoResponse>((resolve, reject) => {
      this.waiters.set(query.id, (r) => {
        if (r.error) return reject(new Error(`${r.error} (field=${r.field})`));
        if (r.isDuringSearch) onPartial?.(r);
        else resolve(r);
      });
      proc.stdin.write(JSON.stringify(query) + '\n');
    }).finally(() => this.waiters.delete(query.id));
  }

  /** Every response for one query, in arrival order — use with reportDuringSearchEvery. */
  async *stream(query: KatagoQuery): AsyncIterable<KatagoResponse> {
    await this.start();
    const proc = this.proc;
    if (!proc) throw new Error('katago not running');
    const queue: KatagoResponse[] = [];
    let done = false;
    let wake: (() => void) | null = null;
    this.waiters.set(query.id, (r) => {
      queue.push(r);
      if (!r.isDuringSearch) done = true;
      wake?.();
    });
    proc.stdin.write(JSON.stringify(query) + '\n');
    while (!done || queue.length) {
      while (queue.length) yield queue.shift()!;
      if (!done) await new Promise<void>((res) => (wake = res));
    }
    this.waiters.delete(query.id);
  }

  async shutdown(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    proc.stdin.end();
    proc.kill();
    this.proc = null;
  }

  private log(line: string): void {
    process.stderr.write(`[katago] ${line}\n`);
  }
}

/** Colours alternate from `firstMover`; setup stones are reported separately as `initialStones`. */
export function positionToQuery(pos: GoPosition, extra: Partial<KatagoQuery> = {}): KatagoQuery {
  const moves: [string, string][] = [];
  let black = pos.firstMover === 'black';
  for (const v of pos.moves) {
    moves.push([black ? 'B' : 'W', v.toUpperCase() === 'PASS' ? 'pass' : v]);
    black = !black;
  }
  const initialStones: [string, string][] = [
    ...pos.setup.black.map((v): [string, string] => ['B', v]),
    ...pos.setup.white.map((v): [string, string] => ['W', v]),
  ];
  return {
    id: 'q',
    rules: 'chinese',
    komi: pos.komi,
    boardXSize: pos.size,
    boardYSize: pos.size,
    maxVisits: 200,
    ...extra,
    moves,
    ...(initialStones.length ? { initialStones } : {}),
  };
}
