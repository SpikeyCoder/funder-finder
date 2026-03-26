import { useState } from 'react';
import { GeoEntry } from '../types';

/**
 * FEAT-004: Lightweight US state choropleth heat map.
 * Uses a grid-based cartogram (no external deps) for reliable rendering
 * while still showing geographic relationships between states.
 */

// State grid positions [row, col] in a 12×8 cartogram
const STATE_GRID: Record<string, [number, number]> = {
  AK: [0, 0], ME: [0, 10],
  WI: [1, 5], VT: [1, 9], NH: [1, 10],
  WA: [2, 0], ID: [2, 1], MT: [2, 2], ND: [2, 3], MN: [2, 4], IL: [2, 5], MI: [2, 6], NY: [2, 8], MA: [2, 9], CT: [2, 10],
  OR: [3, 0], NV: [3, 1], WY: [3, 2], SD: [3, 3], IA: [3, 4], IN: [3, 5], OH: [3, 6], PA: [3, 7], NJ: [3, 8], RI: [3, 9],
  CA: [4, 0], UT: [4, 1], CO: [4, 2], NE: [4, 3], MO: [4, 4], KY: [4, 5], WV: [4, 6], VA: [4, 7], MD: [4, 8], DE: [4, 9],
  AZ: [5, 1], NM: [5, 2], KS: [5, 3], AR: [5, 4], TN: [5, 5], NC: [5, 6], SC: [5, 7], DC: [5, 8],
  OK: [6, 3], LA: [6, 4], MS: [6, 5], AL: [6, 6], GA: [6, 7],
  HI: [7, 0], TX: [7, 3], FL: [7, 7],
};

const ALL_STATES = Object.keys(STATE_GRID);

function interpolateBlue(ratio: number): string {
  // From dark (#161b22 ≈ rgb 22,27,34) to vivid blue (#58a6ff ≈ rgb 88,166,255)
  if (ratio <= 0) return '#1e2430';
  const r = Math.round(30 + ratio * (88 - 30));
  const g = Math.round(35 + ratio * (166 - 35));
  const b = Math.round(55 + ratio * (255 - 55));
  return `rgb(${r},${g},${b})`;
}

interface GeoHeatMapProps {
  data: GeoEntry[];
}

export function GeoHeatMap({ data }: GeoHeatMapProps) {
  const [tooltip, setTooltip] = useState<{ state: string; info: GeoEntry | null; x: number; y: number } | null>(null);

  if (!data.length) return null;

  const lookup = new Map(data.map(d => [d.state, d]));
  const maxGrants = Math.max(...data.map(d => d.grantCount), 1);

  const CELL = 38;
  const GAP = 3;
  const step = CELL + GAP;
  const COLS = 11;
  const ROWS = 8;
  const W = COLS * step + GAP;
  const H = ROWS * step + GAP + 20; // extra for legend

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ minWidth: 280 }}
      >
        {ALL_STATES.map(st => {
          const [row, col] = STATE_GRID[st];
          const entry = lookup.get(st);
          const ratio = entry ? Math.pow(entry.grantCount / maxGrants, 0.5) : 0; // sqrt scale for visual spread
          const fill = entry ? interpolateBlue(ratio) : '#161b22';
          const x = GAP + col * step;
          const y = GAP + row * step;

          return (
            <g
              key={st}
              onMouseEnter={(e) => {
                const rect = (e.target as SVGElement).closest('svg')?.getBoundingClientRect();
                setTooltip({
                  state: st,
                  info: entry || null,
                  x: rect ? e.clientX - rect.left : 0,
                  y: rect ? e.clientY - rect.top : 0,
                });
              }}
              onMouseLeave={() => setTooltip(null)}
              className="cursor-default"
            >
              <rect
                x={x}
                y={y}
                width={CELL}
                height={CELL}
                rx={4}
                fill={fill}
                stroke={entry ? '#58a6ff33' : '#30363d'}
                strokeWidth={entry ? 1 : 0.5}
              />
              <text
                x={x + CELL / 2}
                y={y + CELL / 2 + 4}
                textAnchor="middle"
                fill={ratio > 0.4 ? '#fff' : '#8b949e'}
                fontSize={10}
                fontWeight={entry ? 600 : 400}
              >
                {st}
              </text>
            </g>
          );
        })}

        {/* Color legend */}
        {(() => {
          const lx = GAP;
          const ly = H - 16;
          return (
            <>
              <text x={lx} y={ly} fill="#8b949e" fontSize={8}>Fewer</text>
              {Array.from({ length: 5 }, (_, i) => (
                <rect key={i} x={lx + 30 + i * 18} y={ly - 8} width={16} height={10} rx={2}
                  fill={interpolateBlue((i + 1) / 5)} />
              ))}
              <text x={lx + 30 + 5 * 18 + 4} y={ly} fill="#8b949e" fontSize={8}>More grants</text>
            </>
          );
        })()}
      </svg>

      {/* Tooltip overlay */}
      {tooltip && tooltip.info && (
        <div
          className="absolute pointer-events-none z-10 bg-[#161b22] border border-[#30363d] rounded-lg px-3 py-2 text-xs shadow-lg"
          style={{ left: Math.min(tooltip.x + 10, W - 140), top: tooltip.y - 50 }}
        >
          <p className="font-semibold text-white">{tooltip.state}</p>
          <p className="text-gray-400">{tooltip.info.grantCount} grants | {tooltip.info.pctOfGrants}%</p>
          <p className="text-gray-500">${(tooltip.info.totalAmount / 1e6).toFixed(1)}M total</p>
        </div>
      )}
    </div>
  );
}
