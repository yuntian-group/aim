// Per-session data layer (design doc §6.7). A small self-contained hook store:
//  - `state`     : proxied /state snapshot (initial + fallback poll while WS is down)
//  - `events`    : capped recent event feed (from useLiveEvents)
//  - `metrics`   : ring buffers per metric key, seeded from Aim storage (batch read,
//                  same endpoint the run detail page uses) and extended by `metrics`
//                  events from the live stream
//  - `pending`   : action lifecycle map (§6.5)
//  - `status`    : live status (state snapshot, updated by status_changed events)
//
// All derived data is reduced from the ordered event log with `/state` as the reset
// snapshot; content between the WS and Aim storage can only differ in recency (§6.7).
// The history/live seam is closed by deduping points on (metric, branch, step).

import React from 'react';

import liveControlService from 'services/api/liveControl/liveControlService';
import runsService from 'services/api/runs/runsService';

import {
  IControlAction,
  IControlEvent,
  IControlState,
  ILiveSession,
  IRoundBudget,
  LiveStatus,
} from 'types/services/models/live/live';
import { IApiRequest } from 'types/services/services';

import useLiveEvents, { ConnectionState } from './useLiveEvents';
import {
  addPending,
  markSlowActions,
  PendingMap,
  pruneResolved,
  reconcilePendingWithEvent,
} from './liveActionLifecycle';

export interface IMetricPoint {
  step: number;
  value: number;
  branch: string;
  round: number;
  eval: boolean;
}

export type MetricBuffers = Record<string, IMetricPoint[]>;

// One entry per round in the session — the round rail / progress strip source.
export interface IRoundMeta {
  round: number;
  baseline: boolean;
  score: number | null;
  live: boolean;
}

const METRIC_BUFFER_CAP = 5000;
const FEED_CAP = 1000;
const STATE_FALLBACK_POLL_MS = 5000;

// `round_score` is the per-round agent-learning-curve metric (step = round index); it
// is not a per-step training metric, so it feeds `roundScores`, not the metric buffers.
const ROUND_SCORE_METRIC = 'round_score';

// Cap each round's slice of a metric buffer independently (multiround_ux §4.2) so a
// long experiment can't evict early rounds' shapes. Buffers stay (round, step)-sorted
// so the "last value" readout is the newest round's newest point.
function capBuffer(points: IMetricPoint[]): IMetricPoint[] {
  const counts: Record<number, number> = {};
  points.forEach((p) => {
    counts[p.round] = (counts[p.round] || 0) + 1;
  });
  if (!Object.keys(counts).some((r) => counts[+r] > METRIC_BUFFER_CAP)) {
    return points;
  }
  const perRound: Record<number, IMetricPoint[]> = {};
  points.forEach((p) => (perRound[p.round] = perRound[p.round] || []).push(p));
  const kept: IMetricPoint[] = [];
  Object.keys(perRound).forEach((r) => {
    const arr = perRound[+r];
    kept.push(
      ...(arr.length > METRIC_BUFFER_CAP
        ? arr.slice(arr.length - METRIC_BUFFER_CAP)
        : arr),
    );
  });
  kept.sort((a, b) => a.round - b.round || a.step - b.step);
  return kept;
}

export interface ILiveSessionStore {
  state: IControlState | null;
  loadingState: boolean;
  loadingHistory: boolean;
  stateError: boolean;
  connection: ConnectionState;
  status: LiveStatus;
  step: number;
  pending: PendingMap;
  events: IControlEvent[];
  metrics: MetricBuffers;
  // Multiround view state (multiround_ux §4). `rounds`/roundMeta describe the session;
  // `focusedRound` is the round the charts/journal render bold; `follow` tracks live.
  currentRound: number;
  rounds: IRoundBudget | null;
  roundMeta: IRoundMeta[];
  focusedRound: number;
  follow: boolean;
  isMultiround: boolean;
  setFocusedRound: (round: number) => void;
  followLive: () => void;
  submitAction: (
    action: IControlAction,
    widgetKey?: string,
  ) => Promise<string | null>;
  refetchState: () => void;
}

const NON_METRIC_KEYS = new Set(['step', 'eval']);

