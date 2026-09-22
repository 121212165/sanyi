#!/usr/bin/env node
/**
 * 复盘解读器：读一盘记录 → 逐点问本地引擎 → 用规则内核算棋盘事实 → 输出中文。
 * 全程不联网、不要 API key，每句话都带一个指向数据字段的证据路径，并当场审计。
 *
 *   npx tsx tools/review.ts                 # 最近一盘
 *   npx tsx tools/review.ts go-mucl29r3     # 指定一盘
 *   npx tsx tools/review.ts --visits 200 --min-pp 4 --json
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { buildReview, explain, audit } from '@sanyi/engine';
import type { AnalysisPacket } from '@sanyi/core';

const root = resolve(process.cwd());
const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const has = (name: string) => process.argv.includes(name);

const VISITS = Number(arg('--visits', '120'));
const MIN_PP = Number(arg('--min-pp', '4'));
const RECORDS = `${root}/.local/records`;

function readRecord(): { gameId: string; events: any[] } {
  const files = existsSync(RECORDS) ? readdirSync(RECORDS).filter((f) => f.endsWith('.jsonl')).sort() : [];
  if (!files.length) throw new Error(`没有对局记录：${RECORDS} 是空的`);
  const named = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
  const pick = named ? `${named}.jsonl` : files[files.length - 1]!;
  if (!existsSync(`${RECORDS}/${pick}`)) throw new Error(`找不到这盘：${named}（可用：${files.map((f) => f.replace('.jsonl', '')).join(', ')}）`);
  const events = readFileSync(`${RECORDS}/${pick}`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { gameId: pick.replace('.jsonl', ''), events };
}

const ws = new WebSocket(`ws://127.0.0.1:8788?token=${readFileSync(`${root}/.local/bridge-token`, 'utf8').trim()}`);
const pending = new Map<string, (v: unknown) => void>();
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.reqId && !m.partial && pending.has(m.reqId)) {
    pending.get(m.reqId)!(m);
    pending.delete(m.reqId);
  }
});
const opened = new Promise<void>((res) => ws.on('open', () => res()));

function rpc(req: Record<string, unknown>): Promise<any> {
  const reqId = `rev${pending.size + 1}`;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`超时：${String(req.op)}`)), 300_000);
    pending.set(reqId, (v: any) => {
      clearTimeout(timer);
      if (v.error) rej(new Error(v.error));
      else res(v);
    });
    void opened.then(() => ws.send(JSON.stringify({ ...req, reqId })));
  });
}
const analyze = async (moves: string[]): Promise<AnalysisPacket> => {
  const r = await rpc({ op: 'analyze', game: 'go', moves, budget: { kind: 'visits', n: VISITS } });
  return r.packet as AnalysisPacket;
};

const { gameId, events } = readRecord();
const start = events.find((e) => e.t === 'start') ?? {};
const moves = events.filter((e) => e.t === 'move').sort((a, b) => a.ply - b.ply).map((e) => e.vertex);
const caps = await rpc({ op: 'capabilities' });
console.log(`解读 ${gameId}：${moves.length} 手，执${start.userColor === 'black' ? '黑' : '白'}，${(start.engine?.strength?.note || caps.engines?.[0]?.strength?.note || '')} · 每点 ${VISITS} visits`);
if (caps.engines?.[0]?.strength?.throughput) console.log(`实测吞吐 ${caps.engines[0].strength.throughput.value} ${caps.engines[0].strength.throughput.unit} → 约 ${(moves.length * VISITS) / caps.engines[0].strength.throughput.value / 60} 分钟`);

const t0 = Date.now();
const bundle = await buildReview(moves, analyze, {
  gameId,
  userColor: start.userColor ?? 'black',
  mode: start.mode ?? 'unknown',
  timeControl: start.timeControl ?? null,
  engine: { note: start.engine?.strength?.note ?? '', throughput: start.engine?.strength?.throughput },
  log: () => {},
});
const ex = explain(bundle, { minPpToShow: MIN_PP });
const auditRes = audit(ex, bundle);
console.log(`分析用时 ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

if (has('--json')) {
  console.log(JSON.stringify({ bundle, explanation: ex, audit: auditRes }, null, 2));
} else {
  console.log('【总评】');
  for (const s of ex.headline) console.log(`  · ${s.text}`);
  console.log(`\n【伤你的 ${ex.moves.length} 手】（阈值 ${MIN_PP}pp）`);
  for (const m of ex.moves) {
    console.log('');
    for (const s of m.sentences) console.log(`  ${s.text}`);
  }
  console.log('\n【这套解读的边界】');
  for (const l of ex.limits) console.log(`  - ${l}`);
  if (bundle.gaps.length) {
    console.log('\n【没测到的】');
    for (const g of bundle.gaps.slice(0, 8)) console.log(`  - ${g}`);
  }
}

console.log(`\n【审计】${auditRes.total} 个证据指针，${auditRes.bad.length} 个对不上`);
for (const b of auditRes.bad.slice(0, 10)) console.log(`  ✗ ${b.path} → ${b.reason} ｜句子：${b.text.slice(0, 60)}`);
if (!auditRes.ok) {
  console.log('\n解读器在说没有依据的话，先修它。');
  process.exitCode = 1;
}
ws.close();
