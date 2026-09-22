import { describe, expect, it } from 'vitest';
import { GameTree } from '../src/tree.ts';
import { goAdapter } from '../src/go/adapter.ts';
import { applySgfToTree, fromSgf, parseSgf, sgfToVertex, stringifySgf, toSgf, vertexToSgf } from '../src/go/sgf.ts';

const L = 'ABCDEFGHJKLMNOPQRSTUVWXYZ';

describe('coordinate conversion', () => {
  it('round-trips every point on 19x19', () => {
    for (let x = 0; x < 19; x++) {
      for (let y = 0; y < 19; y++) {
        const vertex = `${L[x]}${19 - y}`;
        expect(sgfToVertex(vertexToSgf(vertex, 19), 19)).toBe(vertex);
      }
    }
  });

  it('maps pass to the empty value on 19 and to tt on larger boards', () => {
    expect(vertexToSgf('PASS', 19)).toBe('');
    expect(sgfToVertex('', 19)).toBeNull();
    expect(vertexToSgf('PASS', 25)).toBe('tt');
  });

  it('rejects out-of-range codes instead of guessing', () => {
    expect(sgfToVertex('tt', 19)).toBeNull(); // tt is pass only where 19x19 cannot express it
    expect(sgfToVertex('a{', 19)).toBeNull();
    expect(vertexToSgf('Z1', 19)).toBe('');
    expect(vertexToSgf('A20', 19)).toBe('');
  });

  it('agrees with the board geometry', () => {
    // SGF columns are consecutive letters (no I-skip); GTP columns skip I.
    expect(sgfToVertex('dd', 19)).toBe('D16');
    expect(sgfToVertex('dp', 19)).toBe('D4');
    expect(sgfToVertex('pp', 19)).toBe('Q4');
    expect(sgfToVertex('pd', 19)).toBe('Q16');
    expect(sgfToVertex('aa', 19)).toBe('A19');
    expect(sgfToVertex('ss', 19)).toBe('T1');
    expect(sgfToVertex('jj', 19)).toBe('K10');
  });
});

describe('sgf writer', () => {
  it('writes a header and a flat move sequence', () => {
    const text = toSgf([{ color: 'B', vertex: 'D4' }, { color: 'W', vertex: 'Q16' }], { komi: 7.5, result: 'B+R' });
    expect(text.startsWith('(;FF[4]GM[1]CA[UTF-8]SZ[19]KM[7.5]RE[B+R]')).toBe(true);
    expect(text).toContain(';B[dp];W[pd]');
    expect(text.match(/\(/g)).toHaveLength(1); // a linear game stays one tree
  });

  it('escapes brackets and backslashes but keeps newlines', () => {
    const node = { data: { C: ['a ] b \\ c\nd'] }, next: null, variations: [] };
    expect(parseSgf(stringifySgf(node)).data.C![0]).toBe('a ] b \\ c\nd');
  });

  it('keeps variations as nested trees on the node they branch from', () => {
    const root = { data: { SZ: ['19'] }, next: { data: { B: ['dd'] }, next: null, variations: [] }, variations: [{ data: { B: ['pp'] }, next: null, variations: [] }] };
    const text = stringifySgf(root);
    expect(text).toBe('(;SZ[19](;B[pp]);B[dd])');
    expect(parseSgf(text).variations).toHaveLength(1);
  });
});

describe('sgf reader', () => {
  const withBranches = '(;GM[1]FF[4]SZ[19]KM[7.5]AB[dd][pd]AW[pp];B[dp]C[a note];W[fd](;B[cd];W[cc])(;B[ce];W[dc]))';

  it('reads header, setup stones and meta', () => {
    const p = fromSgf(withBranches);
    expect(p.size).toBe(19);
    expect(p.komi).toBe(7.5);
    expect(p.setup.black).toEqual(['D16', 'Q16']);
    expect(p.setup.white).toEqual(['Q4']);
    expect(p.meta.black).toBeUndefined();
  });

  it('keeps the main line and reports every branch with the ply it diverges from', () => {
    const p = fromSgf(withBranches);
    expect(p.mainLine).toEqual([
      { color: 'B', vertex: 'D4' },
      { color: 'W', vertex: 'F16' },
    ]);
    expect(p.variations).toHaveLength(2);
    expect(p.variations.map((v) => v.atPly)).toEqual([2, 2]);
    expect(p.variations[0]!.moves).toEqual([
      { color: 'B', vertex: 'C16' },
      { color: 'W', vertex: 'C17' },
    ]);
    expect(p.variations[1]!.moves).toEqual([
      { color: 'B', vertex: 'C15' },
      { color: 'W', vertex: 'D17' },
    ]);
  });

  it('reads multi-value properties and a comment with whitespace', () => {
    const node = parseSgf('(;FF[4]GM[1]SZ[19]C[ line one\n  line two ]AB[aa][bb])');
    expect(node.data.C![0]).toBe(' line one\n  line two ');
    expect(node.data.AB).toEqual(['aa', 'bb']);
  });

  it('survives a round trip of a real move list including pass', () => {
    const moves = [
      { color: 'B' as const, vertex: 'D4' },
      { color: 'W' as const, vertex: 'Q16' },
      { color: 'B' as const, vertex: 'PASS' },
      { color: 'W' as const, vertex: 'T19' },
    ];
    const p = fromSgf(toSgf(moves, { size: 19, komi: 7.5 }));
    expect(p.mainLine).toEqual(moves);
    expect(p.variations).toEqual([]);
  });

  it('rejects malformed input loudly', () => {
    expect(() => fromSgf('GM[1]')).toThrow(/expected .*tree open/);
    expect(() => fromSgf('(;GM[1]')).toThrow(/expected .*tree close/);
    expect(() => fromSgf('')).toThrow();
  });
});

describe('sgf into the game tree', () => {
  it('attaches the main line and keeps branches as variations', () => {
    const tree = new GameTree(goAdapter);
    const parsed = fromSgf('(;GM[1]FF[4]SZ[19];B[dp];W[fd](;B[cd])(;B[ce]))');
    const { leafId, variationLeaves } = applySgfToTree(tree, parsed, (_c, v) => v);
    expect(tree.node(leafId).rawMove).toBe('F16');
    expect(variationLeaves).toHaveLength(2);

    const firstBlack = tree.children(tree.rootId)[0]!;
    expect(firstBlack.rawMove).toBe('D4');
    const white = tree.children(firstBlack.id)[0]!;
    expect(white.position.moves).toEqual(['D4', 'F16']);
    expect(tree.children(white.id).map((n) => n.rawMove)).toEqual(['C16', 'C15']);
    expect(tree.children(white.id).every((n) => n.fromVariation)).toBe(true);
  });

  it('stops a branch at the point it becomes illegal instead of throwing', () => {
    const tree = new GameTree(goAdapter);
    const parsed = fromSgf('(;GM[1]FF[4]SZ[19];B[dp](;W[dp];B[fp]))'); // white "replays" black's point
    const { variationLeaves } = applySgfToTree(tree, parsed, (_c, v) => v);
    expect(variationLeaves).toEqual([tree.children(tree.rootId)[0]!.id]);
  });
});
