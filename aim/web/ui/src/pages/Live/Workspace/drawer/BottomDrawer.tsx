import React from 'react';

import { ILiveSessionStore } from '../../liveStore';

import EventsFeed from './EventsFeed';
import Console from './Console';

import './BottomDrawer.scss';

interface IBottomDrawerProps {
  runHash: string;
  store: ILiveSessionStore;
  disabled?: boolean;
}

type Tab = 'events' | 'console';

function BottomDrawer({
  store,
  disabled,
}: IBottomDrawerProps): React.FunctionComponentElement<React.ReactNode> {
  const [tab, setTab] = React.useState<Tab>('events');
  const [open, setOpen] = React.useState<boolean>(true);

  return (
    <div className={`BottomDrawer ${open ? 'is-open' : 'is-closed'}`}>
      <div className='BottomDrawer__tabs'>
        <button
          type='button'
          className={`BottomDrawer__tab ${tab === 'events' ? 'is-active' : ''}`}
          onClick={() => {
            setTab('events');
            setOpen(true);
          }}
        >
          Events
        </button>
        <button
          type='button'
          className={`BottomDrawer__tab ${
            tab === 'console' ? 'is-active' : ''
          }`}
          onClick={() => {
            setTab('console');
            setOpen(true);
          }}
        >
          Console
        </button>
        <button
          type='button'
          className='BottomDrawer__toggle'
          onClick={() => setOpen((o) => !o)}
          title={open ? 'Collapse' : 'Expand'}
        >
          {open ? '▾' : '▴'}
        </button>
      </div>
      {open && (
        <div className='BottomDrawer__body'>
          {tab === 'events' ? (
            <EventsFeed store={store} />
          ) : (
            <Console store={store} disabled={disabled} />
          )}
        </div>
      )}
    </div>
  );
}

export default BottomDrawer;
