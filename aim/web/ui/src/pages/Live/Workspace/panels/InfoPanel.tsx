import React from 'react';

import { ILiveSession } from 'types/services/models/live/live';

import { ILiveSessionStore } from '../../liveStore';

interface IInfoPanelProps {
  store: ILiveSessionStore;
  session?: ILiveSession;
  runHash: string;
}

// Live best score from the goal metric across received points.
function computeBest(store: ILiveSessionStore): number | null {
  const goal = store.state?.goal;
  if (!goal) {
    return null;
  }
  const points = store.metrics[goal.metric];
  if (!points || points.length === 0) {
    return null;
  }
  const values = points.map((p) => p.value);
  return goal.direction === 'min' ? Math.min(...values) : Math.max(...values);
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className='LivePanel__fact'>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function InfoPanel({
  store,
  session,
  runHash,
}: IInfoPanelProps): React.FunctionComponentElement<React.ReactNode> {
  const { state, status, step } = store;
  const best = computeBest(store);
  const goal = state?.goal || session?.goal || null;

  return (
    <div className='LivePanel'>
      <h3 className='LivePanel__title'>Session info</h3>
      <div className='LivePanel__facts'>
        <Fact label='Status' value={status} />
        {session && <Fact label='Round' value={session.round} />}
        <Fact label='Step' value={step} />
        <Fact label='Branch' value={state?.branch_id || '—'} />
        {goal && (
          <Fact
            label='Goal'
            value={`${goal.metric} ${goal.direction === 'min' ? '↓' : '↑'}${
              goal.target != null ? ` → ${goal.target}` : ''
            }`}
          />
        )}
        {best != null && <Fact label='Best score' value={best.toFixed(4)} />}
        <Fact
          label='Agent'
          value={
            state?.agent?.attached
              ? state.agent.active
                ? 'attached · active'
                : 'attached · off'
              : 'none'
          }
        />
        <Fact label='Protocol' value={`v${state?.v ?? 2}`} />
        <Fact label='Run' value={<code>{runHash.slice(0, 12)}</code>} />
        {session && session.run_hashes.length > 1 && (
          <Fact label='Rounds' value={session.run_hashes.length} />
        )}
      </div>
    </div>
  );
}

export default InfoPanel;
