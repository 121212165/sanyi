#!/usr/bin/env node
/**
 * Measures KataGo on THIS machine and writes fixtures/katago/throughput.json.
 * Every per-move budget, review sweep cost and ETA in the app is derived from that file —
 * guessing these numbers is exactly how a training app ends up lying to its user.
 *
 *   npx tsx tools/bench-katago.ts [--threads 8] [--quick]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameTree, goAdapter, legalVertices, startPosition, tryMove } from '@sanyi/core';
import { KatagoClient, positionToQuery, type KatagoResponse } from '@sanyi/engine';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'fixtures', 'katago');
const QUICK = process.argv.includes('--quick');
const THREADS = Number(flag('--threads') ?? Math.max(2, Math.min(8, (await import('node:os')).cpus().length - 4)));

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const FLAVOR = flag('--flavor') ?? 'katago';
/** The network lives with the default flavor; other backends reuse it instead of re-downloading. */
const netHome = join(ROOT, '.local/engines/katago/1.18.1');
const dir = join(ROOT, '.local/engines', FLAVOR, '1.18.1');
const exe = join(dir, 'katago.exe');
const model = readdirSync(dir).find((f) => f.endsWith('.bin.gz')) ?? readdirSync(netHome).find((f) => f.endsWith('.bin.gz'));
const modelDir = readdirSync(dir).some((f) => f.endsWith('.bin.gz')) ? dir : netHome;
if (!existsSync(exe) || !model) {
  console.error('run: node tools/fetch-engines.mjs katago');
  process.exit(1);
}

