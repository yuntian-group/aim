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
  eval: boolean;
}

export type MetricBuffers = Record<string, IMetricPoint[]>;

const METRIC_BUFFER_CAP = 5000;
const FEED_CAP = 1000;
const STATE_FALLBACK_POLL_MS = 5000;

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
  submitAction: (
    action: IControlAction,
    widgetKey?: string,
  ) => Promise<string | null>;
  refetchState: () => void;
}

const NON_METRIC_KEYS = new Set(['step', 'eval']);

export function useLiveSession(runHash: string | null): ILiveSessionStore {
  const [state, setState] = React.useState<IControlState | null>(null);
  const [loadingState, setLoadingState] = React.useState<boolean>(true);
  const [loadingHistory, setLoadingHistory] = React.useState<boolean>(true);
  const [stateError, setStateError] = React.useState<boolean>(false);
  const [status, setStatus] = React.useState<LiveStatus>('idle');
  const [step, setStep] = React.useState<number>(0);
  const [pending, setPending] = React.useState<PendingMap>({});
  const [events, setEvents] = React.useState<IControlEvent[]>([]);
  const [metrics, setMetrics] = React.useState<MetricBuffers>({});

  // Dedupe keys for metric points across history/live seam (step|branch|metric).
  const metricSeenRef = React.useRef<Record<string, boolean>>({});
  const setMetricSeen = (v: Record<string, boolean>) => {
    metricSeenRef.current = v;
  };

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
    refetchState();
  }, [runHash, refetchState]);

  // Merge a `metric/get-batch` response (list of {name, context, iters, values})
  // into the buffers. Points already delivered by the live stream are skipped via
  // the shared (metric|branch|step) dedupe keys, and buffers are re-sorted by step
  // so the "last value" readout stays the most recent point.
  const seedHistory = React.useCallback((batch: any[]) => {
    const seen = metricSeenRef.current;
    const buffers: MetricBuffers = {};

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
      const isEval = !!context.eval;
      for (let i = 0; i < iters.length; i++) {
        const step = iters[i];
        const value = values[i]; // non-finite values arrive as null; skip them
        if (typeof step !== 'number' || typeof value !== 'number') {
          continue;
        }
        const dedupeKey = `${name}|${branch}|${step}`;
        if (seen[dedupeKey]) {
          continue;
        }
        seen[dedupeKey] = true;
        (buffers[name] = buffers[name] || []).push({
          step,
          value,
          branch,
          eval: isEval,
        });
      }
    });

    if (Object.keys(buffers).length === 0) {
      return;
    }
    setMetrics((prev) => {
      const next: MetricBuffers = { ...prev };
      Object.keys(buffers).forEach((key) => {
        const merged = (next[key] || []).concat(buffers[key]);
        merged.sort((a, b) => a.step - b.step);
        next[key] =
          merged.length > METRIC_BUFFER_CAP
            ? merged.slice(merged.length - METRIC_BUFFER_CAP)
            : merged;
      });
      return next;
    });
  }, []);

  // Historical metrics: one batch read from Aim storage — the same
  // `runs/{hash}/info` + `runs/{hash}/metric/get-batch` pair the run detail page
  // uses — so history renders in a single pass and survives trainer restarts.
  // The WS stream then only has to carry the live tail.
  React.useEffect(() => {
    if (!runHash) {
      return;
    }
    let disposed = false;
    let batchReq: IApiRequest<any> | null = null;
    const infoReq: IApiRequest<any> = runsService.getRunInfo(runHash);

    setLoadingHistory(true);
    infoReq
      .call()
      .then((info: any) => {
        const metricTraces = (info?.traces?.metric || []).filter(
          (trace: any) => !trace?.name?.startsWith('__system__'),
        );
        if (disposed || metricTraces.length === 0) {
          return null;
        }
        batchReq = runsService.getRunMetricsBatch(
          metricTraces.map((trace: any) => ({
            name: trace.name,
            context: trace.context || {},
          })),
          runHash,
        );
        return batchReq.call();
      })
      .then((batch: any) => {
        if (!disposed && Array.isArray(batch)) {
          seedHistory(batch);
        }
      })
      .catch(() => {
        /* history is best-effort; the live stream still works without it */
      })
      .finally(() => {
        if (!disposed) {
          setLoadingHistory(false);
        }
      });

    return () => {
      disposed = true;
      infoReq.abort();
      batchReq?.abort();
    };
  }, [runHash, seedHistory]);

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
    const seen = metricSeenRef.current;
    const buffers: MetricBuffers = {};

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
      } else if (ev.type === 'checkpoint_saved') {
        setState((prev) =>
          prev
            ? {
                ...prev,
                checkpoints: prev.checkpoints.concat(ev.payload as any),
              }
            : prev,
        );
      } else if (ev.type === 'metrics') {
        const p = ev.payload || {};
        const isEval = !!p.eval;
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
          const dedupeKey = `${key}|${ev.branch_id}|${pointStep}`;
          if (seen[dedupeKey]) {
            return;
          }
          seen[dedupeKey] = true;
          metricsDirty = true;
          (buffers[key] = buffers[key] || []).push({
            step: pointStep,
            value,
            branch: ev.branch_id,
            eval: isEval,
          });
        });
      }
    });

    if (metricsDirty) {
      setMetrics((prev) => {
        const next: MetricBuffers = { ...prev };
        Object.keys(buffers).forEach((key) => {
          const merged = (next[key] || []).concat(buffers[key]);
          next[key] =
            merged.length > METRIC_BUFFER_CAP
              ? merged.slice(merged.length - METRIC_BUFFER_CAP)
              : merged;
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
