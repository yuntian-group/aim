import React from 'react';

import './DemoShowcase.scss';

type Mode = 'video' | 'trace';

interface IVideoManifest {
  title: string;
  video_url: string;
  duration_seconds: number;
  protocol: {
    rounds: number;
    steps_per_round: number;
    operator_cadence_steps: number;
    baseline_best_eval_loss: number;
    best_observed_eval_loss: number;
    knobs: string[];
  };
  notice: string;
}

interface ITraceManifest {
  title: string;
  rounds: number;
  steps_per_round: number;
  baseline_score: number;
  best_score: number;
  notice: string;
}

interface IRound {
  round: number;
  baseline: boolean;
  score: number;
  best_step: number;
  frontier_improvement: boolean;
  running_best: number;
  config: Record<string, number>;
  strategy: string;
  actions: Array<Record<string, unknown>>;
  reflection: string;
  agent_usage: {
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
  };
}

interface ILiveSession {
  id: string;
  status: string;
  queue_position?: number;
  message: string;
  aim_live_url: string;
}

function youtubeEmbed(url: string): string {
  const parsed = new URL(url);
  const id = parsed.searchParams.get('v');
  return id ? `https://www.youtube.com/embed/${id}` : url;
}

function Frontier({ rounds }: { rounds: IRound[] }) {
  const width = 560;
  const height = 160;
  const pad = { left: 42, right: 14, top: 14, bottom: 28 };
  const scores = rounds.map((round) => round.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  const x = (round: number) =>
    pad.left +
    (round / Math.max(rounds.length - 1, 1)) * (width - pad.left - pad.right);
  const y = (score: number) =>
    pad.top + ((max - score) / range) * (height - pad.top - pad.bottom);
  const points = rounds.map((round) => `${x(round.round)},${y(round.score)}`);

  return (
    <svg
      className='DemoShowcase__frontier'
      viewBox={`0 0 ${width} ${height}`}
      role='img'
      aria-label='Muon paper-trace scores by round'
    >
      <rect
        x={pad.left}
        y={pad.top}
        width={width - pad.left - pad.right}
        height={height - pad.top - pad.bottom}
      />
      <polyline points={points.join(' ')} fill='none' />
      {rounds.map((round) => (
        <circle
          key={round.round}
          cx={x(round.round)}
          cy={y(round.score)}
          r={round.frontier_improvement || round.baseline ? 5 : 3}
          className={
            round.baseline
              ? 'is-baseline'
              : round.frontier_improvement
              ? 'is-frontier'
              : 'is-other'
          }
        >
          <title>{`R${round.round}: ${round.score.toFixed(4)}`}</title>
        </circle>
      ))}
      <text x={pad.left} y={height - 7}>
        R0 baseline
      </text>
      <text x={width - pad.right} y={height - 7} textAnchor='end'>
        R{rounds.length - 1}
      </text>
    </svg>
  );
}

function DemoShowcase(): React.FunctionComponentElement<React.ReactNode> | null {
  const [mode, setMode] = React.useState<Mode>('video');
  const [video, setVideo] = React.useState<IVideoManifest | null>(null);
  const [trace, setTrace] = React.useState<ITraceManifest | null>(null);
  const [rounds, setRounds] = React.useState<IRound[]>([]);
  const [selectedRound, setSelectedRound] = React.useState(0);
  const [unavailable, setUnavailable] = React.useState(false);
  const [live, setLive] = React.useState<ILiveSession | null>(null);
  const selected = rounds[selectedRound];

  React.useEffect(() => {
    Promise.all([
      fetch('/api/demo/muon/video').then((response) => response.json()),
      fetch('/api/demo/muon/paper-trace').then((response) => response.json()),
      fetch('/api/demo/muon/paper-trace/rounds').then((response) =>
        response.json(),
      ),
    ])
      .then(([videoManifest, traceManifest, traceRounds]) => {
        setVideo(videoManifest);
        setTrace(traceManifest);
        setRounds(traceRounds);
      })
      .catch(() => setUnavailable(true));
  }, []);

  React.useEffect(() => {
    if (!live || !['queued', 'starting', 'running'].includes(live.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      fetch(`/api/demo/live/${live.id}`)
        .then((response) => response.json())
        .then(setLive)
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [live]);

  const startLive = React.useCallback(() => {
    fetch('/api/demo/live', { method: 'POST' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.detail || 'Unable to join the CPU queue');
        }
        return body.session as ILiveSession;
      })
      .then(setLive)
      .catch((error) =>
        setLive({
          id: 'error',
          status: 'failed',
          message: String(error.message || error),
          aim_live_url: '/live',
        }),
      );
  }, []);

  if (unavailable) {
    return null;
  }

  return (
    <section className='DemoShowcase'>
      <div className='DemoShowcase__tabs' role='tablist'>
        <button
          type='button'
          className={mode === 'video' ? 'is-active' : ''}
          onClick={() => setMode('video')}
        >
          Video walkthrough
        </button>
        <button
          type='button'
          className={mode === 'trace' ? 'is-active' : ''}
          onClick={() => setMode('trace')}
        >
          Explore the paper trace
        </button>
      </div>

      {mode === 'video' && video && (
        <div className='DemoShowcase__content'>
          <div>
            <span className='DemoShowcase__badge is-video'>VIDEO ONLY</span>
            <h3>{video.title}</h3>
            <p>{video.notice}</p>
            <div className='DemoShowcase__facts'>
              <span>{video.protocol.rounds} rounds</span>
              <span>{video.protocol.steps_per_round} steps/round</span>
              <span>actions every {video.protocol.operator_cadence_steps}</span>
              <span>
                {video.protocol.baseline_best_eval_loss} →{' '}
                {video.protocol.best_observed_eval_loss}
              </span>
            </div>
          </div>
          <div className='DemoShowcase__video'>
            <iframe
              src={youtubeEmbed(video.video_url)}
              title={video.title}
              allow='accelerometer; autoplay; encrypted-media; picture-in-picture'
              allowFullScreen
            />
          </div>
        </div>
      )}

      {mode === 'trace' && trace && selected && (
        <div className='DemoShowcase__trace'>
          <span className='DemoShowcase__badge is-trace'>
            ROUND-LEVEL PAPER TRACE
          </span>
          <h3>{trace.title}</h3>
          <p>{trace.notice}</p>
          <Frontier rounds={rounds} />
          <div className='DemoShowcase__rounds'>
            {rounds.map((round, index) => (
              <button
                key={round.round}
                type='button'
                className={selectedRound === index ? 'is-active' : ''}
                onClick={() => setSelectedRound(index)}
              >
                R{round.round}
              </button>
            ))}
          </div>
          <div className='DemoShowcase__roundDetail'>
            <div>
              <strong>Score</strong>
              <span>{selected.score.toFixed(4)}</span>
            </div>
            <div>
              <strong>Best step</strong>
              <span>{selected.best_step}</span>
            </div>
            <div>
              <strong>Actions</strong>
              <span>{selected.actions.length}</span>
            </div>
            <div>
              <strong>Cumulative cost</strong>
              <span>
                {selected.agent_usage.cost_usd == null
                  ? 'baseline'
                  : `$${selected.agent_usage.cost_usd.toFixed(2)}`}
              </span>
            </div>
          </div>
          {selected.strategy && (
            <article>
              <h4>Starting strategy</h4>
              <p>{selected.strategy}</p>
            </article>
          )}
          {selected.reflection && (
            <article>
              <h4>Reflection carried to the next round</h4>
              <p>{selected.reflection}</p>
            </article>
          )}
        </div>
      )}

      <aside className='DemoShowcase__live'>
        <div>
          <span className='DemoShowcase__badge is-live'>
            LIVE CPU MICRO-DEMO
          </span>
          <strong>Control a real reduced tiny-BERT run</strong>
          <p>One shared CPU worker, no LLM calls, safe actions only.</p>
        </div>
        {!live ? (
          <button type='button' onClick={startLive}>
            Join live queue
          </button>
        ) : (
          <div>
            <strong>{live.status}</strong>
            {live.queue_position && (
              <span> · position {live.queue_position}</span>
            )}
            <p>{live.message}</p>
            {live.status === 'running' && (
              <p>Select the newest public-cpu session in the list below.</p>
            )}
          </div>
        )}
      </aside>
    </section>
  );
}

export default DemoShowcase;
