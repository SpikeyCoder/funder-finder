import { YearTrend, GeoEntry } from '../types';
export { GeoHeatMap } from './GeoHeatMap';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDollar(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ── GivingTrendsChart ────────────────────────────────────────────────────────

interface GivingTrendsProps {
  data: YearTrend[];
}

export function GivingTrendsChart({ data }: GivingTrendsProps) {
  if (!data.length) return null;

  const W = 520, H = 200, PAD_L = 55, PAD_R = 15, PAD_T = 20, PAD_B = 30;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const maxAmt = Math.max(...data.map(d => d.totalAmount), 1);
  const maxCount = Math.max(...data.map(d => d.grantCount), 1);

  const xScale = (i: number) => PAD_L + (i / Math.max(data.length - 1, 1)) * chartW;
  const yAmt = (v: number) => PAD_T + chartH - (v / maxAmt) * chartH;
  const yCount = (v: number) => PAD_T + chartH - (v / maxCount) * chartH;

  const amtPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yAmt(d.totalAmount).toFixed(1)}`).join(' ');
  const countPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yCount(d.grantCount).toFixed(1)}`).join(' ');

  // Y-axis ticks for amount (4 ticks)
  const amtTicks = Array.from({ length: 4 }, (_, i) => (maxAmt / 3) * i);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 320 }}>
        {/* Grid lines */}
        {amtTicks.map((t, i) => (
          <line key={i} x1={PAD_L} x2={W - PAD_R} y1={yAmt(t)} y2={yAmt(t)} stroke="#30363d" strokeWidth={0.5} />
        ))}

        {/* Amount Y-axis labels */}
        {amtTicks.map((t, i) => (
          <text key={`label-${i}`} x={PAD_L - 5} y={yAmt(t) + 4} textAnchor="end" fill="#8b949e" fontSize={9}>
            {fmtDollar(t)}
          </text>
        ))}

        {/* X-axis year labels */}
        {data.map((d, i) => (
          <text key={`year-${i}`} x={xScale(i)} y={H - 5} textAnchor="middle" fill="#8b949e" fontSize={10}>
            {d.year}
          </text>
        ))}

        {/* Amount line (blue) */}
        <path d={amtPath} fill="none" stroke="#58a6ff" strokeWidth={2} />
        {data.map((d, i) => (
          <circle key={`amt-${i}`} cx={xScale(i)} cy={yAmt(d.totalAmount)} r={3} fill="#58a6ff" />
        ))}

        {/* Count line (teal) */}
        <path d={countPath} fill="none" stroke="#3fb950" strokeWidth={2} strokeDasharray="4 2" />
        {data.map((d, i) => (
          <circle key={`cnt-${i}`} cx={xScale(i)} cy={yCount(d.grantCount)} r={2.5} fill="#3fb950" />
        ))}

        {/* Legend */}
        <line x1={PAD_L + 5} x2={PAD_L + 25} y1={10} y2={10} stroke="#58a6ff" strokeWidth={2} />
        <text x={PAD_L + 30} y={13} fill="#8b949e" fontSize={9}>Total Amount</text>
        <line x1={PAD_L + 130} x2={PAD_L + 150} y1={10} y2={10} stroke="#3fb950" strokeWidth={2} strokeDasharray="4 2" />
        <text x={PAD_L + 155} y={13} fill="#8b949e" fontSize={9}>Grant Count</text>
      </svg>
    </div>
  );
}

// ── GeoBarChart ──────────────────────────────────────────────────────────────

interface GeoBarProps {
  data: GeoEntry[];
}

export function GeoBarChart({ data }: GeoBarProps) {
  if (!data.length) return null;

  const top = data.slice(0, 10);
  const maxPct = Math.max(...top.map(d => d.pctOfGrants), 1);

  return (
    <div className="space-y-2">
      {top.map(entry => (
        <div key={entry.state} className="flex items-center gap-3">
          <span className="text-xs text-gray-400 w-6 text-right shrink-0">{entry.state}</span>
          <div className="flex-1 h-5 bg-[#0d1117] rounded overflow-hidden relative">
            <div
              className="h-full bg-blue-600/40 rounded"
              style={{ width: `${(entry.pctOfGrants / maxPct) * 100}%` }}
            />
            <span className="absolute right-2 top-0 leading-5 text-xs text-gray-400">
              {entry.pctOfGrants}% ({entry.grantCount})
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── StatCard ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string | number;
  color?: string;
}

export function StatCard({ label, value, color = 'text-white' }: StatCardProps) {
  return (
    <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4">
      <p className="text-xs text-gray-400 mb-1">{label}</p>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
    </div>
  );
}

// ── Skeleton loader ──────────────────────────────────────────────────────────

export function InsightsSkeleton() {
  return (
    <div className="animate-pulse space-y-4 mt-6">
      <div className="h-5 bg-[#21262d] rounded w-48" />
      <div className="grid grid-cols-2 gap-3">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-20 bg-[#21262d] rounded-xl" />
        ))}
      </div>
      <div className="h-44 bg-[#21262d] rounded-xl" />
    </div>
  );
}

export { fmtDollar };
