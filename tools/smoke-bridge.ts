#!/usr/bin/env node
/**
 * End-to-end check against a running bridge: does it name its engine honestly, and does one
 * request come back as a usable AnalysisPacket?  Run after `npm run bridge`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = readFileSync(join(ROOT, '.local/bridge-token'), 'utf8').trim();
const ws = new WebSocket(`ws://127.0.0.1:8788?token=${token}`);

const pending = new Map();
ws.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.reqId && pending.has(m.reqId)) {
    pending.get(m.reqId)(m);
    if (!m.partial) pending.delete(m.reqId);
  }
});
const rpc = (req: Record<string, unknown>, timeoutMs = 240_000): Promise<any> =>
  new Promise((res, rej) => {
    const reqId = `s${pending.size + 1}`;
    const timer = setTimeout(() => rej(new Error(`timeout waiting for ${String(req.op)}`)), timeoutMs);
    pending.set(reqId, (m: any) => {
      if (m.partial) return;
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({ ...req, reqId }));
  });

await new Promise((r) => ws.on('open', r));

const caps = await rpc({ op: 'capabilities' });
const eng = caps.engines[0];
console.log('engine  ', eng.id, eng.tier, '| strength.band:', eng.strength.band, '| measured:', eng.strength.measured);
console.log('note    ', eng.strength.note);
console.log('throughput', eng.strength.throughput ? `${eng.strength.throughput.value} ${eng.strength.throughput.unit}` : 'unknown');
console.log('budgets ', JSON.stringify(caps.throughput?.budgets ?? {}));

// A position the engine has never seen, so no cached root can flatter the timing.
const t0 = Date.now();
const r = await rpc({ op: 'best', game: 'go', moves: ['D4', 'Q16', 'D16', 'C14', 'E17'], budget: { kind: 'visits', n: 100 } });
const p = r.packet;
console.log(`\nbest move for black after D4 Q16 D16: ${r.best}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log('candidates', p.candidates.slice(0, 4).map((c: any) => `${c.move}:${c.visits}v:${(c.winrate * 100).toFixed(1)}%`).join('  '));
console.log('elapsedMs ', p.meta.elapsedMs, '| visits', p.meta.params.visits, '| insufficiency', JSON.stringify(p.insufficiency));
console.log('ownership grid', p.score?.ownershipGrid ? `${p.score.ownershipGrid.length}x${p.score.ownershipGrid[0].length}` : 'absent');
console.log('pv          ', p.candidates[0]?.pv.slice(0, 6).join(' '));

const bad = await rpc({ op: 'best', game: 'go', moves: ['D4', 'D4'], budget: { kind: 'visits', n: 5 } }).catch((e) => ({ error: e.message }));
console.log('\nillegal history handled:', bad.error ?? 'NO ERROR — bug');

ws.close();
console.log('\nsmoke ok');
