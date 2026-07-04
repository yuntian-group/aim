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

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 240;
const HEIGHT_KEY = 'live.drawerHeight';

function clampHeight(height: number): number {
  const max = Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.75));
  return Math.min(Math.max(height, MIN_HEIGHT), max);
}

function BottomDrawer({
  store,
  disabled,
}: IBottomDrawerProps): React.FunctionComponentElement<React.ReactNode> {
  const [tab, setTab] = React.useState<Tab>('events');
  const [open, setOpen] = React.useState<boolean>(true);
  const [height, setHeight] = React.useState<number>(() => {
    const stored = Number(localStorage.getItem(HEIGHT_KEY));
    return stored > 0 ? clampHeight(stored) : DEFAULT_HEIGHT;
  });

  const onResizeStart = React.useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = height;
      let next = startHeight;

      const onMove = (ev: PointerEvent) => {
        next = clampHeight(startHeight + (startY - ev.clientY));
        setHeight(next);
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem(HEIGHT_KEY, String(next));
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [height],
  );

  return (
    <div
      className={`BottomDrawer ${open ? 'is-open' : 'is-closed'}`}
      style={open ? { height } : undefined}
    >
      {open && (
        <div
          className='BottomDrawer__resizer'
          onPointerDown={onResizeStart}
          title='Drag to resize'
        />
      )}
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
