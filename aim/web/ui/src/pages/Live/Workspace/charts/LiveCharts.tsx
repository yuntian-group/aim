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

function branchColor(branch: string, branches: string[]): string {
  const idx = branches.indexOf(branch);
  return BRANCH_COLORS[(idx < 0 ? 0 : idx) % BRANCH_COLORS.length];
}

interface IMarker {
  step: number;
  type: string;
}

function MiniChart({
  title,
  points,
  markers,
}: {
  title: string;
  points: IMetricPoint[];
  markers: IMarker[];
}) {
  const width = 520;
  const height = 150;
  const pad = { l: 44, r: 12, t: 10, b: 22 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;

  const { xMin, xMax, yMin, yMax, branches } = React.useMemo(() => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    const brs: string[] = [];
    points.forEach((p) => {
      x0 = Math.min(x0, p.step);
      x1 = Math.max(x1, p.step);
      y0 = Math.min(y0, p.value);
      y1 = Math.max(y1, p.value);
      if (!brs.includes(p.branch)) {
        brs.push(p.branch);
      }
    });
    if (y0 === y1) {
      y0 -= 1;
      y1 += 1;
    }
    if (x0 === x1) {
      x1 = x0 + 1;
    }
    return { xMin: x0, xMax: x1, yMin: y0, yMax: y1, branches: brs };
  }, [points]);

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

  const byBranch: Record<string, IMetricPoint[]> = {};
  points.forEach((p) => {
    (byBranch[p.branch] = byBranch[p.branch] || []).push(p);
  });

  return (
    <div className='MiniChart'>
      <div className='MiniChart__head'>
        <span className='MiniChart__title'>{title}</span>
        <span className='MiniChart__last'>
          {points[points.length - 1].value.toFixed(4)}
        </span>
      </div>
      <svg
        width='100%'
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio='none'
      >
        {/* y axis labels */}
        <text x={4} y={pad.t + 8} className='MiniChart__axis'>
          {yMax.toFixed(3)}
        </text>
        <text x={4} y={pad.t + ih} className='MiniChart__axis'>
          {yMin.toFixed(3)}
        </text>
        {/* action markers */}
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
        {/* series */}
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
                  strokeWidth={1.5}
                />
              )}
              {bp
                .filter((p) => p.eval)
                .map((p, i) => (
                  <circle
                    key={i}
                    cx={sx(p.step)}
                    cy={sy(p.value)}
                    r={2.5}
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
  const { metrics, state, events } = store;
  const goalMetric = state?.goal?.metric;

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

  const markers: IMarker[] = React.useMemo(
    () =>
      events
        .filter((e: IControlEvent) => MARKER_TYPES.has(e.type))
        .map((e) => ({
          step:
            typeof e.payload?.step === 'number' ? e.payload.step : store.step,
          type: e.type,
        })),
    [events, store.step],
  );

  const hidden = allKeys.filter((k) => !shown.includes(k));

  return (
    <div className='LiveCharts'>
      {shown.length === 0 ? (
        <div className='LiveCharts__empty'>
          Waiting for metrics from the training stream…
        </div>
      ) : (
        <div className='LiveCharts__grid'>
          {shown.map((key) => (
            <MiniChart
              key={key}
              title={key}
              points={metrics[key] || []}
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
