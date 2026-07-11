import React from 'react';

import { ILiveSessionStore, IRoundMeta } from '../liveStore';

import './ProgressStrip.scss';

interface IProgressStripProps {
  store: ILiveSessionStore;
}

function ScoreChart({
  meta,
  baselineRounds,
  direction,
}: {
  meta: IRoundMeta[];
  baselineRounds: number;
  direction: 'min' | 'max';
}) {
  const scored = meta.filter((m) => m.score != null);
  const width = 320;
  const height = 120;
  const pad = { l: 40, r: 12, t: 12, b: 22 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;

  if (scored.length === 0) {
    return (
      <div className='ProgressStrip__chart ProgressStrip__chart--empty'>
        No round scores yet.
      </div>
    );
  }

  const xs = meta.map((m) => m.round);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs, xMin + 1);
  const ys = scored.map((m) => m.score as number);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (yMin === yMax) {
    const d = Math.abs(yMin) * 0.1 || 1;
    yMin -= d;
    yMax += d;
  }
  const sx = (r: number) => pad.l + ((r - xMin) / (xMax - xMin)) * iw;
  const sy = (v: number) => pad.t + ih - ((v - yMin) / (yMax - yMin)) * ih;

  const baseline = meta.find((m) => m.baseline && m.score != null);
  const line = scored
    .slice()
    .sort((a, b) => a.round - b.round)
    .map((m) => `${sx(m.round)},${sy(m.score as number)}`)
    .join(' ');

  return (
    <svg
      className='ProgressStrip__chart'
      width='100%'
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio='none'
    >
      <rect
        x={pad.l}
        y={pad.t}
        width={iw}
        height={ih}
        className='ProgressStrip__plotArea'
      />
      <text x={pad.l - 6} y={sy(yMax) + 3} className='ProgressStrip__axis'>
        {yMax.toFixed(3)}
      </text>
      <text x={pad.l - 6} y={sy(yMin) + 3} className='ProgressStrip__axis'>
        {yMin.toFixed(3)}
      </text>
      {baseline && baseline.score != null && (
        <line
          x1={pad.l}
          x2={pad.l + iw}
          y1={sy(baseline.score)}
          y2={sy(baseline.score)}
          className='ProgressStrip__baseline'
        >
          <title>baseline {baseline.score.toFixed(3)}</title>
        </line>
      )}
      <polyline
        points={line}
        fill='none'
        className='ProgressStrip__scoreLine'
      />
      {scored.map((m) => (
        <circle
          key={m.round}
          cx={sx(m.round)}
          cy={sy(m.score as number)}
          r={3}
          className={
            m.baseline ? 'ProgressStrip__dot--baseline' : 'ProgressStrip__dot'
          }
        >
          <title>
            R{m.round}: {(m.score as number).toFixed(4)}
          </title>
        </circle>
      ))}
      <text x={pad.l} y={height - 6} className='ProgressStrip__axis'>
        goal {direction === 'min' ? '↓' : '↑'} · baseline rounds{' '}
        {baselineRounds}
      </text>
    </svg>
  );
}

function ProgressStrip({
  store,
}: IProgressStripProps): React.FunctionComponentElement<React.ReactNode> {
  const [open, setOpen] = React.useState(true);
  const { roundMeta } = store;
  const direction = store.state?.goal?.direction === 'max' ? 'max' : 'min';
  const baselineRounds = store.rounds?.baseline_rounds ?? 0;

  const bestBefore = (round: number): number | null => {
    const scores = roundMeta
      .filter((m) => m.round < round && m.score != null)
      .map((m) => m.score as number);
    if (scores.length === 0) {
      return null;
    }
    return direction === 'min' ? Math.min(...scores) : Math.max(...scores);
  };

  return (
    <div className='ProgressStrip'>
      <button
        type='button'
        className='ProgressStrip__toggle'
        onClick={() => setOpen((o) => !o)}
      >
        {open ? '▾' : '▸'} Multi-round control trace · {roundMeta.length} rounds
      </button>
      {open && (
        <div className='ProgressStrip__body'>
          <ScoreChart
            meta={roundMeta}
            baselineRounds={baselineRounds}
            direction={direction}
          />
          <div className='ProgressStrip__tableWrap'>
            <table className='ProgressStrip__table'>
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Score</th>
                  <th>Δ best</th>
                </tr>
              </thead>
              <tbody>
                {roundMeta.map((m) => {
                  const prevBest = bestBefore(m.round);
                  const delta =
                    m.score != null && prevBest != null
                      ? m.score - prevBest
                      : null;
                  const improved =
                    delta != null &&
                    (direction === 'min' ? delta < 0 : delta > 0);
                  return (
                    <tr key={m.round} className={m.live ? 'is-live' : ''}>
                      <td>R{m.round}</td>
                      <td>{m.score != null ? m.score.toFixed(4) : '—'}</td>
                      <td
                        className={
                          delta == null
                            ? ''
                            : improved
                            ? 'is-better'
                            : 'is-worse'
                        }
                      >
                        {delta == null
                          ? '—'
                          : `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default ProgressStrip;
