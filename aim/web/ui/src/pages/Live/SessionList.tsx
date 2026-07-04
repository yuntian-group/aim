import React from 'react';

import { ILiveSession, LiveStatus } from 'types/services/models/live/live';

import './SessionList.scss';

interface ISessionListProps {
  sessions: ILiveSession[];
  onSelect: (runHash: string) => void;
}

export function statusClass(status: LiveStatus): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'stopped':
      return 'paused';
    default:
      return 'ended';
  }
}

function SessionCard({
  session,
  onSelect,
}: {
  session: ILiveSession;
  onSelect: (runHash: string) => void;
}) {
  const goal = session.goal;
  const roundTotal = session.rounds
    ? (session.rounds.baseline_rounds ?? 0) +
      (session.rounds.agent_rounds_total ?? 0)
    : 0;
  const roundLabel =
    roundTotal > 0
      ? `round ${session.round}/${roundTotal}`
      : `round ${session.round}`;
  return (
    <button
      type='button'
      className='SessionCard'
      onClick={() => onSelect(session.run_hash)}
    >
      <div className='SessionCard__top'>
        <span className='SessionCard__name' title={session.experiment}>
          {session.experiment}
        </span>
        <span className={`LiveBadge LiveBadge--${statusClass(session.status)}`}>
          <span className='LiveBadge__dot' />
          {session.status.toUpperCase()}
        </span>
      </div>
      <div className='SessionCard__meta'>
        <span>{roundLabel}</span>
        {session.rounds?.is_baseline && (
          <>
            <span>·</span>
            <span className='SessionCard__baseline'>baseline running</span>
          </>
        )}
        <span>·</span>
        <span>step {session.step ?? '—'}</span>
        {goal && (
          <>
            <span>·</span>
            <span>
              goal {goal.metric} {goal.direction === 'min' ? '↓' : '↑'}
            </span>
          </>
        )}
      </div>
      <div className='SessionCard__footer'>
        {session.run_hashes.length} round
        {session.run_hashes.length === 1 ? '' : 's'} ·{' '}
        <code>{session.run_hash.slice(0, 8)}</code>
      </div>
    </button>
  );
}

function SessionList({
  sessions,
  onSelect,
}: ISessionListProps): React.FunctionComponentElement<React.ReactNode> {
  if (sessions.length === 0) {
    return (
      <div className='SessionList__empty'>
        <div className='SessionList__emptyCard'>
          <h3>No interactive sessions</h3>
          <p>
            Launch a training script with the Aim frontend enabled. Interactive
            runs advertise a control endpoint in their run params and appear
            here within seconds — even before the first metric.
          </p>
          <pre>
            {`run["control"] = {"url": "http://127.0.0.1:<port>"}
run["round"] = 0`}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className='SessionList'>
      {sessions.map((session) => (
        <SessionCard
          key={session.run_hash}
          session={session}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export default SessionList;
