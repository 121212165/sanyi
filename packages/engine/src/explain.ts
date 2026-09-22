import type { ReviewBundle, ReviewRow } from './review.ts';

export interface Sentence {
  text: string;
  /** Field paths inside the ReviewBundle this sentence is allowed to speak about. */
  evidence: string[];
  /** measured = a number the engine produced; derived = computed from the rules by our own kernel. */
  provenance: 'measured' | 'derived';
}

export interface MoveExplanation {
  ply: number;
  moveNumber: number;
  vertex: string;
  lossPp: number | null;
  severity: ReviewRow['severity'];
  sentences: Sentence[];
}

export interface Explanation {
  headline: Sentence[];
  moves: MoveExplanation[];
  /** Written in the same voice as the rest, so nothing here is a claim about intent. */
  limits: string[];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function pvText(pv: string[]): string {
  return pv.slice(0, 8).join(' ');
}

/** One move's worth of sentences. Every branch is guarded by the field it cites. */
function explainRow(r: ReviewRow, path: string): Sentence[] {
  const out: Sentence[] = [];
  const f = r.facts;

  if (r.lossPp === null) {
    out.push({ text: `第 ${r.moveNumber} 手 ${r.vertex}：这一手没有可用的引擎数值（该局面未被搜索）。`, evidence: [`${path}.lossPp`], provenance: 'measured' });
    return out;
  }

  const before = r.blackWinrateBefore !== null ? (r.color === 'black' ? r.blackWinrateBefore : 1 - r.blackWinrateBefore) : null;
  const after = r.blackWinrateAfter !== null ? (r.color === 'black' ? r.blackWinrateAfter : 1 - r.blackWinrateAfter) : null;
  const verdict = r.severity === 'blunder' ? '大漏' : r.severity === 'mistake' ? '失误' : r.severity === 'soft' ? '欠佳' : '没亏';
  out.push({
    text: `第 ${r.moveNumber} 手 ${r.vertex}：${verdict}，亏 ${r.lossPp} 个百分点（你的胜率 ${before !== null ? pct(before) : '?'} → ${after !== null ? pct(after) : '?'}）。`,
    evidence: [`${path}.lossPp`, `${path}.blackWinrateBefore`, `${path}.blackWinrateAfter`],
    provenance: 'measured',
  });

  if (r.engineBest && r.engineBest !== r.vertex) {
    const s: Sentence = {
      text: `引擎选 ${r.engineBest}（它当时只给了 ${r.visits ?? '?'} 次访问）。`,
      evidence: [`${path}.engineBest`, `${path}.visits`],
      provenance: 'measured',
    };
    out.push(s);
    if (r.enginePv.length > 1) {
      out.push({
        text: `它算的后续是：${pvText(r.enginePv)}。`,
        evidence: [`${path}.enginePv`],
        provenance: 'measured',
      });
    }
  }

  // Board facts: these come from our own rules kernel, not from the engine's opinion.
  if (f.capturedByMove > 0) {
    out.push({ text: `这手当场提掉对方 ${f.capturedByMove} 子。`, evidence: [`${path}.facts.capturedByMove`], provenance: 'derived' });
  }
  if (f.inAtari) {
    out.push({ text: `落完之后自己这块只剩一口气（${f.groupSize} 子被打吃）。`, evidence: [`${path}.facts.inAtari`, `${path}.facts.groupSize`], provenance: 'derived' });
  }
  if (f.fate.died) {
    out.push({
      text: `你落在 ${f.fate.points.join('/')} 的这块棋，到第 ${(f.fate.diedAtPly ?? 0) + 1} 手被全部提掉（${f.fate.stonesLost} 子，收子的是 ${f.fate.killedBy ?? '?'}）。`,
      evidence: [`${path}.facts.fate.died`, `${path}.facts.fate.stonesLost`, `${path}.facts.fate.diedAtPly`, `${path}.facts.fate.killedBy`],
      provenance: 'derived',
    });
  } else if (f.fate.stonesLost > 0) {
    out.push({
      text: `这块 ${f.fate.points.length} 子里后来被提掉 ${f.fate.stonesLost} 子（${f.fate.killedBy ?? '?'} 手），其余活到终局。`,
      evidence: [`${path}.facts.fate.stonesLost`, `${path}.facts.fate.killedBy`],
      provenance: 'derived',
    });
  }
  if (f.answeredLocally && f.replyVertex) {
    out.push({ text: `它立刻在局部应了一手 ${f.replyVertex}。`, evidence: [`${path}.facts.answeredLocally`, `${path}.facts.replyVertex`], provenance: 'derived' });
  }

  if (r.counterfactual) {
    const cf = r.counterfactual;
    out.push({
      text: `如果这手改走 ${cf.ifBest}，它最佳应对之后你还有 ${pct(r.color === 'black' ? cf.blackWinrateIfBest : 1 - cf.blackWinrateIfBest)}（比实际多约 ${Math.abs(cf.gainPp).toFixed(1)} 个百分点）。`,
      evidence: [`${path}.counterfactual`],
      provenance: 'measured',
    });
    if (cf.replyLine.length) {
      out.push({ text: `那条线上的应对：${pvText(cf.replyLine)}。`, evidence: [`${path}.counterfactual.replyLine`], provenance: 'measured' });
    }
  }
  return out;
}

/** Turns a review into plain Chinese, with a field pointer behind every claim. */
export function explain(b: ReviewBundle, opts: { minPpToShow?: number } = {}): Explanation {
  const min = opts.minPpToShow ?? SEVERITY_SOFT;
  const s = b.summary;
  const last = [...b.rows].reverse().find((r) => r.blackWinrateAfter !== null);
  const headline: Sentence[] = [];

  headline.push({
    text: `你这盘执${b.userColor === 'black' ? '黑' : '白'}，下了 ${s.userMoves} 手，其中 ${s.measured} 手有引擎数值。`,
    evidence: ['summary.userMoves', 'summary.measured'],
    provenance: 'derived',
  });
  if (s.avgLossPp !== null) {
    headline.push({
      text: `平均每手亏 ${s.avgLossPp} 个百分点，中位 ${s.medianLossPp}；分布：正常 ${s.counts.normal}、欠佳 ${s.counts.soft}、失误 ${s.counts.mistake}、大漏 ${s.counts.blunder}。`,
      evidence: ['summary.avgLossPp', 'summary.medianLossPp', 'summary.counts'],
      provenance: 'derived',
    });
  }
  if (s.userStonesLost > 0 || s.userCaptures > 0) {
    headline.push({
      text: `盘上事实：你提掉对方 ${s.userCaptures} 子，被对方提掉 ${s.userStonesLost} 子。`,
      evidence: ['summary.userCaptures', 'summary.userStonesLost'],
      provenance: 'derived',
    });
  }
  if (last?.blackWinrateAfter !== null && last) {
    const mine = b.userColor === 'black' ? last.blackWinrateAfter! : 1 - last.blackWinrateAfter!;
    headline.push({
      text: `到第 ${last.moveNumber} 手为止，你的胜率 ${pct(mine)}。`,
      evidence: [`rows[${last.ply}].blackWinrateAfter`],
      provenance: 'measured',
    });
  }

  const moves: MoveExplanation[] = [];
  for (const r of b.rows) {
    if (r.by !== 'user') continue;
    if (r.lossPp === null || r.lossPp < min) continue;
    moves.push({
      ply: r.ply,
      moveNumber: r.moveNumber,
      vertex: r.vertex,
      lossPp: r.lossPp,
      severity: r.severity,
      sentences: explainRow(r, `rows[${r.ply}]`),
    });
  }

  return {
    headline,
    moves,
    limits: [
      '引擎不输出思考过程：以上每条都只引用了搜索数字或棋盘规则事实，没有"它心里怎么想"。',
      '亏损用胜率差衡量，贴目与规则集会影响绝对数值，但同一盘内的相对排序不受影响。',
      '未搜索的手一律标"没有可用数值"，不做推测。',
    ],
  };
}

const SEVERITY_SOFT = 4.0;

/** Resolves a `rows[3].facts.capturedByMove` style path; returns undefined when it does not exist. */
export function resolvePath(root: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export interface AuditResult {
  ok: boolean;
  bad: { text: string; path: string; reason: string }[];
  total: number;
}

/**
 * The honesty check: every sentence's evidence path must resolve to something that is actually
 * present. A sentence citing a missing or null field is a fabrication, however plausible it reads.
 */
export function audit(explanation: Explanation, bundle: ReviewBundle): AuditResult {
  const bad: AuditResult['bad'] = [];
  let total = 0;
  const check = (sentences: Sentence[]) => {
    for (const s of sentences) {
      for (const path of s.evidence) {
        total++;
        const v = resolvePath(bundle, path);
        if (v === undefined) bad.push({ text: s.text, path, reason: '路径不存在' });
        else if (v === null) bad.push({ text: s.text, path, reason: '字段为空却写进了句子' });
        else if (Array.isArray(v) && v.length === 0) bad.push({ text: s.text, path, reason: '数组为空' });
      }
    }
  };
  check(explanation.headline);
  for (const m of explanation.moves) check(m.sentences);
  return { ok: bad.length === 0, bad, total };
}
