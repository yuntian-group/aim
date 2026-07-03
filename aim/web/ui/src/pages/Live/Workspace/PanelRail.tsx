import React from 'react';

import { Icon } from 'components/kit';
import { IconName } from 'components/kit/Icon';

import { ILiveSession } from 'types/services/models/live/live';

import { ILiveSessionStore } from '../liveStore';
import { countQueued, hasFailure } from '../liveActionLifecycle';

import InfoPanel from './panels/InfoPanel';
import HyperparamsPanel from './panels/HyperparamsPanel';
import PlaceholderPanel from './panels/PlaceholderPanel';

import './PanelRail.scss';

interface IPanelRailProps {
  runHash: string;
  session?: ILiveSession;
  store: ILiveSessionStore;
  disabled?: boolean;
}

type PanelKey = 'info' | 'hyper' | 'ckpts' | 'model' | 'agent';

const ACTIVE_KEY = 'live.activePanel';

function PanelRail({
  runHash,
  session,
  store,
  disabled,
}: IPanelRailProps): React.FunctionComponentElement<React.ReactNode> {
  const [active, setActive] = React.useState<PanelKey>(
    () => (localStorage.getItem(ACTIVE_KEY) as PanelKey) || 'hyper',
  );

  React.useEffect(() => {
    localStorage.setItem(ACTIVE_KEY, active);
  }, [active]);

  const queued = countQueued(store.pending);
  const failed = hasFailure(store.pending);

  const items: {
    key: PanelKey;
    icon: IconName;
    label: string;
    title: string;
    badge?: React.ReactNode;
  }[] = [
    {
      key: 'info',
      icon: 'circle-info' as IconName,
      label: 'Info',
      title: 'Session info',
    },
    {
      key: 'hyper',
      icon: 'box-settings' as IconName,
      label: 'Hyper',
      title: 'Hyperparameters',
      badge:
        queued > 0 || failed ? (
          <span className={`PanelRail__badge ${failed ? 'is-error' : ''}`}>
            {failed ? '!' : queued}
          </span>
        ) : null,
    },
    {
      key: 'ckpts',
      icon: 'archive' as IconName,
      label: 'Ckpts',
      title: 'Checkpoints',
    },
    {
      key: 'model',
      icon: 'aggregation' as IconName,
      label: 'Model',
      title: 'Model',
    },
    {
      key: 'agent',
      icon: 'avatar' as IconName,
      label: 'Agent',
      title: 'Agent',
      badge: store.state?.agent?.active ? (
        <span className='PanelRail__badge PanelRail__badge--pulse' />
      ) : null,
    },
  ];

  const renderPanel = () => {
    switch (active) {
      case 'info':
        return <InfoPanel store={store} session={session} runHash={runHash} />;
      case 'hyper':
        return <HyperparamsPanel store={store} disabled={disabled} />;
      case 'ckpts':
        return (
          <PlaceholderPanel
            title='Checkpoints'
            hint='Checkpoint save/load/fork lands in a later milestone. Use the header “Checkpoint” button to save now.'
          />
        );
      case 'model':
        return (
          <PlaceholderPanel
            title='Model'
            hint='Module tree + per-layer actions render here when the trainer exposes model_tree.'
          />
        );
      case 'agent':
        return (
          <PlaceholderPanel
            title='Agent'
            hint='Agent configuration & context editor render here (feature-detected from state.actions).'
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className='PanelRail'>
      <div className='PanelRail__tabs'>
        {items.map((item) => (
          <button
            key={item.key}
            type='button'
            title={item.title}
            className={`PanelRail__tab ${
              active === item.key ? 'is-active' : ''
            }`}
            onClick={() => setActive(item.key)}
          >
            <Icon className='PanelRail__glyph' name={item.icon} fontSize={16} />
            {active === item.key && (
              <span className='PanelRail__label'>{item.label}</span>
            )}
            {item.badge}
          </button>
        ))}
      </div>
      <div className='PanelRail__body'>{renderPanel()}</div>
    </div>
  );
}

export default PanelRail;
