/**
 * Local engine bridge. Owns the native engine processes and the authoritative match clock, so the
 * browser is only ever a display: a throttled tab or a GC pause must not cost a player thinking time.
 *
 *   npx tsx packages/bridge/src/main.ts        # ws://127.0.0.1:8788
 *
 * Token: .local/bridge-token (created on first run) — a random web page must not be able to drive a
 * process-spawning localhost service.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  initialClock,
  playedMove,
  positionKey,
  startPosition,
  tryMove,
  type AnalysisPacket,
  type Budget,
  type ClockState,
  type GoPosition,
  type StrengthLabel,
  type TimeControl,
} from '@sanyi/core';
import { KatagoClient, positionToQuery, toPacket, type KatagoResponse } from '@sanyi/engine';
import { Recorder, type Baseline } from './record.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = Number(process.env.BRIDGE_PORT || 8788);
const HOST = '127.0.0.1';

const tokenPath = join(ROOT, '.local/bridge-token');
mkdirSync(dirname(tokenPath), { recursive: true });
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(24).toString('hex'));
const TOKEN = readFileSync(tokenPath, 'utf8').trim();

const ENGINES_ROOT = join(ROOT, '.local/engines');
const VERSION = '1.18.1';
/**
 * Pick the fastest backend that is actually installed and measured here. On this machine the Intel
 * Arc iGPU via OpenCL is ~5x the Eigen CPU path, so hard-coding "katago" would quietly leave
 * most of the strength on the table.
 */
function pickFlavor(): { flavor: string; dir: string; vps: number | null } {
  const candidates = ['katago_opencl', 'katago'];
  let best: { flavor: string; dir: string; vps: number | null } | null = null;
  for (const flavor of candidates) {
    const dir = join(ENGINES_ROOT, flavor, VERSION);
    if (!existsSync(join(dir, 'katago.exe'))) continue;
    const tp = join(ROOT, 'fixtures', 'katago', `throughput-${flavor}.json`);
    const vps = existsSync(tp) ? ((JSON.parse(readFileSync(tp, 'utf8')).budgets?.visitsPerSecSingle as number) ?? null) : null;
    if (!best) best = { flavor, dir, vps };
    else if (vps && (!best.vps || vps > best.vps)) best = { flavor, dir, vps };
  }
  return best ?? { flavor: 'katago', dir: join(ENGINES_ROOT, 'katago', VERSION), vps: null };
}

const chosen = pickFlavor();
const engineDir = chosen.dir;
const exe = join(engineDir, 'katago.exe');
const model = existsSync(engineDir) ? readdirSync(engineDir).find((f) => f.endsWith('.bin.gz')) ?? readdirSync(join(ENGINES_ROOT, 'katago', VERSION)).find((f) => f.endsWith('.bin.gz')) : undefined;
const modelDir = readdirSync(engineDir).some((f) => f.endsWith('.bin.gz')) ? engineDir : join(ENGINES_ROOT, 'katago', VERSION);
const config = join(engineDir, `analysis-local-${chosen.flavor}.cfg`);
const throughputPath = join(ROOT, 'fixtures', 'katago', `throughput-${chosen.flavor}.json`);
const throughput = existsSync(throughputPath) ? JSON.parse(readFileSync(throughputPath, 'utf8')) : null;

interface EngineInfo {
  id: string;
  game: 'go';
  tier: 'native' | 'rules-only';
  strength: StrengthLabel;
  version: string;
  caps: { multipv: true; analysisMode: true; ownership: boolean; infinite: true; restrictMoves: true; streaming: true; preemption: false };
}

function strengthOf(): StrengthLabel {
  if (!model || !existsSync(exe)) {
    return { band: 'none', measured: false, note: '未安装本地引擎：node tools/fetch-engines.mjs katago' };
  }
  const vps = throughput?.budgets?.visitsPerSecSingle as number | undefined;
  if (!vps) {
    return { band: 'max', measured: false, note: 'KataGo b18c384nbt（本机算力未实测，请先跑 bench:katago）' };
  }
  return {
    band: 'max',
    measured: true,
    note: `KataGo ${model.replace('kata1-', '').replace('.bin.gz', '')} · ${chosen.flavor === 'katago_opencl' ? 'OpenCL / Arc 核显' : 'Eigen CPU'}`,
    throughput: { unit: 'visits/s', value: vps },
  };
}

