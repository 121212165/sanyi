import { LETTERS, xyToVertex } from './position.ts';
import type { GameTree } from '../tree.ts';

export interface SgfMove {
  color: 'B' | 'W';
  vertex: string;
}

/**
 * One SGF node. `next` continues this sequence; `variations` are complete alternative game trees
 * branching off *this* node. Keeping the two apart is what makes the writer emit flat game records
 * instead of one nested parenthesis per move.
 */
export interface SgfNode {
  data: Record<string, string[]>;
  next: SgfNode | null;
  variations: SgfNode[];
}

/**
 * Reader/writer in-house on purpose: the npm packages that do this pull in node's `fs` (parseFile),
 * which cannot ship in a browser bundle.
 *   GameTree ::= '(' Sequence ')'      Sequence ::= Node (GameTree)* (';' Node (GameTree)*)*
 */
export function parseSgf(text: string): SgfNode {
  let i = 0;

  const skipWs = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };

  const expect = (ch: string, what: string): void => {
    skipWs();
    if (text[i] !== ch) throw new Error(`SGF: expected ${what} ("${ch}") at ${i}, got "${text[i] ?? 'EOF'}"`);
    i++;
  };

  const readValue = (): string => {
    i++; // '['
    let out = '';
    while (i < text.length) {
      const c = text[i]!;
      if (c === '\\') {
        const next = text[i + 1];
        if (next === '\n') i += 2; // soft line break contributes nothing
        else {
          out += next ?? '';
          i += 2;
        }
        continue;
      }
      if (c === ']') {
        i++;
        return out;
      }
      out += c;
      i++;
    }
    throw new Error('SGF: unterminated property value');
  };

  const readTree = (): SgfNode => {
    expect('(', 'tree open');
    const head = readNode();
    let node = head;
    skipWs();
    while (text[i] === ';') {
      const nextNode = readNode();
      node.next = nextNode;
      node = nextNode;
      skipWs();
    }
    expect(')', 'tree close');
    return head;
  };

  const readNode = (): SgfNode => {
    expect(';', 'node start');
    const data: Record<string, string[]> = {};
    skipWs();
    while (i < text.length && /[A-Za-z]/.test(text[i]!)) {
      let id = '';
      while (i < text.length && /[A-Za-z]/.test(text[i]!)) id += text[i++]!;
      const values: string[] = [];
      skipWs();
      while (text[i] === '[') {
        values.push(readValue());
        skipWs();
      }
      if (values.length) data[id.toUpperCase()] = values;
      skipWs();
    }
    const node: SgfNode = { data, next: null, variations: [] };
    while (text[i] === '(') {
      node.variations.push(readTree());
      skipWs();
    }
    return node;
  };

  skipWs();
  return readTree();
}

