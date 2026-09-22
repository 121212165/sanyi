'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  BLITZ_PRESETS,
  GameTree,
  formatRemaining,
  goAdapter,
  remainingNow,
  scoreArea,
  terminal,
  tryMove,
  type AnalysisPacket,
  type ClockState,
  type GoPosition,
  type Side,
  type TimeControl,
} from '@sanyi/core';
import { GoBoard } from '@/components/GoBoard';
import { bridge, type Capabilities } from '@/lib/bridge';

type Mode = 'match' | 'learn';
type Phase = 'connecting' | 'no-bridge' | 'user' | 'engine' | 'scoring' | 'over';

/** One record per page load, so a reload never overwrites an earlier game. */
const GAME_ID = typeof window === 'undefined' ? 'go' : `go-${Date.now().toString(36)}`;

function nodeMoves(tree: GameTree<GoPosition, string>, id: string): string[] {
  return tree.node(id).position.moves;
}

export default function Play() {
  const treeRef = useRef(new GameTree(goAdapter));
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [cur, setCur] = useState(() => treeRef.current.rootId);
  const [view, setView] = useState(() => treeRef.current.rootId);
  const [mode, setMode] = useState<Mode>('match');
  const [tcIndex, setTcIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [clock, setClock] = useState<ClockState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [packets, setPackets] = useState<Record<string, AnalysisPacket>>({});
  const [engineThinking, setEngineThinking] = useState('');
  const [notice, setNotice] = useState('');
  const [userColor] = useState<Side>('black');
  /** Every user move gets a real engine number, at the cost of one extra search per move. */
  const [recordQuality, setRecordQuality] = useState(true);
  const adoptRef = useRef(false);
  const aliveRef = useRef(true);
  /** The bridge names the game (it never overwrites an existing record), so the page follows its id. */
  const gameIdRef = useRef<string>(GAME_ID);
  /** Lets the mount effect start the first game without a dependency cycle. */
  const newGameRef = useRef<(() => Promise<void>) | null>(null);

  const tc = BLITZ_PRESETS[tcIndex]!.tc as TimeControl;
  const tree = treeRef.current;
  const pos = tree.node(view).position;
  const packet = packets[view];
  const isUserTurn = pos.toMove === userColor;

  const blitzVisits = useMemo(() => {
    const b = caps?.throughput?.budgets as { blitzMoveVisits?: number } | undefined;
    return b?.blitzMoveVisits ?? 20;
  }, [caps]);

  const learnVisits = Math.max(100, blitzVisits * 2);

  useEffect(() => {
    aliveRef.current = true;
    const attach = () =>
      bridge
        .connect()
        .then((c) => {
          setCaps(c);
          setPhase((prev) => (prev === 'connecting' || prev === 'no-bridge' ? 'user' : prev));
        })
        .catch(() => setPhase((prev) => (prev === 'user' || prev === 'engine' ? prev : 'no-bridge')));
    attach();
    // Without this the very first game of a fresh page has no record at all: recordStart only
    // happens in newGame(), which nothing called on mount.
    const startedOnce = { done: false };
    const kickoff = setInterval(() => {
      if (startedOnce.done || !bridge.connected) return;
      startedOnce.done = true;
      clearInterval(kickoff);
      void newGameRef.current?.();
    }, 400);
    // The bridge is a separate process the user may restart; a dead socket must come back by itself.
    const retry = setInterval(() => {
      if (!bridge.connected && !bridge.isConnecting) void attach();
    }, 3000);
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => {
      aliveRef.current = false;
      clearInterval(t);
      clearInterval(retry);
      clearInterval(kickoff);
    };
  }, []);

  const strength = caps?.engines[0]?.strength;
  const tier = caps?.engines[0]?.tier;

  const store = useCallback((id: string, p: AnalysisPacket) => setPackets((prev) => ({ ...prev, [id]: p })), []);

  /** The engine's turn. Untimed keeps escalating its budget until you adopt the current move. */
  const runEngine = useCallback(
    async (atNode: string) => {
      const moves = nodeMoves(treeRef.current, atNode);
      setPhase('engine');
      setEngineThinking(tc.kind === 'untimed' ? '不限时：引擎持续加算，可随时采纳' : `快棋：${blitzVisits} visits`);
      try {
        if (tc.kind === 'untimed') {
          let visits = 100;
          let chosen = 'PASS';
          while (aliveRef.current && visits <= 30_000) {
            const r = await bridge.best(moves, { kind: 'visits', n: visits }, (p) => store(atNode, p));
            store(atNode, r.packet);
            chosen = r.best;
            if (adoptRef.current) break;
            visits *= 3;
          }
          adoptRef.current = false;
          setEngineThinking('');
          commit(atNode, chosen, 'engine');
        } else {
          const r = await bridge.best(moves, { kind: 'visits', n: blitzVisits });
          store(atNode, r.packet);
          setEngineThinking('');
          commit(atNode, r.best, 'engine');
        }
      } catch (e) {
        setNotice(`引擎失败：${(e as Error).message}`);
        setPhase('user');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blitzVisits, store, tc],
  );

  /** Ask the bridge to analyse a position in the background; never blocks the player. */
  const analyze = useCallback(
    (id: string) => {
      if (!bridge.connected) return;
      const moves = nodeMoves(treeRef.current, id);
      void bridge
        .analyze(moves, { kind: 'visits', n: learnVisits })
        .then((a) => store(id, a.packet))
        .catch(() => {});
    },
    [learnVisits, store],
  );

  const commit = useCallback(
    (atNode: string, vertex: string, by: 'user' | 'engine') => {
      const t = treeRef.current;
      const node = t.append(atNode, vertex, { rawMove: vertex });
      setCur(node.id);
      setView(node.id);
      force();
      void bridge
        .recordMove({ gameId: gameIdRef.current, moves: node.position.moves, by, forceEval: recordQuality })
        .catch(() => {});
      if (tc.kind !== 'untimed') {
        bridge.clockMove(gameIdRef.current).then((r) => setClock(r.clock)).catch(() => {});
      }
      const term = terminal(node.position);
      if (term?.over) {
        finish(node.position);
        return;
      }
      if (node.position.toMove !== userColor) void runEngine(node.id);
      else {
        setPhase('user');
        if (mode === 'learn' || recordQuality) analyze(node.id);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [analyze, mode, recordQuality, runEngine, tc, userColor],
  );

  const finish = useCallback(
    (p: GoPosition) => {
      const s = scoreArea(p);
      setPhase('scoring');
      const text = `${s.winner === 'black' ? '黑胜' : s.winner === 'white' ? '白胜' : '和'} ${Math.abs(s.margin).toFixed(1)} 目`;
      setNotice(`终局（未标记死子）：黑 ${s.black} ／ 白 ${s.white} + 贴目 ${s.komi} → ${text}`);
      void bridge.recordEnd(gameIdRef.current, text, 'two-passes').catch(() => {});
    },
    [],
  );

  const play = useCallback(
    (vertex: string) => {
      if (phase !== 'user' || !isUserTurn) return;
      const t = treeRef.current;
      const r = tryMove(t.node(cur).position, vertex);
      if (!r.ok) {
        setNotice(`非法着法：${r.reason}`);
        return;
      }
      setNotice('');
      commit(cur, vertex, 'user');
    },
    [commit, cur, isUserTurn, phase],
  );

  const newGame = useCallback(async () => {
    adoptRef.current = false;
    setPackets({});
    setNotice('');
    treeRef.current = new GameTree(goAdapter);
    const root = treeRef.current.rootId;
    setCur(root);
    setView(root);
    force();
    setPhase('user');
    const started = await bridge
      .recordStart({ gameId: GAME_ID, mode, tc, userColor })
      .catch(() => ({ gameId: GAME_ID }));
    gameIdRef.current = started.gameId;
    if (tc.kind !== 'untimed') {
      const r = await bridge.clockStart(started.gameId, tc, 'black').catch(() => null);
      setClock(r?.clock ?? null);
    } else {
      setClock(null);
    }
    if (userColor !== 'black') void runEngine(root);
  }, [mode, runEngine, tc, userColor]);

  newGameRef.current = newGame;

  const resign = () => {
    setPhase('over');
    const text = `${userColor === 'black' ? 'W' : 'B'}+R`;
    setNotice(`你认输，${userColor === 'black' ? '白' : '黑'}胜（引擎）`);
    void bridge.recordEnd(gameIdRef.current, text, 'resign').catch(() => {});
  };

  const path = tree.path(cur);
  const viewIdx = path.indexOf(view);

  return (
    <main className="shell">
      <header className="bar">
        <strong>三弈 · 围棋</strong>
        <span className="badge" data-tier={tier}>
          对手：{strength ? `${strength.note}${strength.measured ? '' : '（未实测）'}` : '未连接'}
        </span>
        <span className={`dot ${phase === 'connecting' ? 'wait' : tier === 'native' ? 'ok' : 'bad'}`} />
        <label>
          模式
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} disabled={phase === 'engine'}>
            <option value="match">比赛（不讲解、不可提问）</option>
            <option value="learn">学习（引擎数据 + 可推演）</option>
          </select>
        </label>
        <label>
          赛制
          <select value={tcIndex} onChange={(e) => setTcIndex(Number(e.target.value))}>
            {BLITZ_PRESETS.map((p, i) => (
              <option key={p.label} value={i}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="toggle" title="每手棋都让引擎单独算一遍，用来量化你这一手亏了多少；代价是每手多等约 2 秒">
          <input type="checkbox" checked={recordQuality} onChange={(e) => setRecordQuality(e.target.checked)} />
          完整记录每手质量
        </label>
        <button onClick={newGame}>新对局</button>
        <button onClick={resign} disabled={phase === 'over'}>认输</button>
        <button onClick={() => play('PASS')} disabled={!isUserTurn || phase !== 'user'}>虚着</button>
        {tc.kind === 'untimed' && phase === 'engine' && (
          <button className="adopt" onClick={() => (adoptRef.current = true)}>
            采纳当前着法
          </button>
        )}
      </header>

      {mode === 'learn' && (
        <p className="disclaimer">引擎不提供思考过程，以下是搜索数据与对数据的推断。</p>
      )}

      <section className="board-area">
        <GoBoard
          pos={pos}
          onPlay={play}
          disabled={phase !== 'user' || !isUserTurn}
          lastMove={tree.node(view).rawMove}
          suggestion={mode === 'learn' ? packet?.candidates[0]?.move : undefined}
          ownership={mode === 'learn' ? packet?.score?.ownershipGrid : undefined}
        />

        <aside className="rail">
          <h3>棋谱（{path.length - 1} 手）</h3>
          <ol className="movelist">
            {path.slice(1).map((id, i) => (
              <li key={id} className={id === view ? 'sel' : ''}>
                <button onClick={() => setView(id)}>{i + 1}. {tree.node(id).rawMove}</button>
                {packets[id] ? <em className="ev">{fmt(packets[id])}</em> : null}
              </li>
            ))}
          </ol>
          <div className="nav">
            <button onClick={() => setView(path[Math.max(0, viewIdx - 1)] ?? tree.rootId)}>←</button>
            <button onClick={() => setView(path[Math.min(path.length - 1, viewIdx + 1)] ?? cur)}>→</button>
            <button onClick={() => setView(cur)}>末</button>
          </div>
          {pos.moves.length >= 2 && pos.passes >= 2 && <p className="muted">双方连续虚着，进入数子。</p>}
        </aside>

        <aside className="panel">
          <h3>引擎数据</h3>
          {!packet && <p className="muted">（本局面尚无引擎数据）</p>}
          {packet && (
            <>
              <table className="cands">
                <thead>
                  <tr><th>着法</th><th>visits</th><th>胜率</th><th>目差</th></tr>
                </thead>
                <tbody>
                  {packet.candidates.slice(0, 5).map((c) => (
                    <tr key={c.move}>
                      <td>{c.label}</td>
                      <td>{c.visits}</td>
                      <td>{c.winrate !== undefined ? (c.winrate * 100).toFixed(1) + '%' : '—'}</td>
                      <td>{c.score.kind === 'points' ? (c.score.lead >= 0 ? '+' : '') + c.score.lead.toFixed(1) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">
                用时 {packet.meta.elapsedMs} ms · {packet.meta.params.visits} visits · 后端 {packet.meta.backendId}
              </p>
              {packet.candidates[0]?.pv?.length ? (
                <p className="pv">主线：{packet.candidates[0].pv.slice(0, 12).join(' ')}</p>
              ) : null}
              {packet.insufficiency.length > 0 && (
                <p className="warn">数据不足：{packet.insufficiency.join(', ')}</p>
              )}
            </>
          )}
          {engineThinking && <p className="thinking">{engineThinking}</p>}
          {packet?.score?.ownershipGrid && (
            <p className="muted small">棋盘热度 = 引擎归属判断（黑正白负），来自 includeOwnership。</p>
          )}
        </aside>
      </section>

      <footer className="bar">
        {tc.kind !== 'untimed' && clock ? (
          <span className="clocks">
            黑 {formatRemaining(Math.max(0, clock.toMove === 'black' ? remainingNow(clock, tc, now) : clock.main.black))}
            {' / '}
            白 {formatRemaining(Math.max(0, clock.toMove === 'white' ? remainingNow(clock, tc, now) : clock.main.white))}
            {tc.kind === 'byoyomi' ? ` · 读秒 ${clock.periods[clock.toMove]}` : ''}
          </span>
        ) : (
          <span className="muted">不限时 · 引擎不设上限（按「采纳当前着法」落子）</span>
        )}
        {notice && <span className="notice">{notice}</span>}
        {phase === 'no-bridge' && (
          <span className="warn">未连到本地引擎桥：先跑 <code>npm run bridge</code></span>
        )}
      </footer>
    </main>
  );
}

function fmt(p?: AnalysisPacket): string {
  if (!p) return '';
  const c = p.candidates[0];
  if (!c) return '';
  const wr = c.winrate !== undefined ? `${(c.winrate * 100).toFixed(0)}%` : '';
  const pts = c.score.kind === 'points' ? `${c.score.lead >= 0 ? '+' : ''}${c.score.lead.toFixed(1)}` : '';
  return `${c.label} ${wr} ${pts}`;
}