const info: EngineInfo = {
  id: 'katago-native',
  game: 'go',
  tier: model && existsSync(exe) ? 'native' : 'rules-only',
  strength: strengthOf(),
  version: 'v1.18.1',
  caps: { multipv: true, analysisMode: true, ownership: true, infinite: true, restrictMoves: true, streaming: true, preemption: false },
};

let client: KatagoClient | null = null;
function engine(): KatagoClient {
  if (!model) throw new Error('KataGo not installed — run: node tools/fetch-engines.mjs katago');
  if (!client) {
    client = new KatagoClient({ exe, config, model: join(modelDir, model), quiet: true });
  }
  return client;
}

/** One search at a time: KataGo eats every core, and an interleaved second search helps nobody. */
type Job = () => Promise<void>;
const queue: Job[] = [];
let busy = false;
function enqueue(job: Job): void {
  queue.push(job);
  if (!busy) void pump();
}
async function pump(): Promise<void> {
  busy = true;
  while (queue.length) {
    const job = queue.shift()!;
    try {
      await job();
    } catch (e) {
      console.error('[bridge] job failed:', (e as Error).message);
    }
  }
  busy = false;
}

const games = new Map<string, { clock: ClockState; tc: TimeControl }>();
const recorder = new Recorder(join(ROOT, '.local/records'));

/** Last final packet per position, so a recorded move can be scored against what the engine believed right before it. */
const packetCache = new Map<string, { visits: number; best: string; bestWinrate: number; bestScoreLead: number; candidates: Map<string, { winrate: number; scoreLead: number; visits: number; share: number }> }>();

/** Points lead as reported by KataGo is from the side-to-move's view; keep that convention here. */
function leadOf(c: AnalysisPacket['candidates'][number]): number {
  return c.score.kind === 'points' ? c.score.lead : 0;
}

function rememberPacket(pos: GoPosition, p: AnalysisPacket): void {
  const cands = new Map<string, { winrate: number; scoreLead: number; visits: number; share: number }>();
  for (const c of p.candidates) {
    cands.set(c.move.toUpperCase() === 'PASS' ? 'PASS' : c.move, {
      winrate: c.winrate ?? 0,
      scoreLead: leadOf(c),
      visits: c.visits ?? 0,
      share: c.share ?? 0,
    });
  }
  const top = p.candidates[0];
  packetCache.set(positionKey(pos), {
    visits: p.meta.params.visits ?? 0,
    best: top ? (top.move.toUpperCase() === 'PASS' ? 'PASS' : top.move) : 'PASS',
    bestWinrate: top?.winrate ?? 0,
    bestScoreLead: top ? leadOf(top) : 0,
    candidates: cands,
  });
  if (packetCache.size > 400) packetCache.delete(packetCache.keys().next().value as string);
}

function baselineFor(prevPos: GoPosition, played: string): Baseline {
  const cached = packetCache.get(positionKey(prevPos));
  if (!cached) {
    return { best: '?', note: 'no-baseline' } as Baseline;
  }
  const c = cached.candidates.get(played.toUpperCase() === 'PASS' ? 'PASS' : played);
  return {
    best: cached.best,
    bestWinrate: cached.bestWinrate,
    bestScoreLead: cached.bestScoreLead,
    visits: cached.visits,
    playedWinrate: c ? c.winrate : null,
    playedScoreLead: c ? c.scoreLead : null,
    playedVisits: c?.visits ?? 0,
    playedShare: c?.share ?? 0,
  };
}

function positionFromMoves(moves: string[]) {
  let pos = startPosition();
  for (const m of moves) {
    const r = tryMove(pos, m);
    if (!r.ok || !r.position) throw new Error(`illegal move ${m} at ply ${pos.moves.length}: ${r.reason}`);
    pos = r.position;
  }
  return pos;
}

