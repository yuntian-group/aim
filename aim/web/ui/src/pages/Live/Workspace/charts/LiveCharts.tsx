import React from 'react';

import { IControlEvent } from 'types/services/models/live/live';

import { ILiveSessionStore, IMetricPoint } from '../../liveStore';

import './LiveCharts.scss';

interface ILiveChartsProps {
  store: ILiveSessionStore;
}

const MARKER_TYPES = new Set([
  'knob_changed',
  'checkpoint_saved',
  'checkpoint_loaded',
  'module_reset',
  'note',
  'evaluate_requested',
]);

const BRANCH_COLORS = ['#1651c4', '#1a7f37', '#9a6700', '#8b2fc9', '#c0392b'];
const GHOST_STROKE = '#9aa4b2';
const GHOST_MAX_POINTS = 300;

function branchColor(branch: string, branches: string[]): string {
  const idx = branches.indexOf(branch);
  return BRANCH_COLORS[(idx < 0 ? 0 : idx) % BRANCH_COLORS.length];
}

// Uniform stride downsample so ghost rounds stay cheap to render (multiround_ux §4.2).
function downsample(points: IMetricPoint[], max: number): IMetricPoint[] {
  if (points.length <= max) {
    return points;
  }
  const stride = Math.ceil(points.length / max);
  const out: IMetricPoint[] = [];
  for (let i = 0; i < points.length; i += stride) {
    out.push(points[i]);
  }
  if (out[out.length - 1] !== points[points.length - 1]) {
    out.push(points[points.length - 1]);
  }
  return out;
}

function formatTick(value: number): string {
  const abs = Math.abs(value);
  if (abs > 0 && (abs < 0.001 || abs >= 10000)) {
    return value.toExponential(1);
  }
  if (abs >= 100) {
    return value.toFixed(0);
  }
  if (abs >= 1) {
    return value.toFixed(2);
  }
  return value.toFixed(4);
}

function buildTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || count <= 1) {
    return [];
  }

  return Array.from({ length: count }, (_, i) => {
    const ratio = i / (count - 1);
    return min + (max - min) * ratio;
  });
}

interface IMarker {
  step: number;
  type: string;
}