// Start from KataGo's shipped example config and only rewrite keys that already exist in it:
// KataGo hard-fails on unknown config keys.
const cfgPath = join(dir, `analysis-local-${FLAVOR}.cfg`);
if (!existsSync(cfgPath)) {
  const lines = readFileSync(join(dir, 'analysis_example.cfg'), 'utf8').split('\n');
  const set = (k: string, v: string | number) => {
    const i = lines.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${k} = ${v}`;
  };
  set('numAnalysisThreads', 1);
  set('numSearchThreadsPerAnalysisThread', THREADS);
  set('maxVisits', 5000);
  writeFileSync(cfgPath, lines.join('\n'));
}

const client = new KatagoClient({ exe, config: cfgPath, model: join(modelDir, model), quiet: true });
const t0 = Date.now();
await client.start();
console.log(`katago up in ${((Date.now() - t0) / 1000).toFixed(1)}s (model load included), threads=${THREADS}, net=${model}`);

async function timed(q: Parameters<typeof positionToQuery>[1] & { id: string }, pos = freshPos(0)): Promise<{ res: KatagoResponse; ms: number }> {
  const full = positionToQuery(pos, q);
  const t = Date.now();
  const res = await client.ask(full);
  return { res, ms: Date.now() - t };
}

/**
 * Every measurement needs its own position: KataGo caches root searches, so re-asking the same
 * position reports a throughput many times higher than the machine can really deliver.
 */
const ALL_POINTS = legalVertices(startPosition()).filter((v) => v !== 'PASS');
function freshPos(index: number, plies = 8): GoPositionLike {
  let pos = startPosition();
  for (let i = 0; i < plies; i++) {
    const v = ALL_POINTS[(index * 137 + i * 41) % ALL_POINTS.length]!;
    const r = tryMove(pos, v);
    if (!r.ok || !r.position) {
      pos = tryMove(pos, 'PASS').position!;
      continue;
    }
    pos = r.position;
  }
  return pos;
}
type GoPositionLike = ReturnType<typeof startPosition>;

const out: Record<string, unknown> = {
  measuredAt: new Date().toISOString(),
  machine: { cpu: (await import('node:os')).cpus()[0]?.model, logicalCores: (await import('node:os')).cpus().length, totalMemGB: Math.round((await import('node:os')).totalmem() / 1e9) },
  net: model,
  searchThreads: THREADS,
  startupSec: +((Date.now() - t0) / 1000).toFixed(1),
};

// ---- 1. single position: what one "think" costs during a game
const singles: { maxVisits: number; visits: number; visitsPerSec: number; secPerMove: number }[] = [];
let idx = 0;
for (const v of QUICK ? [50] : [50, 200, 1000]) {
  const { res, ms } = await timed({ id: `single-${v}`, maxVisits: v }, freshPos(++idx));
  const visits = res.rootInfo?.visits ?? 0;
  singles.push({ maxVisits: v, visits, visitsPerSec: +((visits / ms) * 1000).toFixed(1), secPerMove: +(ms / 1000).toFixed(1) });
  console.log(`  single  ${String(v).padStart(4)} visits -> ${((visits / ms) * 1000).toFixed(1).padStart(5)} visits/s  (${(ms / 1000).toFixed(1)}s)  best=${res.moveInfos[0]?.move}`);
  if (v === 200) {
    mkdirSync(FIX, { recursive: true });
    writeFileSync(join(FIX, 'analysis-200-visits.json'), JSON.stringify({ request: positionToQuery(freshPos(idx), { id: 'fixture', maxVisits: 200 }), response: res }, null, 2));
  }
}
out.singlePosition = singles;

// ---- 2. ownership doubles memory; find out what it actually costs here (fresh positions both sides)
{
  const a = await timed({ id: 'plain', maxVisits: 200 }, freshPos(++idx));
  const b = await timed({ id: 'own', maxVisits: 200, includeOwnership: true }, freshPos(++idx));
  const rate = (r: { res: KatagoResponse; ms: number }) => ((r.res.rootInfo?.visits ?? 0) / r.ms) * 1000;
  console.log(`  ownership cost: ${(rate(a) / rate(b)).toFixed(2)}x slower (${rate(a).toFixed(1)} -> ${rate(b).toFixed(1)} visits/s)`);
  out.ownershipCost = { without: +rate(a).toFixed(1), with: +rate(b).toFixed(1) };
}

// ---- 3. review sweep: analyzeTurns is how a whole game gets analysed; batch threads is the lever
const wide = new GameTree(goAdapter);
let at = wide.rootId;
const order = legalVertices(startPosition()).filter((v) => v !== 'PASS');
const spread = order.filter((_, i) => i % 7 === 0).slice(0, QUICK ? 12 : 40);
for (const v of spread) at = wide.append(at, v, { rawMove: v }).id;
const sweepPos = wide.node(at).position;
const plies = sweepPos.moves.length;
const review: { numAnalysisThreads: number; positions: number; visitsPerPosition: number; wallSec: number; secPerPosition: number; aggregateVisitsPerSec: number }[] = [];
for (const threads of QUICK ? [1] : [1, 2, 4]) {
  const c = new KatagoClient({ exe, config: cfgPath, model: join(modelDir, model), numAnalysisThreads: threads, quiet: true });
  const moves: [string, string][] = [];
  let black = true;
  for (const v of sweepPos.moves) {
    moves.push([black ? 'B' : 'W', v]);
    black = !black;
  }
  const t = Date.now();
  const res = await c.ask({
    id: `sweep-${threads}`,
    moves,
    rules: 'chinese',
    komi: 7.5,
    boardXSize: 19,
    boardYSize: 19,
    maxVisits: 60,
    analyzeTurns: Array.from({ length: plies + 1 }, (_, i) => i),
  });
  const wall = (Date.now() - t) / 1000;
  const row = {
    numAnalysisThreads: threads,
    positions: plies + 1,
    visitsPerPosition: 60,
    wallSec: +wall.toFixed(1),
    secPerPosition: +(wall / (plies + 1)).toFixed(2),
    aggregateVisitsPerSec: +(((plies + 1) * (res.rootInfo?.visits ?? 60)) / wall).toFixed(1),
  };
  review.push(row);
  console.log(`  review   batchThreads=${threads}  ${row.positions} positions @60  ${row.wallSec}s total  ${row.secPerPosition}s/position`);
  await c.shutdown();
}
out.reviewBatch = review;

// ---- 4. streaming: how fast the first suggestion appears on a fresh position while it keeps searching
{
  const streamPos = freshPos(++idx);
  const t = Date.now();
  let firstMs = 0;
  let firstVisits = 0;
  let lastVisits = 0;
  for await (const r of client.stream(positionToQuery(streamPos, { id: 'stream', maxVisits: 600, reportDuringSearchEvery: 0.5 }))) {
    if (!firstMs) {
      firstMs = Date.now() - t;
      firstVisits = r.rootInfo?.visits ?? 0;
    }
    lastVisits = r.rootInfo?.visits ?? lastVisits;
  }
  console.log(`  streaming first report ${(firstMs / 1000).toFixed(1)}s @${firstVisits} visits, done ${lastVisits} visits in ${((Date.now() - t) / 1000).toFixed(1)}s`);
  out.streaming = { firstReportMs: firstMs, firstReportVisits: firstVisits, endVisits: lastVisits, totalMs: Date.now() - t };
}

// ---- 5. the budgets the app will actually use, written from the numbers above
const vps = singles[singles.length - 1]!.visitsPerSec;
out.budgets = {
  visitsPerSecSingle: vps,
  blitzMoveMs: 2000,
  blitzMoveVisits: Math.round(vps * 2),
  untimedMoveCapVisits: Math.round(vps * 20),
  reviewSweepVisits: 60,
  reviewDeepVisits: Math.round(vps * 20),
  reviewSecondsPerPosition: review.find((r) => r.numAnalysisThreads === 2)?.secPerPosition ?? review[0]!.secPerPosition,
  secondsFor: Object.fromEntries([20, 100, 200, 1000, 5000, 20000].map((v) => [`${v} visits`, +(v / vps).toFixed(0)])),
};
console.log('\nbudgets:', JSON.stringify(out.budgets, null, 2));
console.log('\nNOTE: "max difficulty" on untimed is unbounded by design; the cap above is a UI guardrail, not a strength limit.');

await client.shutdown();
writeFileSync(join(FIX, `throughput-${FLAVOR}.json`), JSON.stringify(out, null, 2));
console.log(`\nwrote ${join(FIX, `throughput-${FLAVOR}.json`)}`);
