import React from 'react';

import { IControlEvent } from 'types/services/models/live/live';

import { ILiveSessionStore } from '../../liveStore';

interface IEventsFeedProps {
  store: ILiveSessionStore;
}

function humanize(ev: IControlEvent): string {
  const p = ev.payload || {};
  switch (ev.type) {
    case 'knob_changed':
      return `${p.name} → ${p.value}`;
    case 'status_changed':
      return `status: ${p.status}`;
    case 'metrics':
      return Object.keys(p)
        .filter((k) => k !== 'step' && k !== 'eval')
        .map((k) => `${k}=${p[k]}`)
        .join('  ');
    case 'note':
      return `“${p.text}”`;
    case 'action_result':
      return `${p.type} ${p.ok ? 'ok' : 'failed'}${
        p.error ? `: ${p.error}` : ''
      }`;
    case 'checkpoint_saved':
      return `checkpoint @${p.step}${p.tag ? ` (${p.tag})` : ''}`;
    case 'evaluate_requested':
      return `evaluate${p.split ? ` (${p.split})` : ''}`;
    case 'agent_enabled':
      return `agent ${p.enabled ? 'enabled' : 'disabled'}`;
    default:
      return JSON.stringify(p);
  }
}

function Row({ ev }: { ev: IControlEvent }) {
  const [open, setOpen] = React.useState(false);
  const ok = ev.type === 'action_result' ? ev.payload?.ok : undefined;
  const time = new Date(ev.ts * 1000).toLocaleTimeString();
  return (
    <div className='EventRow'>
      <span className='EventRow__time'>{time}</span>
      <span className={`EventRow__type EventRow__type--${ev.type}`}>
        {ev.type}
      </span>
      {ok !== undefined && (
        <span className={`EventRow__status ${ok ? 'ok' : 'fail'}`}>
          {ok ? '✓' : '✗'}
        </span>
      )}
      <span className='EventRow__text'>{humanize(ev)}</span>
      <button
        type='button'
        className='EventRow__raw'
        onClick={() => setOpen((o) => !o)}
      >
        {'{}'}
      </button>
      {open && (
        <pre className='EventRow__json'>{JSON.stringify(ev, null, 2)}</pre>
      )}
    </div>
  );
}

function EventsFeed({
  store,
}: IEventsFeedProps): React.FunctionComponentElement<React.ReactNode> {
  const [filter, setFilter] = React.useState<string>('all');

  const types = React.useMemo(() => {
    const set = new Set<string>();
    store.events.forEach((e) => set.add(e.type));
    return ['all', ...Array.from(set)];
  }, [store.events]);

  const shown = store.events
    .filter((e) => filter === 'all' || e.type === filter)
    .slice(-400)
    .reverse();

  return (
    <div className='EventsFeed'>
      <div className='EventsFeed__filters'>
        {types.map((t) => (
          <button
            key={t}
            type='button'
            className={`EventsFeed__chip ${filter === t ? 'is-active' : ''}`}
            onClick={() => setFilter(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className='EventsFeed__list'>
        {shown.length === 0 ? (
          <div className='EventsFeed__empty'>No events yet.</div>
        ) : (
          shown.map((ev) => <Row key={ev.seq} ev={ev} />)
        )}
      </div>
    </div>
  );
}

export default EventsFeed;