export function useLiveSession(
  runHash: string | null,
  runHashes?: string[],
): ILiveSessionStore {
  const [state, setState] = React.useState<IControlState | null>(null);
  const [loadingState, setLoadingState] = React.useState<boolean>(true);
  const [loadingHistory, setLoadingHistory] = React.useState<boolean>(true);
  const [stateError, setStateError] = React.useState<boolean>(false);
  const [status, setStatus] = React.useState<LiveStatus>('idle');
  const [step, setStep] = React.useState<number>(0);
  const [pending, setPending] = React.useState<PendingMap>({});
  const [events, setEvents] = React.useState<IControlEvent[]>([]);
  const [metrics, setMetrics] = React.useState<MetricBuffers>({});
  const [currentRound, setCurrentRound] = React.useState<number>(0);
  const [rounds, setRounds] = React.useState<IRoundBudget | null>(null);
  const [roundScores, setRoundScores] = React.useState<
    Record<number, number | null>
  >({});
  // Follow-live: focus tracks the newest round until the user pins an older one (§4.1).
  const [focusPin, setFocusPin] = React.useState<number | null>(null);

  // Dedupe keys for metric points across history/live seam (metric|round|branch|step).
  const metricSeenRef = React.useRef<Record<string, boolean>>({});
  const setMetricSeen = (v: Record<string, boolean>) => {
    metricSeenRef.current = v;
  };

  // Latest snapshot, readable from the stable handleEvents callback (rollback lookup).
  const stateRef = React.useRef<IControlState | null>(null);
  stateRef.current = state;

  const refetchState = React.useCallback(() => {
    if (!runHash) {
      return;
    }
    const req = liveControlService.fetchState(runHash);
    req
      .call((detail: any) => {
        if (detail?.status >= 400) {
          setStateError(true);
        }
      })
      .then((data: IControlState) => {
        if (data && data.status) {
          setState(data);
          setStatus(data.status);
          setStep(data.step ?? 0);
          if (typeof data.round === 'number') {
            setCurrentRound(data.round);
          }
          if (data.rounds) {
            setRounds(data.rounds);
          }
          setStateError(false);
        }
      })
      .catch(() => setStateError(true))
      .finally(() => setLoadingState(false));
  }, [runHash]);

  // Initial snapshot.
  React.useEffect(() => {
    setState(null);
    setLoadingState(true);
    setStateError(false);
    setPending({});
    setEvents([]);
    setMetrics({});
    setMetricSeen({});
    setCurrentRound(0);
    setRounds(null);
    setRoundScores({});
    setFocusPin(null);
    refetchState();
  }, [runHash, refetchState]);

  // Merge a `metric/get-batch` response (list of {name, context, iters, values})
  // into the buffers. Points already delivered by the live stream are skipped via
  // the shared (metric|branch|step) dedupe keys, and buffers are re-sorted by step
  // so the "last value" readout stays the most recent point.
  const seedHistory = React.useCallback((batch: any[]) => {
    const seen = metricSeenRef.current;
    const buffers: MetricBuffers = {};
    const scores: Record<number, number | null> = {};

    batch.forEach((trace: any) => {
      const name = trace?.name;
      if (!name) {
        return;
      }
      const iters: unknown[] = Array.isArray(trace.iters) ? trace.iters : [];
      const values: unknown[] = Array.isArray(trace.values) ? trace.values : [];
      const context = trace.context || {};
      const branch =
        typeof context.branch === 'string' ? context.branch : 'main';
      // The trainer writes the round into every metric's context (§4.7); fall back to 0.
      const round = typeof context.round === 'number' ? context.round : 0;
      // Trainer writes eval metrics with context.subset === 'eval' (multiround_ux §3.5).
      const isEval = context.subset === 'eval' || !!context.eval;
      for (let i = 0; i < iters.length; i++) {
        const step = iters[i];
        const value = values[i]; // non-finite values arrive as null; skip them
        if (typeof step !== 'number' || typeof value !== 'number') {
          continue;
        }
        if (name === ROUND_SCORE_METRIC) {
          scores[step] = value; // round_score: step is the round index
          continue;
        }
        const dedupeKey = `${name}|${round}|${branch}|${step}`;
        if (seen[dedupeKey]) {
          continue;
        }
        seen[dedupeKey] = true;
        (buffers[name] = buffers[name] || []).push({
          step,
          value,
          branch,
          round,
          eval: isEval,
        });
      }
    });

    if (Object.keys(scores).length > 0) {
      setRoundScores((prev) => ({ ...scores, ...prev }));
    }
    if (Object.keys(buffers).length === 0) {
      return;
    }
    setMetrics((prev) => {
      const next: MetricBuffers = { ...prev };
      Object.keys(buffers).forEach((key) => {
        const merged = (next[key] || []).concat(buffers[key]);
        merged.sort((a, b) => a.round - b.round || a.step - b.step);
        next[key] = capBuffer(merged);
      });
      return next;
    });
  }, []);

  // Historical metrics: one batch read per round-run from Aim storage — the same
  // `runs/{hash}/info` + `runs/{hash}/metric/get-batch` pair the run detail page
  // uses. A session is many Aim runs (one per round, §4.7), so stitch across all
  // `run_hashes`; the round comes from each trace's context. The WS stream then only
  // has to carry the live tail of the current round.
  const hashesKey = (
    runHashes && runHashes.length ? runHashes : runHash ? [runHash] : []
  ).join(',');
  React.useEffect(() => {
    const hashes = hashesKey ? hashesKey.split(',') : [];
    if (hashes.length === 0) {
      return;
    }
    let disposed = false;
    const reqs: IApiRequest<any>[] = [];

    const seedOne = (hash: string): Promise<void> => {
      const infoReq: IApiRequest<any> = runsService.getRunInfo(hash);
      reqs.push(infoReq);
      return infoReq
        .call()
        .then((info: any) => {
          const metricTraces = (info?.traces?.metric || []).filter(
            (trace: any) => !trace?.name?.startsWith('__system__'),
          );
          if (disposed || metricTraces.length === 0) {
            return null;
          }
          const batchReq = runsService.getRunMetricsBatch(
            metricTraces.map((trace: any) => ({
              name: trace.name,
              context: trace.context || {},
            })),
            hash,
          );
          reqs.push(batchReq);
          return batchReq.call();
        })
        .then((batch: any) => {
          if (!disposed && Array.isArray(batch)) {
            seedHistory(batch);
          }
        })
        .catch(() => {
          /* history is best-effort; the live stream still works without it */
        });
    };

    setLoadingHistory(true);
    Promise.all(hashes.map(seedOne)).finally(() => {
      if (!disposed) {
        setLoadingHistory(false);
      }
    });

    return () => {
      disposed = true;
      reqs.forEach((r) => r.abort());
    };
  }, [hashesKey, seedHistory]);

  // Keep a stable ref so handleEvents can trigger snapshot refetches without
  // re-subscribing the WS on every render.
  const refetchStateRef = React.useRef(refetchState);
  refetchStateRef.current = refetchState;

  const handleEvents = React.useCallback((incoming: IControlEvent[]) => {
    if (incoming.length === 0) {
      return;
    }

    // Feed (capped, newest appended at the end).
    setEvents((prev) => {
      const next = prev.concat(incoming);
      return next.length > FEED_CAP ? next.slice(next.length - FEED_CAP) : next;
    });

    // Pending action reconciliation.
    setPending((prev) => {
      let next = prev;
      incoming.forEach((ev) => {
        next = reconcilePendingWithEvent(next, ev);
      });
      return next;
    });

    // Metric buffers + status/step derivation.
    let metricsDirty = false;
    let needsResync = false;
    const seen = metricSeenRef.current;
    const buffers: MetricBuffers = {};

    const evictRollback = (ev: IControlEvent) => {
      const ckptId = ev.payload?.checkpoint_id;
      const branch = ev.payload?.branch_id ?? ev.branch_id;
      const round = typeof ev.round === 'number' ? ev.round : 0;
      const ckpt = stateRef.current?.checkpoints?.find((c) => c.id === ckptId);
      // Only a same-branch rollback rewinds; a fork keeps both trajectories (§4.6).
      if (!ckpt || ckpt.branch_id !== branch) {
        return;
      }
      const cutoff = ckpt.step;
      setMetrics((prev) => {
        let changed = false;
        const next: MetricBuffers = {};
        Object.keys(prev).forEach((key) => {
          next[key] = prev[key].filter((pt) => {
            const stale =
              pt.round === round && pt.branch === branch && pt.step > cutoff;
            if (stale) {
              changed = true;
              delete seen[`${key}|${round}|${branch}|${pt.step}`];
            }
            return !stale;
          });
        });
        return changed ? next : prev;
      });
    };

    incoming.forEach((ev) => {
      if (ev.type === 'status_changed' && ev.payload?.status) {
        setStatus(ev.payload.status);
      } else if (ev.type === 'knob_changed' && ev.payload?.name) {
        // Reconcile the snapshot to the (already-clamped) applied value (§6.5).
        setState((prev) => {
          if (!prev) {
            return prev;
          }
          return {
            ...prev,
            knobs: prev.knobs.map((k) =>
              k.name === ev.payload.name
                ? { ...k, value: ev.payload.value }
                : k,
            ),
          };
        });
      } else if (ev.type === 'knobs_registered') {
        setState((prev) =>
          prev ? { ...prev, knobs: ev.payload?.knobs || [] } : prev,
        );
      } else if (ev.type === 'checkpoint_saved') {
        setState((prev) =>
          prev
            ? {
                ...prev,
                checkpoints: prev.checkpoints.concat(ev.payload as any),
              }
            : prev,
        );
      } else if (ev.type === 'agent_enabled') {
        setState((prev) =>
          prev
            ? {
                ...prev,
                agent: { ...prev.agent, active: !!ev.payload?.enabled },
              }
            : prev,
        );
      } else if (ev.type === 'agent_configured') {
        // Payload is the trainer's redacted describe() — merge it verbatim so
        // model/provider/every/api_key_set reconcile without a /state re-poll.
        setState((prev) =>
          prev
            ? {
                ...prev,
                agent: { ...prev.agent, attached: true, ...(ev.payload || {}) },
              }
            : prev,
        );
      } else if (ev.type === 'agent_attached') {
        setState((prev) =>
          prev
            ? {
                ...prev,
                agent: {
                  ...prev.agent,
                  attached: true,
                  ...(ev.payload?.active !== undefined
                    ? { active: !!ev.payload.active }
                    : {}),
                  ...(ev.payload?.every != null
                    ? { every: ev.payload.every }
                    : {}),
                },
              }
            : prev,
        );
      } else if (ev.type === 'context_changed') {
        setState((prev) =>
          prev ? { ...prev, context: ev.payload?.context ?? '' } : prev,
        );
      } else if (ev.type === 'model_tree' && ev.payload?.tree) {
        // Published by bind_model() after the round's /state snapshot was taken.
        setState((prev) =>
          prev ? { ...prev, model_tree: ev.payload.tree } : prev,
        );
      } else if (ev.type === 'round_started') {
        // A new round resets the trainer's per-round state (knobs, checkpoints,
        // branches); resync the snapshot instead of patching it piecemeal.
        const r =
          typeof ev.payload?.round === 'number' ? ev.payload.round : undefined;
        if (r !== undefined) {
          setCurrentRound((c) => (r > c ? r : c));
        }
        needsResync = true;
      } else if (ev.type === 'round_finished') {
        const r =
          typeof ev.payload?.round === 'number' ? ev.payload.round : ev.round;
        if (typeof r === 'number') {
          const score =
            typeof ev.payload?.score === 'number' ? ev.payload.score : null;
          setRoundScores((prev) => ({ ...prev, [r]: score }));
        }
      } else if (ev.type === 'checkpoint_loaded') {
        // Rollback (fork:false, same branch) rewinds the step counter; evict the
        // now-superseded tail so retrained steps don't collide with stale dedupe
        // keys and get dropped (multiround_ux §4.6).
        evictRollback(ev);
      } else if (ev.type === 'metrics') {
        const p = ev.payload || {};
        const isEval = !!p.eval;
        const round = typeof ev.round === 'number' ? ev.round : 0;
        const pointStep = typeof p.step === 'number' ? p.step : undefined;
        if (typeof pointStep === 'number') {
          setStep((s) => (pointStep > s ? pointStep : s));
        }
        Object.keys(p).forEach((key) => {
          if (NON_METRIC_KEYS.has(key)) {
            return;
          }
          const value = p[key];
          if (typeof value !== 'number' || pointStep === undefined) {
            return;
          }
          const dedupeKey = `${key}|${round}|${ev.branch_id}|${pointStep}`;
          if (seen[dedupeKey]) {
            return;
          }
          seen[dedupeKey] = true;
          metricsDirty = true;
          (buffers[key] = buffers[key] || []).push({
            step: pointStep,
            value,
            branch: ev.branch_id,
            round,
            eval: isEval,
          });
        });
      }
    });

    if (needsResync) {
      refetchStateRef.current(); // once per batch, even if several rounds replayed
    }

    if (metricsDirty) {
      setMetrics((prev) => {
        const next: MetricBuffers = { ...prev };
        Object.keys(buffers).forEach((key) => {
          const merged = (next[key] || []).concat(buffers[key]);
          merged.sort((a, b) => a.round - b.round || a.step - b.step);
          next[key] = capBuffer(merged);
        });
        return next;
      });
    }
  }, []);

  const { connection } = useLiveEvents(runHash, handleEvents, !!runHash);

  // Fallback /state poll only while the WS is not open (design doc §6.7).
  React.useEffect(() => {
    if (!runHash) {
      return;
    }
    if (connection === 'open') {
      refetchState(); // resync snapshot on (re)connect
      return;
    }
    const timer = window.setInterval(refetchState, STATE_FALLBACK_POLL_MS);
    return () => window.clearInterval(timer);
  }, [runHash, connection, refetchState]);

  // Flag slow actions + prune resolved ones.
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setPending((prev) => pruneResolved(markSlowActions(prev)));
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const submitAction = React.useCallback(
    async (
      action: IControlAction,
      widgetKey?: string,
    ): Promise<string | null> => {
      if (!runHash) {
        return null;
      }
      try {
        const res: { id: string } = await liveControlService
          .postAction(runHash, action)
          .call();
        if (res?.id) {
          setPending((prev) =>
            addPending(prev, {
              id: res.id,
              type: action.type,
              payload: action.payload || {},
              submittedAt: Date.now(),
              status: 'queued',
              widgetKey,
            }),
          );
          return res.id;
        }
      } catch (e) {
        /* surfaced via widget-level error handling */
      }
      return null;
    },
    [runHash],
  );

  // -- derived multiround view state (multiround_ux §4) -----------------------
  const baselineRounds = rounds?.baseline_rounds ?? 0;
  const roundMeta: IRoundMeta[] = React.useMemo(() => {
    const set = new Set<number>();
    Object.keys(roundScores).forEach((r) => set.add(+r));
    for (let r = 0; r <= currentRound; r++) {
      set.add(r);
    }
    (runHashes || []).forEach((_, i) => set.add(i));
    return Array.from(set)
      .filter((r) => r >= 0)
      .sort((a, b) => a - b)
      .map((r) => ({
        round: r,
        baseline: r < baselineRounds,
        score: roundScores[r] ?? null,
        live: r === currentRound,
      }));
  }, [roundScores, currentRound, hashesKey, baselineRounds]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalRounds = baselineRounds + (rounds?.agent_rounds_total ?? 0);
  const isMultiround = roundMeta.length > 1 || totalRounds > 1;

  // Follow-live by default; a pinned round disengages until followLive() (§4.1).
  const follow = focusPin === null;
  // Inline null-check (not `follow`) so TS narrows focusPin to a number here.
  const focusedRound = focusPin === null ? currentRound : focusPin;
  const setFocusedRound = React.useCallback(
    (round: number) =>
      setFocusPin((prev) => (round === currentRound ? null : round)),
    [currentRound],
  );
  const followLive = React.useCallback(() => setFocusPin(null), []);

  return {
    state,
    loadingState,
    loadingHistory,
    stateError,
    connection,
    status,
    step,
    pending,
    events,
    metrics,
    currentRound,
    rounds,
    roundMeta,
    focusedRound,
    follow,
    isMultiround,
    setFocusedRound,
    followLive,
    submitAction,
    refetchState,
  };
}

// Session list (mission control), polled every 10s (design doc §6.7).
export function useLiveSessions(intervalMs: number = 10_000): {
  sessions: ILiveSession[];
  loading: boolean;
  error: boolean;
  refetch: () => void;
} {
  const [sessions, setSessions] = React.useState<ILiveSession[]>([]);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [error, setError] = React.useState<boolean>(false);

  const refetch = React.useCallback(() => {
    liveControlService
      .fetchSessions()
      .call((detail: any) => {
        if (detail?.status >= 400) {
          setError(true);
        }
      })
      .then((data: { sessions: ILiveSession[] }) => {
        if (data?.sessions) {
          setSessions(data.sessions);
          setError(false);
        }
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    refetch();
    const timer = window.setInterval(refetch, intervalMs);
    return () => window.clearInterval(timer);
  }, [refetch, intervalMs]);

  return { sessions, loading, error, refetch };
}
