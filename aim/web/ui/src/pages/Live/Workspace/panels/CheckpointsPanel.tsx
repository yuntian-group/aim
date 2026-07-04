import React from 'react';

import { ICheckpoint } from 'types/services/models/live/live';

import { ILiveSessionStore } from '../../liveStore';

import './CheckpointsPanel.scss';

interface ICheckpointsPanelProps {
  store: ILiveSessionStore;
  disabled?: boolean;
}

function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() / 1000 - ts);
  if (diff < 60) {
    return `${Math.floor(diff)}s ago`;
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)}m ago`;
  }
  if (diff < 86400) {
    return `${Math.floor(diff / 3600)}h ago`;
  }
  return `${Math.floor(diff / 86400)}d ago`;
}

function CheckpointRow({
  ckpt,
  isPending,
  disabled,
  canLoad,
  onLoad,
}: {
  ckpt: ICheckpoint;
  isPending: boolean;
  disabled?: boolean;
  canLoad: boolean;
  onLoad: (fork: boolean) => void;
}) {
  return (
    <div className={`Ckpt ${isPending ? 'is-queued' : ''}`}>
      <div className='Ckpt__main'>
        <span className='Ckpt__tag' title={ckpt.path}>
          {ckpt.tag || `step ${ckpt.step}`}
        </span>
        <span className='Ckpt__meta'>
          step {ckpt.step} ·{' '}
          <span className='Ckpt__branch'>{ckpt.branch_id}</span> ·{' '}
          {relativeTime(ckpt.ts)}
        </span>
      </div>
      {canLoad && (
        <div className='Ckpt__actions'>
          <button
            type='button'
            className='LiveBtn LiveBtn--small'
            disabled={disabled || isPending}
            title='Restore weights & optimizer; training continues on this branch'
            onClick={() => {
              if (
                window.confirm(
                  `Load checkpoint @${ckpt.step}? This restores weights & optimizer; ` +
                    'current progress on this branch continues from that step.',
                )
              ) {
                onLoad(false);
              }
            }}
          >
            Load
          </button>
          <button
            type='button'
            className='LiveBtn LiveBtn--small'
            disabled={disabled || isPending}
            title='Load into a new branch; charts will show a new series'
            onClick={() => {
              if (
                window.confirm(
                  `Fork from checkpoint @${ckpt.step}? This creates a new branch — ` +
                    'charts will show a new series.',
                )
              ) {
                onLoad(true);
              }
            }}
          >
            Fork
          </button>
        </div>
      )}
    </div>
  );
}

function CheckpointsPanel({
  store,
  disabled,
}: ICheckpointsPanelProps): React.FunctionComponentElement<React.ReactNode> {
  const state = store.state;
  const [tag, setTag] = React.useState('');

  const available = new Set((state?.actions || []).map((a) => a.type));
  const canSave = available.has('save_checkpoint');
  const canLoad = available.has('load_checkpoint');

  // Newest first.
  const checkpoints = (state?.checkpoints || []).slice().reverse();
  const branches = state?.branches || [];

  const pendingLoadIds = new Set(
    Object.values(store.pending)
      .filter((p) => p.type === 'load_checkpoint' && p.status === 'queued')
      .map((p) => p.payload?.checkpoint_id),
  );
  const savePending = Object.values(store.pending).some(
    (p) => p.type === 'save_checkpoint' && p.status === 'queued',
  );

  const save = () => {
    store.submitAction(
      { type: 'save_checkpoint', payload: tag ? { tag } : {} },
      'ckpt-save',
    );
    setTag('');
  };

  return (
    <div className='LivePanel CheckpointsPanel'>
      <h3 className='LivePanel__title'>Checkpoints</h3>

      {canSave && (
        <div className='CheckpointsPanel__save'>
          <input
            className='Knob__input Knob__input--full'
            type='text'
            placeholder='tag (optional)'
            value={tag}
            disabled={disabled}
            onChange={(e) => setTag(e.target.value)}
          />
          <button
            type='button'
            className='LiveBtn LiveBtn--primary'
            disabled={disabled || savePending}
            onClick={save}
          >
            {savePending ? 'Saving…' : 'Save now'}
          </button>
        </div>
      )}

      {checkpoints.length === 0 ? (
        <p className='LivePanel__hint'>
          No checkpoints yet this round. Save one with the button above, or wait
          for the trainer&apos;s periodic save.
        </p>
      ) : (
        <div className='CheckpointsPanel__list'>
          {checkpoints.map((ckpt) => (
            <CheckpointRow
              key={ckpt.id}
              ckpt={ckpt}
              disabled={disabled}
              canLoad={canLoad}
              isPending={pendingLoadIds.has(ckpt.id)}
              onLoad={(fork) =>
                store.submitAction(
                  {
                    type: 'load_checkpoint',
                    payload: { checkpoint_id: ckpt.id, fork },
                  },
                  ckpt.id,
                )
              }
            />
          ))}
        </div>
      )}

      {branches.length > 1 && (
        <div className='CheckpointsPanel__branches'>
          <h4>Branches</h4>
          {branches.map((b) => (
            <div
              key={b.id}
              className={`CheckpointsPanel__branch ${
                b.id === state?.branch_id ? 'is-current' : ''
              }`}
              style={{ paddingLeft: 8 + (b.id.split('/').length - 1) * 14 }}
            >
              {b.id}
              {b.id === state?.branch_id && <span> · current</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default CheckpointsPanel;
