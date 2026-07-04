// The multiround control surface (multiround_ux §4.1): one chip per round with its
// score + delta, a pulsing live chip, click-to-focus, and follow-live. Hidden entirely
// in single-round sessions — the store's `isMultiround` gate keeps this a no-op there.
import React from 'react';

import { ILiveSessionStore, IRoundMeta } from '../liveStore';

import './RoundRail.scss';

interface IRoundRailProps {
  store: ILiveSessionStore;
}

// Best score among rounds strictly before `round`, honoring goal direction.
function bestBefore(
  meta: IRoundMeta[],
  round: number,
  direction: 'min' | 'max',
): number | null {
  const scores = meta
    .filter((m) => m.round < round && m.score != null)
    .map((m) => m.score as number);
  if (scores.length === 0) {
    return null;
  }
  return direction === 'min' ? Math.min(...scores) : Math.max(...scores);
}

function RoundChip({
  meta,
  focused,
  direction,
  allMeta,
  onFocus,
}: {
  meta: IRoundMeta;
  focused: boolean;
  direction: 'min' | 'max';
  allMeta: IRoundMeta[];
  onFocus: () => void;
}) {
  const prevBest = bestBefore(allMeta, meta.round, direction);
  let delta: React.ReactNode = null;
  if (meta.score != null && prevBest != null && prevBest !== 0) {
    const pct = ((meta.score - prevBest) / Math.abs(prevBest)) * 100;
    const improved = direction === 'min' ? pct < 0 : pct > 0;
    delta = (
      <span
        className={`RoundChip__delta ${improved ? 'is-better' : 'is-worse'}`}
      >
        {pct < 0 ? '▼' : '▲'}
        {Math.abs(pct).toFixed(0)}%
      </span>
    );
  }

  return (
    <button
      type='button'
      className={`RoundChip ${focused ? 'is-focused' : ''} ${
        meta.baseline ? 'is-baseline' : ''
      }`}
      onClick={onFocus}
      title={`Focus round ${meta.round}`}
    >
      <span className='RoundChip__idx'>R{meta.round}</span>
      {meta.baseline && <span className='RoundChip__tag'>baseline</span>}
      {meta.live ? (
        <span className='RoundChip__live'>
          <span className='RoundChip__pulse' /> live…
        </span>
      ) : meta.score != null ? (
        <span className='RoundChip__score'>{meta.score.toFixed(3)}</span>
      ) : (
        <span className='RoundChip__score RoundChip__score--pending'>—</span>
      )}
      {delta}
    </button>
  );
}

function RoundRail({
  store,
}: IRoundRailProps): React.FunctionComponentElement<React.ReactNode> | null {
  const { roundMeta, focusedRound, follow, isMultiround, currentRound } = store;
  const direction = store.state?.goal?.direction === 'max' ? 'max' : 'min';

  // Transient transition toast when the live round advances (§4.1).
  const [toast, setToast] = React.useState<string | null>(null);
  const prevRoundRef = React.useRef<number>(currentRound);
  React.useEffect(() => {
    const prev = prevRoundRef.current;
    if (currentRound > prev) {
      const finished = roundMeta.find((m) => m.round === prev);
      const scoreTxt =
        finished && finished.score != null
          ? ` — score ${finished.score.toFixed(3)}`
          : '';
      setToast(
        `Round ${prev} finished${scoreTxt}. Round ${currentRound} started.`,
      );
      const timer = window.setTimeout(() => setToast(null), 6000);
      prevRoundRef.current = currentRound;
      return () => window.clearTimeout(timer);
    }
    prevRoundRef.current = currentRound;
  }, [currentRound, roundMeta]);

  if (!isMultiround) {
    return null;
  }

  return (
    <div className='RoundRail'>
      <div className='RoundRail__chips'>
        {roundMeta.map((meta) => (
          <RoundChip
            key={meta.round}
            meta={meta}
            focused={meta.round === focusedRound}
            direction={direction}
            allMeta={roundMeta}
            onFocus={() => store.setFocusedRound(meta.round)}
          />
        ))}
      </div>
      {!follow && (
        <button
          type='button'
          className='RoundRail__live'
          onClick={store.followLive}
          title='Return to the live round'
        >
          ↦ live
        </button>
      )}
      {toast && <div className='RoundRail__toast'>{toast}</div>}
    </div>
  );
}

export default RoundRail;
