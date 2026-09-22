import type { AnalysisPacket, Budget, ClockState, Side, StrengthLabel, TimeControl } from '@sanyi/core';

export interface Capabilities {
  engines: { id: string; game: 'go'; tier: string; strength: StrengthLabel; version: string }[];
  throughput: { budgets?: Record<string, number>; singlePosition?: { maxVisits: number; visitsPerSec: number }[] } | null;
  clockAuthority: 'bridge';
}

type Pending = { resolve: (v: never) => void; onPartial?: (p: AnalysisPacket) => void };

/** Thin ws RPC to the local engine bridge. Everything strength-related is answered by the bridge, never the page. */
export class Bridge {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  caps: Capabilities | null = null;

  onStatus: (s: 'connecting' | 'open' | 'closed') => void = () => {};

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get isConnecting(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.CONNECTING;
  }

  connect(url = `ws://${location.hostname}:8788`): Promise<Capabilities> {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return Promise.resolve(this.caps!);
    this.onStatus('connecting');
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => this.onStatus('open');
    ws.onclose = () => {
      this.onStatus('closed');
      this.ws = null;
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as { reqId?: string; partial?: AnalysisPacket; packet?: AnalysisPacket; final?: boolean } & Record<string, unknown>;
      const id = msg.reqId;
      if (!id) return;
      const p = this.pending.get(id);
      if (!p) return;
      if (msg.partial) {
        p.onPartial?.(msg.partial);
        return;
      }
      this.pending.delete(id);
      p.resolve(msg as never);
    };
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', async () => {
        const caps = await this.rpc<Capabilities>({ op: 'capabilities' });
        this.caps = caps;
        resolve(caps);
      }, { once: true });
      ws.addEventListener('error', () => reject(new Error('bridge unreachable')), { once: true });
      setTimeout(() => reject(new Error('bridge connect timeout')), 8000);
    });
  }

  rpc<T>(req: Record<string, unknown>, timeoutMs = 180_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('bridge not connected'));
    const reqId = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`bridge timeout on ${String(req.op)}`));
      }, timeoutMs);
      this.pending.set(reqId, {
        resolve: ((v: unknown) => {
          clearTimeout(timer);
          resolve(v as T);
        }) as (v: never) => void,
      });
      ws.send(JSON.stringify({ ...req, reqId }));
    });
  }

  /** One engine move. `onPartial` streams while the engine keeps searching (untimed tier). */
  best(moves: string[], budget: Budget, onPartial?: (p: AnalysisPacket) => void): Promise<{ best: string; packet: AnalysisPacket }> {
    const ws = this.ws!;
    const reqId = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error('bridge not connected'));
      this.pending.set(reqId, { resolve: resolve as never, onPartial });
      ws.send(JSON.stringify({ op: 'best', game: 'go', moves, budget, reqId }));
    });
  }

  analyze(moves: string[], budget: Budget): Promise<{ packet: AnalysisPacket; final: boolean }> {
    return this.rpc({ op: 'analyze', game: 'go', moves, budget });
  }

  clockStart(gameId: string, tc: TimeControl, toMove: 'black' | 'white'): Promise<{ clock: ClockState }> {
    return this.rpc({ op: 'clockStart', gameId, tc, toMove });
  }

  clockMove(gameId: string): Promise<{ clock: ClockState }> {
    return this.rpc({ op: 'clockMove', gameId });
  }

  /** Start a recorded game. The bridge may rename the id if one already exists — use what it returns. */
  recordStart(req: { gameId: string; mode: string; tc: TimeControl; userColor: Side }): Promise<{ gameId: string }> {
    return this.rpc({ op: 'recordStart', ...req });
  }

  recordMove(req: { gameId: string; moves: string[]; by: 'user' | 'engine'; forceEval?: boolean }): Promise<{ recorded?: boolean; baseline?: unknown; error?: string }> {
    return this.rpc({ op: 'recordMove', ...req }, 20_000);
  }

  recordEnd(gameId: string, result: string, reason: string): Promise<{ recorded: boolean }> {
    return this.rpc({ op: 'recordEnd', gameId, result, reason });
  }

  close(): void {
    this.ws?.close();
  }
}

export const bridge = new Bridge();
