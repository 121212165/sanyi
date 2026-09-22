import type { GameAdapter } from './types.ts';

export interface TreeNode<P, M> {
  id: string;
  parent: string | null;
  children: string[];
  /** The move played to reach this node; null on the root. */
  move: M | null;
  /** Engine-native move string, stored as truth; human notation is rendered on demand. */
  rawMove: string | null;
  position: P;
  /** Wall-clock remaining per side when this node was reached, ms. */
  clock?: { black: number; white: number };
  packetKey?: string;
  comment?: string;
  /** 0 = the line the player mostly followed; higher = alternative branches kept side by side. */
  branchRank: number;
  /** Set when this node came from playing out a variation (推演) rather than the game itself. */
  fromVariation?: boolean;
}

let seq = 0;
export function makeId(): string {
  seq = (seq + 1) % 0xffff;
  return `${Date.now().toString(36)}-${seq.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * One tree serves all three games: branching, switching variations and re-rooting are structurally
 * identical, so only `GameAdapter` is per-game.
 */
export class GameTree<P, M> {
  readonly adapter: GameAdapter<P, M>;
  private nodes = new Map<string, TreeNode<P, M>>();
  rootId: string;

  constructor(adapter: GameAdapter<P, M>) {
    this.adapter = adapter;
    const id = makeId();
    this.rootId = id;
    this.nodes.set(id, { id, parent: null, children: [], move: null, rawMove: null, position: adapter.start(), branchRank: 0 });
  }

  static from<P, M>(adapter: GameAdapter<P, M>, rootPosition: P, rootId = makeId()): GameTree<P, M> {
    const t = new GameTree(adapter);
    t.nodes.clear();
    t.nodes.set(rootId, { id: rootId, parent: null, children: [], move: null, rawMove: null, position: rootPosition, branchRank: 0 });
    t.rootId = rootId;
    return t;
  }

  get size(): number {
    return this.nodes.size;
  }

  node(id: string): TreeNode<P, M> {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown node ${id}`);
    return n;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  root(): TreeNode<P, M> {
    return this.node(this.rootId);
  }

  children(id: string): TreeNode<P, M>[] {
    return this.node(id).children.map((c) => this.node(c));
  }

  /** Node ids from the root down to `id` (inclusive). */
  path(id: string): string[] {
    const out: string[] = [];
    let cur: string | null = id;
    while (cur) {
      out.push(cur);
      cur = this.node(cur).parent;
    }
    return out.reverse();
  }

  legalMoves(id: string): M[] {
    return this.adapter.legalMoves(this.node(id).position);
  }

  /** Plays `move` from `parentId` and attaches the result. Throws on illegal moves — callers must not guess. */
  append(parentId: string, move: M, opts: { rawMove?: string; clock?: { black: number; white: number }; fromVariation?: boolean } = {}): TreeNode<P, M> {
    const parent = this.node(parentId);
    if (!this.adapter.isLegal(parent.position, move)) {
      throw new Error(`illegal move ${opts.rawMove ?? ''} at ${this.adapter.canonicalKey(parent.position)}`);
    }
    const existing = parent.children.map((c) => this.node(c)).find((c) => c.rawMove === (opts.rawMove ?? null));
    if (existing) {
      if (opts.clock) existing.clock = opts.clock;
      return existing;
    }
    const id = makeId();
    const node: TreeNode<P, M> = {
      id,
      parent: parentId,
      children: [],
      move,
      rawMove: opts.rawMove ?? null,
      position: this.adapter.apply(parent.position, move),
      clock: opts.clock,
      branchRank: parent.children.length,
      fromVariation: opts.fromVariation,
    };
    this.nodes.set(id, node);
    parent.children.push(id);
    return node;
  }

  /** Follows the preferred line (lowest branchRank) to its leaf. */
  mainLineFrom(id: string = this.rootId): string[] {
    const out = [id];
    let cur = this.node(id);
    while (cur.children.length) {
      const best = cur.children.map((c) => this.node(c)).sort((a, b) => a.branchRank - b.branchRank)[0];
      out.push(best.id);
      cur = best;
    }
    return out;
  }

  leaves(): string[] {
    return [...this.nodes.values()].filter((n) => n.children.length === 0).map((n) => n.id);
  }

  /**
   * Makes `id` the new root, keeping everything above it reachable as history.
   * Used when a 推演 line is adopted as the continuation of the game.
   */
  setRoot(id: string): void {
    this.node(id);
    this.rootId = id;
  }

  /**
   * Deep-copies the subtree under `id` and returns the new copy of `id`, so the player can push a
   * variation without disturbing the line that is already there.
   */
  cloneSubtree(id: string): string {
    const copy = (s: TreeNode<P, M>, parentNew: string | null): string => {
      const nid = makeId();
      const clone: TreeNode<P, M> = { ...s, id: nid, parent: parentNew, children: [], fromVariation: true };
      this.nodes.set(nid, clone);
      for (const childId of s.children) clone.children.push(copy(this.node(childId), nid));
      return nid;
    };
    const src = this.node(id);
    const newId = copy(src, src.parent);
    if (src.parent) this.node(src.parent).children.push(newId);
    return newId;
  }

  toJSON(): TreeNode<P, M>[] {
    return [...this.nodes.values()];
  }

  static hydrate<P, M>(adapter: GameAdapter<P, M>, nodes: TreeNode<P, M>[], rootId: string): GameTree<P, M> {
    const t = new GameTree(adapter);
    t.nodes.clear();
    for (const n of nodes) t.nodes.set(n.id, n);
    t.rootId = rootId;
    return t;
  }
}
