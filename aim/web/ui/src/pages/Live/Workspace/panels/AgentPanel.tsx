import React from 'react';

import { IControlEvent } from 'types/services/models/live/live';

import { ILiveSessionStore } from '../../liveStore';
import { IPendingAction } from '../../liveActionLifecycle';

import './AgentPanel.scss';

interface IAgentPanelProps {
  store: ILiveSessionStore;
  disabled?: boolean;
}

const PROVIDERS = ['openai', 'openrouter', 'custom'];
const EFFORTS = ['', 'low', 'medium', 'high'];

// Config fields sent through `configure_agent` (api_key is handled separately:
// write-only, never pre-filled — design doc §3.8).
const CONFIG_FIELDS = [
  'provider',
  'model',
  'base_url',
  'reasoning_effort',
  'every',
] as const;

function latestPending(
  store: ILiveSessionStore,
  widgetKey: string,
): IPendingAction | undefined {
  return Object.values(store.pending)
    .filter((p) => p.widgetKey === widgetKey)
    .sort((a, b) => b.submittedAt - a.submittedAt)[0];
}

function PendingChip({ pending }: { pending?: IPendingAction }) {
  if (pending?.status === 'queued') {
    return (
      <span className='AgentPanel__chip'>
        {pending.slow ? 'slow…' : 'applying…'}
      </span>
    );
  }
  if (pending?.status === 'failed') {
    return (
      <span className='AgentPanel__chip AgentPanel__chip--error'>
        {pending.error || 'failed'}
      </span>
    );
  }
  return null;
}

