import React from 'react';

import { Icon } from 'components/kit';
import { IconName } from 'components/kit/Icon';

import { ILiveSession } from 'types/services/models/live/live';

import { ILiveSessionStore } from '../liveStore';
import { statusClass } from '../SessionList';
import { ConnectionState } from '../useLiveEvents';

import './Header.scss';

interface IHeaderProps {
  runHash: string;
  session?: ILiveSession;
  store: ILiveSessionStore;
  onBack: () => void;
}

function connectionMeta(connection: ConnectionState): {
  cls: string;
  label: string;
} {
  switch (connection) {
    case 'open':
      return { cls: 'ok', label: 'live' };
    case 'connecting':
    case 'reconnecting':
      return { cls: 'warn', label: 'reconnecting' };
    default:
      return { cls: 'err', label: 'ended' };
  }
}

function Header({
  runHash,
  session,
  store,
  onBack,
}: IHeaderProps): React.FunctionComponentElement<React.ReactNode> {
  const { state, status, step, connection } = store;
  const frozen = connection === 'ended';
  const availableActions = new Set((state?.actions || []).map((a) => a.type));
  const has = (type: string) => availableActions.has(type);

  const conn = connectionMeta(connection);
  const goal = state?.goal || session?.goal || null;

  const submit = (type: string, payload: Record<string, any> = {}) => {
    store.submitAction({ type, payload });
  };

  const btnIcon = (name: IconName) => (
    <Icon name={name} fontSize={12} className='LiveBtn__icon' />
  );

  return (
    <header className='LiveHeader'>
      <button className='LiveHeader__back' type='button' onClick={onBack}>
        ‹ Sessions
      </button>

      <div className='LiveHeader__ident'>
        <span className='LiveHeader__exp' title={session?.experiment}>
          {session?.experiment || runHash.slice(0, 8)}
        </span>
        <span className={`LiveBadge LiveBadge--${statusClass(status)}`}>
          <span className='LiveBadge__dot' />
          {status.toUpperCase()}
        </span>
      </div>

      <div className='LiveHeader__facts'>
        {session && <span>round {session.round}</span>}
        <span>step {step}</span>
        {goal && (
          <span>
            goal {goal.metric} {goal.direction === 'min' ? '↓' : '↑'}
          </span>
        )}
      </div>

      <div className='LiveHeader__actions'>
        {status === 'running'
          ? has('pause') && (
              <button
                type='button'
                className='LiveBtn'
                disabled={frozen}
                onClick={() => submit('pause')}
              >
                {btnIcon('pause' as IconName)} Pause
              </button>
            )
          : has('resume') && (
              <button
                type='button'
                className='LiveBtn LiveBtn--primary'
                disabled={frozen}
                onClick={() => submit('resume')}
              >
                {btnIcon('play' as IconName)} Resume
              </button>
            )}
        {has('stop') && (
          <button
            type='button'
            className='LiveBtn'
            disabled={frozen}
            onClick={() => {
              if (
                window.confirm(
                  'End the current round? Training proceeds to the next round (if any).',
                )
              ) {
                submit('stop');
              }
            }}
          >
            {btnIcon('close-rectangle' as IconName)} End round
          </button>
        )}
        {has('evaluate') && (
          <button
            type='button'
            className='LiveBtn'
            disabled={frozen}
            onClick={() => submit('evaluate', {})}
          >
            {btnIcon('check-rectangle' as IconName)} Evaluate
          </button>
        )}
        {has('save_checkpoint') && (
          <button
            type='button'
            className='LiveBtn'
            disabled={frozen}
            onClick={() => submit('save_checkpoint', {})}
          >
            {btnIcon('archive' as IconName)} Checkpoint
          </button>
        )}
        {has('set_agent') && state?.agent?.attached && (
          <button
            type='button'
            className={`LiveBtn LiveBtn--toggle ${
              state.agent.active ? 'is-on' : ''
            }`}
            disabled={frozen}
            onClick={() =>
              submit('set_agent', { enabled: !state?.agent?.active })
            }
          >
            agent {state.agent.active ? 'ON' : 'OFF'}
          </button>
        )}
      </div>

      <div
        className={`LiveHeader__conn LiveHeader__conn--${conn.cls}`}
        title={`stream: ${conn.label}`}
      >
        <span className='LiveHeader__connDot' />
        {conn.label}
      </div>
    </header>
  );
}

export default Header;