async function analyse(moves: string[], budget: Budget, onDelta: (p: Awaited<ReturnType<typeof toPacket>>, final: boolean) => void, adopt?: { stop: () => void }): Promise<void> {
  const pos = positionFromMoves(moves);
  // 'infinite' is one chunk of a caller-driven escalation, not a 27-hour search.
  const maxVisits = budget.kind === 'visits' ? budget.n : budget.kind === 'infinite' ? 20_000 : undefined;
  const q = positionToQuery(pos, {
    id: `${positionKey(pos)}-${Date.now()}`,
    ...(maxVisits ? { maxVisits } : {}),
    includeOwnership: true,
    ...(budget.kind === 'ms' || budget.kind === 'infinite' ? { reportDuringSearchEvery: 0.5 } : {}),
  });
  const t0 = Date.now();
  const meta = {
    backendId: info.id,
    tier: info.tier,
    strength: info.strength,
    engineVersion: info.version,
    threads: 8,
  };
  const res: KatagoResponse = await engine().ask(
    q,
    budget.kind === 'infinite' || budget.kind === 'ms'
      ? (partial) => {
          onDelta(toPacket(partial, pos, meta, { elapsedMs: Date.now() - t0, midSearch: true }), false);
        }
      : undefined,
  );
  const finalPacket = toPacket(res, pos, meta, { elapsedMs: Date.now() - t0 });
  rememberPacket(pos, finalPacket);
  onDelta(finalPacket, true);
  adopt?.stop();
}

type Msg = {
  reqId?: string;
  op: 'capabilities' | 'best' | 'analyze' | 'clockStart' | 'clockMove' | 'clockState' | 'recordStart' | 'recordMove' | 'recordEnd' | 'ping';
  game?: 'go';
  moves?: string[];
  budget?: Budget;
  tc?: TimeControl;
  gameId?: string;
  toMove?: 'black' | 'white';
  mode?: string;
  userColor?: 'black' | 'white';
  by?: 'user' | 'engine';
  forceEval?: boolean;
  result?: string;
  reason?: string;
};