function escapeValue(v: string): string {
  // Newlines are legal inside a property value; only `]` and `\` must be escaped.
  return v.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

export function stringifySgf(root: SgfNode): string {
  const nodeText = (n: SgfNode): string =>
    `;${Object.entries(n.data)
      .map(([k, vals]) => `${k}${vals.map((v) => `[${escapeValue(v)}]`).join('')}`)
      .join('')}${n.variations.map(stringifySgf).join('')}`;

  const walk = (n: SgfNode): string => {
    let out = nodeText(n);
    let cur = n.next;
    while (cur) {
      out += nodeText(cur);
      cur = cur.next;
    }
    return `(${out})`;
  };
  return walk(root);
}

/** SGF coords are 0-indexed letters from the top-left; our vertices are GTP-like from the bottom-left. */
export function sgfToVertex(code: string, size: number): string | null {
  if (!code || code.length < 2) return null; // the empty value is pass
  const x = code.charCodeAt(0) - 97;
  const y = code.charCodeAt(1) - 97;
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  return xyToVertex(x, y, size);
}

export function vertexToSgf(vertex: string, size: number): string {
  if (vertex.toUpperCase() === 'PASS') return size > 19 ? 'tt' : '';
  const col = LETTERS.indexOf(vertex[0] ?? '');
  const row = Number(vertex.slice(1));
  if (col < 0 || col >= size || !Number.isInteger(row) || row < 1 || row > size) return '';
  return `${String.fromCharCode(97 + col)}${String.fromCharCode(97 + (size - row))}`;
}

export interface SgfMeta {
  size?: number;
  komi?: number;
  handicap?: number;
  black?: string;
  white?: string;
  date?: string;
  result?: string;
  comment?: string;
}

export function toSgf(moves: SgfMove[], meta: SgfMeta = {}): string {
  const size = meta.size ?? 19;
  const data: SgfNode['data'] = { FF: ['4'], GM: ['1'], CA: ['UTF-8'], SZ: [String(size)] };
  if (meta.komi !== undefined) data.KM = [String(meta.komi)];
  if (meta.handicap) data.HA = [String(meta.handicap)];
  if (meta.black) data.PB = [meta.black];
  if (meta.white) data.PW = [meta.white];
  if (meta.date) data.DT = [meta.date];
  if (meta.result) data.RE = [meta.result];
  if (meta.comment) data.C = [meta.comment];

  const head: SgfNode = { data, next: null, variations: [] };
  let cursor = head;
  for (const m of moves) {
    const next: SgfNode = { data: { [m.color]: [vertexToSgf(m.vertex, size)] }, next: null, variations: [] };
    cursor.next = next;
    cursor = next;
  }
  return stringifySgf(head);
}

export interface ParsedSgf {
  size: number;
  komi: number;
  handicap: number;
  setup: { black: string[]; white: string[] };
  mainLine: SgfMove[];
  /** Branches hanging off the main line, recorded at the ply they diverge from. */
  variations: { atPly: number; moves: SgfMove[] }[];
  meta: SgfMeta;
}

function moveOf(node: SgfNode, size: number): SgfMove | null {
  if (node.data.B) return { color: 'B', vertex: sgfToVertex(node.data.B[0] ?? '', size) ?? 'PASS' };
  if (node.data.W) return { color: 'W', vertex: sgfToVertex(node.data.W[0] ?? '', size) ?? 'PASS' };
  return null;
}

const chainOf = (node: SgfNode | null, size: number): SgfMove[] => {
  const out: SgfMove[] = [];
  for (let cur: SgfNode | null = node; cur; cur = cur.next) {
    const m = moveOf(cur, size);
    if (m) out.push(m);
  }
  return out;
};

export function fromSgf(text: string): ParsedSgf {
  const root = parseSgf(text);
  const size = Number(root.data.SZ?.[0] ?? 19);
  const komi = Number(root.data.KM?.[0] ?? 7.5);
  const parsed: ParsedSgf = {
    size,
    komi,
    handicap: Number(root.data.HA?.[0] ?? 0),
    setup: {
      black: (root.data.AB ?? []).map((c) => sgfToVertex(c, size)).filter((v): v is string => !!v),
      white: (root.data.AW ?? []).map((c) => sgfToVertex(c, size)).filter((v): v is string => !!v),
    },
    mainLine: [],
    variations: [],
    meta: {
      size,
      komi,
      handicap: Number(root.data.HA?.[0] ?? 0),
      black: root.data.PB?.[0],
      white: root.data.PW?.[0],
      date: root.data.DT?.[0],
      result: root.data.RE?.[0],
    },
  };

  let ply = 0;
  for (let cur: SgfNode | null = root; cur; cur = cur.next) {
    if (cur !== root) {
      const m = moveOf(cur, size);
      if (m) parsed.mainLine.push(m);
      ply += 1;
    }
    for (const v of cur.variations) {
      const branch = chainOf(v, size);
      if (branch.length) parsed.variations.push({ atPly: ply, moves: branch });
    }
  }
  return parsed;
}

/** Replays main line + variations into a tree. `toMove` turns (color, vertex) into the game's move type. */
export function applySgfToTree<P, M>(
  tree: GameTree<P, M>,
  parsed: ParsedSgf,
  toMove: (color: 'B' | 'W', vertex: string) => M,
): { leafId: string; variationLeaves: string[] } {
  let leaf = tree.rootId;
  for (const m of parsed.mainLine) leaf = tree.append(leaf, toMove(m.color, m.vertex), { rawMove: m.vertex }).id;

  const variationLeaves: string[] = [];
  for (const v of parsed.variations) {
    const path = tree.path(leaf).slice(0, v.atPly + 1);
    let at = path[path.length - 1] ?? tree.rootId;
    for (const m of v.moves) {
      try {
        at = tree.append(at, toMove(m.color, m.vertex), { rawMove: m.vertex, fromVariation: true }).id;
      } catch {
        break; // a branch that turns illegal mid-way is kept as far as it is legal
      }
    }
    variationLeaves.push(at);
  }
  return { leafId: leaf, variationLeaves };
}