// One LLM exchange (`agent_call`): the response and tool calls up front, the
// full prompt (system + user) behind a disclosure — it can be several KB.
function CallCard({ event }: { event: IControlEvent }) {
  const p = event.payload || {};
  const toolCalls: { name: string; arguments: any }[] = p.tool_calls || [];
  const usage = p.usage || {};
  return (
    <div className='AgentJournal__card'>
      <div className='AgentJournal__head'>
        <span className='AgentJournal__kind'>LLM call</span>
        {p.phase && <span className='AgentJournal__round'>{p.phase}</span>}
        {usage.total_tokens != null && (
          <span className='AgentJournal__round'>
            {usage.total_tokens} tokens
          </span>
        )}
      </div>
      <details className='AgentJournal__details'>
        <summary>Prompt</summary>
        {p.system && (
          <>
            <div className='AgentJournal__label'>system</div>
            <pre className='AgentJournal__pre'>{p.system}</pre>
          </>
        )}
        {p.user && (
          <>
            <div className='AgentJournal__label'>user</div>
            <pre className='AgentJournal__pre'>{p.user}</pre>
          </>
        )}
      </details>
      {p.response ? (
        <p className='AgentJournal__text'>{p.response}</p>
      ) : (
        <p className='AgentJournal__text AgentJournal__text--muted'>
          (no text — {toolCalls.length > 0 ? 'tool calls only' : 'no action'})
        </p>
      )}
      {toolCalls.length > 0 && (
        <code className='AgentJournal__config'>
          {toolCalls
            .map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`)
            .join('  ')}
        </code>
      )}
    </div>
  );
}

function JournalCard({ event }: { event: IControlEvent }) {
  if (event.type === 'agent_call') {
    return <CallCard event={event} />;
  }
  const isPlan = event.type === 'agent_plan';
  const p = event.payload || {};
  return (
    <div className='AgentJournal__card'>
      <div className='AgentJournal__head'>
        <span className='AgentJournal__kind'>
          {isPlan ? 'Plan' : 'Reflection'}
        </span>
        {p.round !== undefined && (
          <span className='AgentJournal__round'>round {p.round}</span>
        )}
      </div>
      {isPlan ? (
        <>
          {p.strategy && <p className='AgentJournal__text'>{p.strategy}</p>}
          {p.config && Object.keys(p.config).length > 0 && (
            <code className='AgentJournal__config'>
              {JSON.stringify(p.config)}
            </code>
          )}
        </>
      ) : (
        <p className='AgentJournal__text'>{p.text}</p>
      )}
    </div>
  );
}

function AgentPanel({
  store,
  disabled,
}: IAgentPanelProps): React.FunctionComponentElement<React.ReactNode> {
  const state = store.state;
  const agent = state?.agent;
  const available = new Set((state?.actions || []).map((a) => a.type));

  // -- config form drafts (only changed keys are submitted) ------------------
  const [drafts, setDrafts] = React.useState<Record<string, any>>({});
  const [apiKey, setApiKey] = React.useState('');
  const [replacingKey, setReplacingKey] = React.useState(false);
  const configPending = latestPending(store, 'agent-config');

  // Clear the form once the trainer confirms the new config (§6.5 reconcile).
  React.useEffect(() => {
    if (configPending?.status === 'applied') {
      setDrafts({});
      setApiKey('');
      setReplacingKey(false);
    }
  }, [configPending?.status]);

  const current = (field: string): any => (agent as any)?.[field] ?? '';
  const draftValue = (field: string): any =>
    drafts[field] !== undefined ? drafts[field] : current(field);
  const setDraft = (field: string, value: any) =>
    setDrafts((prev) => ({ ...prev, [field]: value }));

  const changedConfig = (): Record<string, any> => {
    const payload: Record<string, any> = {};
    CONFIG_FIELDS.forEach((field) => {
      if (drafts[field] !== undefined && drafts[field] !== current(field)) {
        payload[field] =
          field === 'every' ? parseInt(drafts[field], 10) || 1 : drafts[field];
      }
    });
    if (apiKey) {
      payload.api_key = apiKey; // write-only; empty = keep existing key (§3.8)
    }
    return payload;
  };

  const configDirty = Object.keys(changedConfig()).length > 0;

  // -- context editor ---------------------------------------------------------
  const [contextDraft, setContextDraft] = React.useState<string | null>(null);
  const contextPending = latestPending(store, 'agent-context');

  React.useEffect(() => {
    if (contextPending?.status === 'applied') {
      setContextDraft(null); // back in sync with /state.context
    }
  }, [contextPending?.status]);

  const contextValue = contextDraft ?? state?.context ?? '';
  const contextDirty =
    contextDraft !== null && contextDraft !== (state?.context ?? '');

  // -- journal, grouped into round sections (multiround_ux §4.4) --------------
  // Grouping key is the envelope round stamp, falling back to payload.round for
  // plan/reflection cards (both present today). Newest round first / open.
  const journalRounds = React.useMemo(() => {
    const groups: Record<number, IControlEvent[]> = {};
    store.events.forEach((e) => {
      if (
        e.type === 'agent_plan' ||
        e.type === 'agent_reflection' ||
        e.type === 'agent_call'
      ) {
        const r = e.payload?.round ?? e.round ?? 0;
        (groups[r] = groups[r] || []).push(e);
      }
    });
    return Object.keys(groups)
      .map(Number)
      .sort((a, b) => b - a)
      .map((round) => ({ round, cards: groups[round] }));
  }, [store.events]);

  const scoreFor = (round: number): string => {
    const meta = store.roundMeta.find((m) => m.round === round);
    if (!meta) {
      return '';
    }
    if (meta.baseline) {
      return meta.score != null
        ? `${meta.score.toFixed(3)} · baseline`
        : 'baseline';
    }
    return meta.score != null ? meta.score.toFixed(3) : 'score pending';
  };

  const togglePending = latestPending(store, 'agent-toggle');
  const provider = draftValue('provider') || 'openai';
  const showBaseUrl = provider === 'custom' || !!draftValue('base_url');

  return (
    <div className='LivePanel AgentPanel'>
      <h3 className='LivePanel__title'>Agent</h3>

      {/* 1. Status & toggle */}
      <div className='AgentPanel__status'>
        <div className='LivePanel__fact'>
          <span>Status</span>
          <span>
            {agent?.attached
              ? agent.active
                ? 'attached · active'
                : 'attached · off'
              : 'not attached'}
          </span>
        </div>
        {agent?.model && (
          <div className='LivePanel__fact'>
            <span>Model</span>
            <span>
              {agent.provider ? `${agent.provider} / ` : ''}
              {agent.model}
            </span>
          </div>
        )}
        {agent?.every != null && (
          <div className='LivePanel__fact'>
            <span>Cadence</span>
            <span>every {agent.every} steps</span>
          </div>
        )}
        {available.has('set_agent') && (
          <label className='AgentPanel__toggle'>
            <input
              type='checkbox'
              checked={!!agent?.active}
              disabled={disabled || togglePending?.status === 'queued'}
              onChange={(e) =>
                store.submitAction(
                  { type: 'set_agent', payload: { enabled: e.target.checked } },
                  'agent-toggle',
                )
              }
            />
            <span>
              Agent {agent?.active ? 'ON' : 'OFF'}
              {!agent?.attached && ' (attaches on first configure)'}
            </span>
            <PendingChip pending={togglePending} />
          </label>
        )}
      </div>

      {agent?.attached && agent.api_key_set === false && (
        <div className='AgentPanel__warn'>
          Agent cannot act — no API key configured. Set one below.
        </div>
      )}

      {/* 2. Configuration (feature-detected, §3.8) */}
      {available.has('configure_agent') && (
        <div className='AgentPanel__section'>
          <h4>
            Configuration <PendingChip pending={configPending} />
          </h4>
          <label className='AgentPanel__field'>
            <span>Provider</span>
            <select
              value={PROVIDERS.includes(provider) ? provider : 'custom'}
              disabled={disabled}
              onChange={(e) => setDraft('provider', e.target.value)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className='AgentPanel__field'>
            <span>Model</span>
            <input
              type='text'
              placeholder='model slug (e.g. gpt-4o-mini)'
              value={draftValue('model') || ''}
              disabled={disabled}
              onChange={(e) => setDraft('model', e.target.value)}
            />
          </label>
          {showBaseUrl && (
            <label className='AgentPanel__field'>
              <span>Base URL</span>
              <input
                type='text'
                placeholder='https://…/v1'
                value={draftValue('base_url') || ''}
                disabled={disabled}
                onChange={(e) => setDraft('base_url', e.target.value)}
              />
            </label>
          )}
          <label className='AgentPanel__field'>
            <span>Reasoning effort</span>
            <select
              value={draftValue('reasoning_effort') || ''}
              disabled={disabled}
              onChange={(e) => setDraft('reasoning_effort', e.target.value)}
            >
              {EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {effort || '(default)'}
                </option>
              ))}
            </select>
          </label>
          <label className='AgentPanel__field'>
            <span>Acts every N steps</span>
            <input
              type='number'
              min={1}
              value={draftValue('every') || ''}
              disabled={disabled}
              onChange={(e) => setDraft('every', e.target.value)}
            />
          </label>
          <label className='AgentPanel__field'>
            <span>API key</span>
            {agent?.api_key_set && !replacingKey ? (
              <span className='AgentPanel__keySet'>
                key configured ✓{' '}
                <button
                  type='button'
                  className='AgentPanel__link'
                  disabled={disabled}
                  onClick={() => setReplacingKey(true)}
                >
                  Replace
                </button>
              </span>
            ) : (
              <input
                type='password'
                placeholder='write-only; never shown back'
                autoComplete='new-password'
                value={apiKey}
                disabled={disabled}
                onChange={(e) => setApiKey(e.target.value)}
              />
            )}
          </label>
          <div className='AgentPanel__footer'>
            <button
              type='button'
              className='LiveBtn LiveBtn--primary'
              disabled={
                disabled || !configDirty || configPending?.status === 'queued'
              }
              onClick={() =>
                store.submitAction(
                  { type: 'configure_agent', payload: changedConfig() },
                  'agent-config',
                )
              }
            >
              Apply
            </button>
            {(configDirty || replacingKey) && (
              <button
                type='button'
                className='LiveBtn'
                onClick={() => {
                  setDrafts({});
                  setApiKey('');
                  setReplacingKey(false);
                }}
              >
                Discard
              </button>
            )}
          </div>
        </div>
      )}

      {/* 3. Training context (feature-detected) */}
      {available.has('set_context') && (
        <div className='AgentPanel__section'>
          <h4>
            Training context <PendingChip pending={contextPending} />
          </h4>
          <p className='LivePanel__hint'>
            Task description the agent sees in every plan/act/reflect prompt.
          </p>
          <textarea
            className='AgentPanel__context'
            rows={6}
            value={contextValue}
            disabled={disabled}
            onChange={(e) => setContextDraft(e.target.value)}
          />
          {contextDirty && (
            <div className='AgentPanel__footer'>
              <button
                type='button'
                className='LiveBtn LiveBtn--primary'
                disabled={disabled || contextPending?.status === 'queued'}
                onClick={() =>
                  store.submitAction(
                    { type: 'set_context', payload: { context: contextValue } },
                    'agent-context',
                  )
                }
              >
                Save
              </button>
              <button
                type='button'
                className='LiveBtn'
                onClick={() => setContextDraft(null)}
              >
                Revert
              </button>
            </div>
          )}
        </div>
      )}

      {/* 4. Journal, grouped by round */}
      <div className='AgentPanel__section AgentJournal'>
        <h4>Journal</h4>
        {journalRounds.length === 0 ? (
          <p className='LivePanel__hint'>
            Agent plans and reflections appear here as they arrive.
          </p>
        ) : (
          journalRounds.map((group, i) => (
            <details
              key={group.round}
              className='AgentJournal__round'
              open={i === 0}
            >
              <summary className='AgentJournal__roundHead'>
                Round {group.round} — {scoreFor(group.round)}
              </summary>
              {group.cards.map((event) => (
                <JournalCard key={event.seq} event={event} />
              ))}
            </details>
          ))
        )}
      </div>
    </div>
  );
}

export default AgentPanel;
