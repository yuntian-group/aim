import React from 'react';

import { IActionSchema, IKnobView } from 'types/services/models/live/live';

import { ILiveSessionStore } from '../../liveStore';
import { IPendingAction } from '../../liveActionLifecycle';

import './HyperparamsPanel.scss';

interface IHyperparamsPanelProps {
  store: ILiveSessionStore;
  disabled?: boolean;
}

// Built-ins covered by curated header/panels; everything else is a "generic" action.
const CURATED = new Set([
  'set_knob',
  'pause',
  'resume',
  'stop',
  'evaluate',
  'save_checkpoint',
  'load_checkpoint',
  'set_agent',
  'configure_agent',
  'set_context',
]);

function pendingForKnob(
  store: ILiveSessionStore,
  name: string,
): IPendingAction | undefined {
  const list = Object.values(store.pending)
    .filter((p) => p.type === 'set_knob' && p.widgetKey === name)
    .sort((a, b) => b.submittedAt - a.submittedAt);
  return list[0];
}

function KnobWidget({
  knob,
  draft,
  onChange,
  pending,
  disabled,
}: {
  knob: IKnobView;
  draft: any;
  onChange: (value: any) => void;
  pending?: IPendingAction;
  disabled?: boolean;
}) {
  const isDirty = draft !== undefined;
  const value = isDirty ? draft : knob.value;
  const queued = pending?.status === 'queued';
  const failed = pending?.status === 'failed';

  const hasBounds = knob.min != null && knob.max != null;
  const isNumber = knob.dtype === 'float' || knob.dtype === 'int';
  const isBool = knob.dtype === 'bool';

  return (
    <div
      className={`Knob ${queued ? 'is-queued' : ''} ${
        failed ? 'is-failed' : ''
      }`}
    >
      <div className='Knob__head'>
        <span className='Knob__name' title={knob.description || knob.name}>
          {knob.name}
          {knob.description && <span className='Knob__info'>ⓘ</span>}
        </span>
        {queued && (
          <span className='Knob__chip'>
            {pending?.slow ? 'slow…' : 'applying…'}
          </span>
        )}
        {isDirty && !queued && (
          <span className='Knob__chip Knob__chip--dirty'>edited</span>
        )}
      </div>

      {isBool ? (
        <label className='Knob__switch'>
          <input
            type='checkbox'
            checked={!!value}
            disabled={disabled || queued}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{value ? 'true' : 'false'}</span>
        </label>
      ) : isNumber ? (
        <div className='Knob__row'>
          {hasBounds && (
            <input
              className='Knob__slider'
              type='range'
              min={knob.min as number}
              max={knob.max as number}
              step={
                knob.step ??
                (knob.dtype === 'int'
                  ? 1
                  : (Number(knob.max) - Number(knob.min)) / 100 || 0.001)
              }
              value={Number(value) || 0}
              disabled={disabled || queued}
              onChange={(e) => onChange(parseFloat(e.target.value))}
            />
          )}
          <input
            className='Knob__input'
            type='number'
            step={knob.step ?? 'any'}
            value={value ?? ''}
            disabled={disabled || queued}
            onChange={(e) =>
              onChange(e.target.value === '' ? '' : parseFloat(e.target.value))
            }
          />
        </div>
      ) : (
        <input
          className='Knob__input Knob__input--full'
          type='text'
          value={value ?? ''}
          disabled={disabled || queued}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {failed && <div className='Knob__error'>{pending?.error}</div>}
    </div>
  );
}

// Generic action (§6.4 escape hatch): a button + popover form from payload_keys.
function GenericAction({
  action,
  onSubmit,
  disabled,
}: {
  action: IActionSchema;
  onSubmit: (payload: Record<string, any>) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<Record<string, string>>({});
  const keys = action.payload_keys || [];

  if (keys.length === 0) {
    return (
      <button
        type='button'
        className='GenericAction__btn'
        disabled={disabled}
        onClick={() => onSubmit({})}
        title={action.description}
      >
        {action.type}
      </button>
    );
  }

  return (
    <div className='GenericAction'>
      <button
        type='button'
        className='GenericAction__btn'
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={action.description}
      >
        {action.type} ▾
      </button>
      {open && (
        <div className='GenericAction__form'>
          {keys.map((key) => (
            <label key={key} className='GenericAction__field'>
              <span>{key}</span>
              <input
                type='text'
                value={form[key] ?? ''}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            </label>
          ))}
          <button
            type='button'
            className='GenericAction__submit'
            disabled={disabled}
            onClick={() => {
              onSubmit({ ...form });
              setOpen(false);
              setForm({});
            }}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}

function HyperparamsPanel({
  store,
  disabled,
}: IHyperparamsPanelProps): React.FunctionComponentElement<React.ReactNode> {
  const knobs = store.state?.knobs || [];
  const actions = store.state?.actions || [];
  const [drafts, setDrafts] = React.useState<Record<string, any>>({});

  // Clear a draft once its knob reconciles to the applied value.
  React.useEffect(() => {
    setDrafts((prev) => {
      let changed = false;
      const next = { ...prev };
      knobs.forEach((k) => {
        const p = pendingForKnob(store, k.name);
        if (p?.status === 'applied' && next[k.name] !== undefined) {
          delete next[k.name];
          changed = true;
        }
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.pending, store.state]);

  const dirtyNames = Object.keys(drafts).filter((n) => drafts[n] !== undefined);

  const applyAll = () => {
    dirtyNames.forEach((name) => {
      store.submitAction(
        { type: 'set_knob', payload: { name, value: drafts[name] } },
        name,
      );
    });
  };

  const discardAll = () => setDrafts({});

  const genericActions = actions.filter((a) => !CURATED.has(a.type));

  return (
    <div className='LivePanel HyperparamsPanel'>
      <h3 className='LivePanel__title'>Hyperparameters</h3>

      {knobs.length === 0 ? (
        <p className='LivePanel__hint'>
          No knobs registered yet. They are (re)registered at each round start.
        </p>
      ) : (
        <div className='HyperparamsPanel__knobs'>
          {knobs.map((knob) => (
            <KnobWidget
              key={knob.name}
              knob={knob}
              draft={drafts[knob.name]}
              pending={pendingForKnob(store, knob.name)}
              disabled={disabled}
              onChange={(value) =>
                setDrafts((prev) => ({ ...prev, [knob.name]: value }))
              }
            />
          ))}
        </div>
      )}

      {genericActions.length > 0 && (
        <div className='HyperparamsPanel__other'>
          <h4>Other actions</h4>
          <div className='HyperparamsPanel__otherList'>
            {genericActions.map((action) => (
              <GenericAction
                key={action.type}
                action={action}
                disabled={disabled}
                onSubmit={(payload) =>
                  store.submitAction({ type: action.type, payload })
                }
              />
            ))}
          </div>
        </div>
      )}

      {dirtyNames.length > 0 && (
        <div className='HyperparamsPanel__footer'>
          <button
            type='button'
            className='LiveBtn LiveBtn--primary'
            disabled={disabled}
            onClick={applyAll}
          >
            Apply ({dirtyNames.length})
          </button>
          <button type='button' className='LiveBtn' onClick={discardAll}>
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

export default HyperparamsPanel;