function serve(socket: WebSocket): void {
  socket.on('message', (raw) => {
    let msg: Msg;
    try {
      msg = JSON.parse(String(raw)) as Msg;
    } catch {
      socket.send(JSON.stringify({ error: 'bad json' }));
      return;
    }
    const send = (obj: unknown) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(obj));

    switch (msg.op) {
      case 'ping':
        return send({ pong: Date.now(), reqId: msg.reqId });
      case 'capabilities':
        return send({ engines: [info], throughput, clockAuthority: 'bridge', reqId: msg.reqId });
      case 'best':
        return void enqueue(async () => {
          try {
            await analyse(msg.moves ?? [], msg.budget ?? { kind: 'visits', n: 200 }, (packet, final) => {
              if (final) send({ reqId: msg.reqId, best: packet.candidates[0]?.move ?? 'PASS', packet });
              else send({ reqId: msg.reqId, partial: packet });
            });
          } catch (e) {
            send({ reqId: msg.reqId, error: (e as Error).message });
          }
        });
      case 'analyze':
        return void enqueue(async () => {
          try {
            await analyse(msg.moves ?? [], msg.budget ?? { kind: 'visits', n: 200 }, (packet, final) =>
              send({ reqId: msg.reqId, packet, final }),
            );
          } catch (e) {
            send({ reqId: msg.reqId, error: (e as Error).message });
          }
        });
      case 'clockStart': {
        const id = msg.gameId ?? 'g';
        const tc = msg.tc ?? { kind: 'untimed' as const };
        const clock = initialClock(tc, msg.toMove ?? 'black', Date.now());
        games.set(id, { clock, tc });
        return send({ reqId: msg.reqId, clock });
      }
      case 'clockMove': {
        const g = games.get(msg.gameId ?? '');
        if (!g) return send({ reqId: msg.reqId, error: 'unknown game' });
        g.clock = playedMove(g.clock, g.tc, Date.now());
        return send({ reqId: msg.reqId, clock: g.clock });
      }
      case 'clockState':
        return send({ reqId: msg.reqId, clock: games.get(msg.gameId ?? '')?.clock ?? null });
      case 'recordStart': {
        const id = recorder.start({
          t: 'start',
          at: new Date().toISOString(),
          gameId: msg.gameId ?? `game-${Date.now()}`,
          mode: msg.mode ?? 'match',
          timeControl: msg.tc ?? { kind: 'untimed' },
          engine: { ...info, strength: info.strength },
          userColor: msg.userColor ?? 'black',
        });
        return send({ reqId: msg.reqId, gameId: id });
      }
      case 'recordMove': {
        const moves = msg.moves ?? [];
        const played = moves[moves.length - 1];
        const gameId = msg.gameId ?? '';
        if (!played || !recorder.isOpen(gameId)) return send({ reqId: msg.reqId, error: 'no open game' });
        let mover: 'black' | 'white' = 'black';
        let baseline: Baseline | undefined;
        try {
          const prevPos = positionFromMoves(moves.slice(0, -1));
          mover = prevPos.toMove;
          baseline = baselineFor(prevPos, played);
        } catch (e) {
          return send({ reqId: msg.reqId, error: (e as Error).message });
        }
        recorder.write({
          t: 'move',
          at: new Date().toISOString(),
          gameId,
          ply: moves.length - 1,
          color: mover,
          by: msg.by ?? 'user',
          vertex: played,
          clock: games.get(gameId)?.clock ?? null,
          baseline,
        });
        // A move the engine never searched has no honest number yet — go get one at low priority.
        const soft = baseline?.note === 'no-baseline' || baseline?.playedWinrate == null || (baseline.playedVisits ?? 0) < 20;
        if (msg.by === 'user' && msg.forceEval && soft) {
          const pos = positionFromMoves(moves.slice(0, -1));
          const player = mover === 'black' ? 'B' : 'W';
          enqueue(async () => {
            try {
              const res = await engine().ask(
                positionToQuery(pos, {
                  id: `eval-${gameId}-${moves.length}`,
                  maxVisits: 200,
                  allowMoves: [{ player, moves: [played === 'PASS' ? 'pass' : played], untilDepth: 1 }],
                }),
              );
              const m = res.moveInfos.find((x) => x.move.toUpperCase() === played.toUpperCase()) ?? res.moveInfos[0];
              recorder.write({
                t: 'eval',
                at: new Date().toISOString(),
                gameId,
                ply: moves.length - 1,
                vertex: played,
                winrate: m ? m.winrate : null,
                scoreLead: m ? m.scoreLead : null,
                visits: m?.visits ?? 0,
                note: 'forced-allowMoves',
              });
            } catch (e) {
              recorder.write({ t: 'eval', at: new Date().toISOString(), gameId, ply: moves.length - 1, vertex: played, winrate: null, scoreLead: null, visits: 0, note: `failed: ${(e as Error).message}` });
            }
          });
        }
        return send({ reqId: msg.reqId, recorded: true, baseline });
      }
      case 'recordEnd': {
        const gameId = msg.gameId ?? '';
        recorder.end(gameId, msg.result ?? '?', msg.reason ?? '?');
        return send({ reqId: msg.reqId, recorded: true, games: recorder.list() });
      }
      default:
        return send({ reqId: msg.reqId, error: `unknown op ${(msg as { op: string }).op}` });
    }
  });
}

const http: Server = createServer((req: IncomingMessage, res) => {
  if (req.url === '/capabilities') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ engines: [info], throughput, clockAuthority: 'bridge' }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true });
// A browser client proves itself by Origin (it cannot forge one); scripts use the token file.
const ALLOWED_ORIGINS = (process.env.BRIDGE_ORIGINS ?? 'http://localhost:3100,http://127.0.0.1:3100').split(',');
http.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const origin = req.headers.origin;
  const ok = url.searchParams.get('token') === TOKEN || (origin && ALLOWED_ORIGINS.includes(origin));
  if (!ok) {
    sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    sock.destroy();
    return;
  }
  wss.handleUpgrade(req, sock, head, (ws) => serve(ws));
});

http.listen(PORT, HOST, () => {
  console.log(`[bridge] ws://127.0.0.1:${PORT} (token in .local/bridge-token)`);
  console.log(`[bridge] katago ${info.tier} — ${info.strength.note}`);
  if (!throughput) console.log('[bridge] no measured throughput yet — run: npm run bench:katago');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void client?.shutdown();
    http.close();
    process.exit(0);
  });
}
