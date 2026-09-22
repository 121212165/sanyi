'use client';

import { useMemo } from 'react';
import { LETTERS, type GoPosition } from '@sanyi/core';

export interface BoardProps {
  pos: GoPosition;
  /** Vertices the engine currently wants to play — arrows/labels come from the packet, not from a guess. */
  suggestion?: string;
  ownership?: number[][];
  lastMove?: string | null;
  onPlay?: (vertex: string) => void;
  disabled?: boolean;
  showCoords?: boolean;
}

const PAD = 28;

export function GoBoard({ pos, suggestion, ownership, lastMove, onPlay, disabled, showCoords = true }: BoardProps) {
  const size = pos.size;
  const cell = 32;
  const dim = PAD * 2 + cell * (size - 1);

  const stars: [number, number][] = [];
  if (size === 19 || size === 13) {
    const m = size === 19 ? 3 : 3;
    const f = size - 1 - m;
    const c = (size - 1) / 2;
    const pts: [number, number][] = [[m, m], [m, f], [f, m], [f, f]];
    if (size === 19) pts.push([c, m], [c, f], [m, c], [f, c], [c, c]);
    else pts.push([c, c]);
    stars.push(...pts.filter(([x, y]) => Number.isInteger(x) && Number.isInteger(y)));
  } else if (size === 9) {
    stars.push([2, 2], [6, 2], [2, 6], [6, 6], [4, 4]);
  }

  const px = (x: number) => PAD + x * cell;
  const py = (y: number) => PAD + y * cell;

  return (
    <svg viewBox={`0 0 ${dim} ${dim}`} className="goban" role="img" aria-label="围棋棋盘">
      <rect width={dim} height={dim} fill="#d9a95f" />
      {Array.from({ length: size }, (_, i) => (
        <g key={i} stroke="#3a2a12" strokeWidth={i === 0 || i === size - 1 ? 2 : 1}>
          <line x1={px(0)} y1={py(i)} x2={px(size - 1)} y2={py(i)} />
          <line x1={px(i)} y1={py(0)} x2={px(i)} y2={py(size - 1)} />
        </g>
      ))}
      {stars.map(([x, y]) => <circle key={`${x}-${y}`} cx={px(x)} cy={py(y)} r={3.5} fill="#3a2a12" />)}

      {ownership?.map((row, y) =>
        row.map((v, x) =>
          Math.abs(v) < 0.15 ? null : (
            <rect
              key={`o${x}-${y}`}
              x={px(x) - cell / 2}
              y={py(y) - cell / 2}
              width={cell}
              height={cell}
              fill={v > 0 ? '#000' : '#fff'}
              opacity={Math.min(0.34, Math.abs(v) * 0.4)}
            />
          ),
        ),
      )}

      {pos.cells.map((row, y) =>
        row.map((v, x) => {
          if (v === 0) return null;
          const cx = px(x);
          const cy = py(y);
          return (
            <g key={`${x}-${y}`}>
              <circle cx={cx} cy={cy} r={cell / 2 - 1.5} fill={v === 1 ? '#111' : '#fafafa'} stroke={v === 1 ? '#000' : '#7a6338'} strokeWidth={1} />
              <circle cx={cx - 4} cy={cy - 5} r={cell / 6} fill={v === 1 ? '#3a3a3a' : '#e2e2e2'} opacity={0.7} />
            </g>
          );
        }),
      )}

      {lastMove && (() => {
        const xy = vertexToXYlocal(lastMove, size);
        if (!xy) return null;
        return <circle cx={px(xy[0])} cy={py(xy[1])} r={7} fill="none" stroke={pos.cells[xy[1]][xy[0]] === 1 ? '#fff' : '#000'} strokeWidth={2.5} />;
      })()}

      {suggestion && (() => {
        const xy = vertexToXYlocal(suggestion, size);
        if (!xy) return null;
        return (
          <g pointerEvents="none">
            <circle cx={px(xy[0])} cy={py(xy[1])} r={cell / 2 - 3} fill="none" stroke="#0a7f3f" strokeWidth={3} strokeDasharray="5 4" />
          </g>
        );
      })()}

      {!disabled &&
        onPlay &&
        pos.cells.map((row, y) =>
          row.map((v, x) =>
            v === 0 ? (
              <rect
                key={`c${x}-${y}`}
                x={px(x) - cell / 2}
                y={py(y) - cell / 2}
                width={cell}
                height={cell}
                fill="transparent"
                className="hit"
                onClick={() => onPlay(`${LETTERS[x]}${size - y}`)}
              >
                <title>{`${LETTERS[x]}${size - y}`}</title>
              </rect>
            ) : null,
          ),
        )}

      {showCoords &&
        Array.from({ length: size }, (_, i) => (
          <g key={`t${i}`} fill="#5b4423" fontSize={11} fontFamily="ui-monospace, monospace">
            <text x={px(i)} y={PAD - 10} textAnchor="middle">{LETTERS[i]}</text>
            <text x={PAD - 12} y={py(i) + 4} textAnchor="middle">{String(size - i)}</text>
          </g>
        ))}
    </svg>
  );
}

function vertexToXYlocal(vertex: string, size: number): [number, number] | null {
  if (!vertex || vertex.toUpperCase() === 'PASS') return null;
  const x = LETTERS.indexOf(vertex[0] ?? '');
  const row = Number(vertex.slice(1));
  if (x < 0 || x >= size || !Number.isInteger(row) || row < 1 || row > size) return null;
  return [x, size - row];
}
