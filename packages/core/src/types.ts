export type GameKind = 'go' | 'chess' | 'xiangqi';

export type Tier = 'native' | 'wasm' | 'remote' | 'cloudeval' | 'rules-only';

export type Band = 'max' | 'strong' | 'mid' | 'weak' | 'none';

/** The only thing allowed to name an opponent in the UI. `measured: false` means nobody timed this tier here. */
export interface StrengthLabel {
  band: Band;
  measured: boolean;
  note: string;
  /** Measured on this machine, e.g. KataGo visits/s. Drives every time budget in the app. */
  throughput?: { unit: 'visits/s' | 'nodes/s' | 'knodes/s'; value: number };
}

export interface EngineCaps {
  multipv: boolean;
  analysisMode: boolean;
  ownership: boolean;
  /** Engine can keep searching and be interrupted, adopting the current best move. */
  infinite: boolean;
  /** Engine can restrict search to (or away from) specific root moves. */
  restrictMoves: boolean;
  streaming: boolean;
  preemption: boolean;
}

export type Score =
  | { kind: 'points'; lead: number; side: Side }
  | { kind: 'cp'; value: number }
  | { kind: 'mate'; movesIn: number }
  | { kind: 'winrate'; value: number };

export type Side = 'black' | 'white';

export interface Candidate {
  move: string;
  /** Rendered for humans: SAN / 中文着法 / GTP vertex. */
  label: string;
  score: Score;
  winrate?: number;
  visits?: number;
  /** Share of the root's visits, 0..1 — how much the engine believed this move. */
  share?: number;
  lcb?: number;
  prior?: number;
  /** Engine's line, engine-native move strings, starting with `move`. */
  pv: string[];
}

export type Flag = 'blunder' | 'mistake' | 'inaccuracy' | 'brilliancy' | 'book' | 'time-pressure' | 'resign-candidate';

export type TacticKind = 'hanging' | 'fork' | 'pin' | 'mate' | 'check' | 'atari' | 'cut' | 'ladder' | 'shortage-of-liberties';

export interface Tactic {
  kind: TacticKind;
  squares: string[];
  note?: string;
}

export type Insufficiency = 'no-engine' | 'tier-too-shallow' | 'visits<50' | 'no-ownership' | 'mid-search' | 'cache-stale';

/**
 * What the engine actually measured. Everything the UI and the LLM may assert must be derivable from this.
 * `undefined` fields are absent, never guessed.
 */
export interface AnalysisPacket {
  game: GameKind;
  meta: {
    backendId: string;
    tier: Tier;
    strength: StrengthLabel;
    params: { visits?: number; nodes?: number; depth?: number; moveTimeMs?: number; multipv?: number; threads?: number };
    engineVersion: string;
    elapsedMs: number;
  };
  position: { key: string; sideToMove: Side; ply: number; clockMs?: number };
  /** Sorted by the engine's own preference. Empty means the engine returned nothing usable. */
  candidates: Candidate[];
  score?: { ownershipGrid?: number[][]; material?: Record<string, number> };
  tactics: Tactic[];
  delta?: { vsBest?: number; vsPrevious?: number };
  flags: Flag[];
  insufficiency: Insufficiency[];
}

export type Provenance = 'measured' | 'derived' | 'inferred';

export interface Claim {
  text: string;
  provenance: Provenance;
  /** JSON pointers into the AnalysisPacket that this sentence is allowed to cite. */
  evidence: string[];
}

export interface EngineBackend<P = unknown, M = unknown> {
  id: string;
  game: GameKind;
  tier: Tier;
  caps: EngineCaps;
  strength: StrengthLabel;
  version: string;
  /** Match play: hard budget, single best move. */
  best(req: { position: P; budget: Budget; clock?: number }): Promise<{ move: M; packet: AnalysisPacket }>;
  /** Learning/review: streaming snapshots, may be interrupted and adopted. */
  analyze(req: { position: P; budget: Budget }): AsyncIterable<AnalysisPacket>;
  shutdown(): Promise<void>;
}

export type Budget = { kind: 'visits'; n: number } | { kind: 'nodes'; n: number } | { kind: 'ms'; n: number } | { kind: 'infinite' };

export interface GameAdapter<P, M> {
  game: GameKind;
  start(): P;
  legalMoves(p: P): M[];
  isLegal(p: P, m: M): boolean;
  apply(p: P, m: M): P;
  terminal(p: P): { over: boolean; result?: string; reason?: string } | null;
  sideToMove(p: P): Side;
  canonicalKey(p: P): string;
  formatMove(p: P, m: M): string;
  parseMove(p: P, raw: string): M | null;
  serialize(p: P, history: M[]): string;
}