function MiniChart({
  title,
  points,
  focusedRound,
  baselineRounds,
  markers,
}: {
  title: string;
  points: IMetricPoint[];
  focusedRound: number;
  baselineRounds: number;
  markers: IMarker[];
}) {
  const width = 620;
  const height = 210;
  const pad = { l: 54, r: 18, t: 12, b: 34 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;

  const { focused, ghosts } = React.useMemo(() => {
    const byRound: Record<number, IMetricPoint[]> = {};
    points.forEach((p) => (byRound[p.round] = byRound[p.round] || []).push(p));
    const focusedPts = byRound[focusedRound] || [];
    const ghostRounds = Object.keys(byRound)
      .map(Number)
      .filter((r) => r !== focusedRound)
      .sort((a, b) => a - b);
    return {
      focused: focusedPts,
      ghosts: ghostRounds.map((r) => ({
        round: r,
        // Ghosts collapse to the `main` branch and downsample (§4.2).
        points: downsample(
          byRound[r].filter((p) => p.branch === 'main' && !p.eval),
          GHOST_MAX_POINTS,
        ),
      })),
    };
  }, [points, focusedRound]);

  // Domain fits the focused round; ghosts clip to it (identical by construction).
  const domainPts = focused.length > 0 ? focused : points;

  const { xMin, xMax, yMin, yMax, branches } = React.useMemo(() => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    const brs: string[] = [];
    domainPts.forEach((p) => {
      x0 = Math.min(x0, p.step);
      x1 = Math.max(x1, p.step);
      y0 = Math.min(y0, p.value);
      y1 = Math.max(y1, p.value);
      if (!brs.includes(p.branch)) {
        brs.push(p.branch);
      }
    });
    const ySpan = y1 - y0;
    if (ySpan === 0) {
      const delta = Math.abs(y0) * 0.08 || 1;
      y0 -= delta;
      y1 += delta;
    } else {
      const delta = ySpan * 0.08;
      y0 -= delta;
      y1 += delta;
    }
    if (x0 === x1) {
      x1 = x0 + 1;
    }
    return { xMin: x0, xMax: x1, yMin: y0, yMax: y1, branches: brs };
  }, [domainPts]);

  if (points.length === 0) {
    return (
      <div className='MiniChart MiniChart--empty'>
        <span className='MiniChart__title'>{title}</span>
        <span className='MiniChart__empty'>waiting for data…</span>
      </div>
    );
  }

  const sx = (step: number) => pad.l + ((step - xMin) / (xMax - xMin)) * iw;
  const sy = (value: number) =>
    pad.t + ih - ((value - yMin) / (yMax - yMin)) * ih;
  const xTicks = buildTicks(xMin, xMax, 4);
  const yTicks = buildTicks(yMin, yMax, 5);

  const byBranch: Record<string, IMetricPoint[]> = {};
  focused.forEach((p) => {
    (byBranch[p.branch] = byBranch[p.branch] || []).push(p);
  });

  const last =
    focused.length > 0
      ? focused[focused.length - 1]
      : points[points.length - 1];

  return (
    <div className='MiniChart'>
      <div className='MiniChart__head'>
        <span className='MiniChart__title'>{title}</span>
        <span className='MiniChart__last'>
          step {last.step} | {formatTick(last.value)}
        </span>
      </div>
      <svg
        width='100%'
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio='none'
        className='MiniChart__plot'
      >
        <rect
          x={pad.l}
          y={pad.t}
          width={iw}
          height={ih}
          className='MiniChart__plotArea'
        />
        {yTicks.map((tick) => (
          <g key={`y-${tick}`}>
            <line
              x1={pad.l}
              x2={pad.l + iw}
              y1={sy(tick)}
              y2={sy(tick)}
              className='MiniChart__gridLine'
            />
            <text
              x={pad.l - 8}
              y={sy(tick) + 3}
              className='MiniChart__axis MiniChart__axis--y'
            >
              {formatTick(tick)}
            </text>
          </g>
        ))}
        {xTicks.map((tick) => (
          <g key={`x-${tick}`}>
            <line
              x1={sx(tick)}
              x2={sx(tick)}
              y1={pad.t}
              y2={pad.t + ih}
              className='MiniChart__gridLine MiniChart__gridLine--x'
            />
            <text
              x={sx(tick)}
              y={pad.t + ih + 20}
              className='MiniChart__axis MiniChart__axis--x'
            >
              {Math.round(tick)}
            </text>
          </g>
        ))}
        {/* ghost rounds: thin, low-opacity, main branch only; baseline dashed */}
        {ghosts.map((g) => {
          const line = g.points
            .map((p) => `${sx(p.step)},${sy(p.value)}`)
            .join(' ');
          if (!line) {
            return null;
          }
          return (
            <polyline
              key={`ghost-${g.round}`}
              points={line}
              fill='none'
              stroke={GHOST_STROKE}
              strokeWidth={1.2}
              strokeOpacity={0.55}
              strokeDasharray={g.round < baselineRounds ? '4 3' : undefined}
            >
              <title>R{g.round}</title>
            </polyline>
          );
        })}
        {/* action markers (focused round only) */}
        {markers.map((m, i) =>
          m.step >= xMin && m.step <= xMax ? (
            <line
              key={`${m.type}-${m.step}-${i}`}
              x1={sx(m.step)}
              x2={sx(m.step)}
              y1={pad.t}
              y2={pad.t + ih}
              className={`MiniChart__marker MiniChart__marker--${m.type}`}
            >
              <title>
                {m.type} @ step {m.step}
              </title>
            </line>
          ) : null,
        )}
        {/* focused round: full-strength branch series + eval dots */}
        {Object.keys(byBranch).map((branch) => {
          const bp = byBranch[branch].slice().sort((a, b) => a.step - b.step);
          const line = bp
            .filter((p) => !p.eval)
            .map((p) => `${sx(p.step)},${sy(p.value)}`)
            .join(' ');
          const color = branchColor(branch, branches);
          return (
            <g key={branch}>
              {line && (
                <polyline
                  points={line}
                  fill='none'
                  stroke={color}
                  strokeWidth={2.2}
                  strokeLinecap='round'
                  strokeLinejoin='round'
                />
              )}
              {bp
                .filter((p) => p.eval)
                .map((p, i) => (
                  <circle
                    key={i}
                    cx={sx(p.step)}
                    cy={sy(p.value)}
                    r={3.5}
                    fill={color}
                  />
                ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function LiveCharts({
  store,
}: ILiveChartsProps): React.FunctionComponentElement<React.ReactNode> {
  const { metrics, state, events, focusedRound, rounds } = store;
  const goalMetric = state?.goal?.metric;
  const baselineRounds = rounds?.baseline_rounds ?? 0;

  const allKeys = Object.keys(metrics);
  const defaultKeys = React.useMemo(() => {
    const preferred = [goalMetric, 'loss', 'learning_rate'].filter(
      Boolean,
    ) as string[];
    const rest = allKeys.filter((k) => !preferred.includes(k));
    return [...preferred.filter((k) => allKeys.includes(k)), ...rest];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allKeys.join(','), goalMetric]);

  const [pinned, setPinned] = React.useState<string[] | null>(null);
  const shown = pinned ?? defaultKeys;

  // Markers belong to the focused round only (multiround_ux §4.2).
  const markers: IMarker[] = React.useMemo(
    () =>
      events
        .filter((e: IControlEvent) => MARKER_TYPES.has(e.type))
        .filter((e) => (e.round ?? 0) === focusedRound)
        .map((e) => ({
          step:
            typeof e.payload?.step === 'number' ? e.payload.step : store.step,
          type: e.type,
        })),
    [events, store.step, focusedRound],
  );

  const hidden = allKeys.filter((k) => !shown.includes(k));

  return (
    <div className='LiveCharts'>
      {shown.length === 0 ? (
        <div className='LiveCharts__empty'>
          {store.loadingHistory
            ? 'Loading metric history…'
            : 'Waiting for metrics from the training stream…'}
        </div>
      ) : (
        <div className='LiveCharts__grid'>
          {shown.map((key) => (
            <MiniChart
              key={key}
              title={key}
              points={metrics[key] || []}
              focusedRound={focusedRound}
              baselineRounds={baselineRounds}
              markers={markers}
            />
          ))}
        </div>
      )}
      {hidden.length > 0 && (
        <div className='LiveCharts__picker'>
          <span>+ add:</span>
          {hidden.map((key) => (
            <button
              key={key}
              type='button'
              onClick={() => setPinned([...shown, key])}
            >
              {key}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default LiveCharts;
