import { describe, expect, it } from 'vitest';
import { GameTree } from '../src/tree.ts';
import { goAdapter } from '../src/go/adapter.ts';
import { startPosition } from '../src/go/position.ts';

const open = () => new GameTree(goAdapter);

describe('GameTree', () => {
  it('starts at the empty board with black to move', () => {
    const t = open();
    expect(t.path(t.rootId)).toEqual([t.rootId]);
    expect(t.root().position.toMove).toBe('black');
    expect(t.legalMoves(t.rootId).length).toBe(362);
  });

  it('throws on an illegal move instead of silently accepting it', () => {
    const t = open();
    const a = t.append(t.rootId, 'D4', { rawMove: 'D4' });
    expect(() => t.append(a.id, 'D4', { rawMove: 'D4' })).toThrow(/illegal/);
  });

  it('keeps one node per distinct move at a branch point and records the rest as variations', () => {
    const t = open();
    const b = t.append(t.rootId, 'D4', { rawMove: 'D4' });
    const again = t.append(t.rootId, 'D4', { rawMove: 'D4' });
    expect(again.id).toBe(b.id);
    const alt = t.append(t.rootId, 'Q16', { rawMove: 'Q16' });
    expect(t.children(t.rootId).map((n) => n.rawMove)).toEqual(['D4', 'Q16']);
    expect(alt.branchRank).toBe(1);
    expect(t.size).toBe(3);
  });

  it('positions accumulate along the path', () => {
    const t = open();
    const b = t.append(t.rootId, 'D4', { rawMove: 'D4' });
    const c = t.append(b.id, 'Q16', { rawMove: 'Q16' });
    expect(c.position.moves).toEqual(['D4', 'Q16']);
    expect(c.position.toMove).toBe('black');
    expect(t.path(c.id)).toEqual([t.rootId, b.id, c.id]);
  });

  it('follows the first-played child as the main line', () => {
    const t = open();
    const b = t.append(t.rootId, 'D4', { rawMove: 'D4' });
    const first = t.append(b.id, 'Q16', { rawMove: 'Q16' });
    t.append(b.id, 'A1', { rawMove: 'A1' });
    expect(t.mainLineFrom(t.rootId)).toEqual([t.rootId, b.id, first.id]);
  });

  it('re-roots without losing the stones already played', () => {
    const t = open();
    const b = t.append(t.rootId, 'D4', { rawMove: 'D4' });
    const c = t.append(b.id, 'Q16', { rawMove: 'Q16' });
    t.setRoot(c.id);
    expect(t.rootId).toBe(c.id);
    expect(t.root().position.cells.flat().filter((v) => v !== 0)).toHaveLength(2);
    expect(t.mainLineFrom(t.rootId)).toEqual([c.id]);
  });

  it('clones a subtree for 推演 without disturbing the original line', () => {
    const t = open();
    const b = t.append(t.rootId, 'D4', { rawMove: 'D4' });
    const c = t.append(b.id, 'Q16', { rawMove: 'Q16' });
    const d = t.append(c.id, 'D16', { rawMove: 'D16' });
    const before = t.size;

    const copyId = t.cloneSubtree(c.id);
    expect(copyId).not.toBe(c.id);
    expect(t.node(copyId).rawMove).toBe('Q16');
    expect(t.node(copyId).children.length).toBe(t.node(c.id).children.length);
    expect(t.node(copyId).fromVariation).toBe(true);

    // Playing into the clone must not change what the original line sees.
    const pushed = t.append(copyId, 'A1', { rawMove: 'A1' });
    expect(pushed.id).not.toBe(d.id);
    expect(t.node(c.id).children).toEqual([d.id]);
    expect(t.size).toBe(before + 1 + 1 + 1); // clone of c and its child d, plus the pushed move
  });

  it('hydrates from a serialised tree', () => {
    const t = open();
    const b = t.append(t.rootId, 'D4', { rawMove: 'D4' });
    const json = t.toJSON();
    const t2 = GameTree.hydrate(goAdapter, json, t.rootId);
    expect(t2.node(b.id).rawMove).toBe('D4');
    expect(t2.legalMoves(b.id).length).toBe(t.legalMoves(b.id).length);
  });

  it('supports a custom starting position', () => {
    const t = GameTree.from(goAdapter, startPosition({ size: 9, komi: 5.5, handicap: 4 }));
    expect(t.root().position.toMove).toBe('white');
    expect(t.root().position.cells.flat().filter((v) => v === 1)).toHaveLength(4);
  });
});
