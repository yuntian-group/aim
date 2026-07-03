// Action lifecycle state machine (design doc §6.5).
//
//   idle -> dirty -> queued (POSTed, have id) -> applied (action_result ok:true)
//                                             \-> failed (ok:false / error / timeout)
//
// Correlation is by action id (POST response) against action_result.id.

import { IControlEvent } from 'types/services/models/live/live';

export type PendingStatus = 'queued' | 'applied' | 'failed';

export interface IPendingAction {
  id: string;
  type: string;
  payload: Record<string, any>;
  submittedAt: number;
  status: PendingStatus;
  slow?: boolean; // no result after the timeout, but still waiting (§6.5)
  error?: string | null;
  data?: Record<string, any>;
  // Optional UI correlation key (e.g. knob name) so widgets can reconcile.
  widgetKey?: string;
}

// 10s (§6.5): after this, mark "slow" but keep waiting while the stream is healthy.
export const ACTION_SLOW_TIMEOUT_MS = 10_000;

export type PendingMap = Record<string, IPendingAction>;

export function addPending(
  pending: PendingMap,
  action: IPendingAction,
): PendingMap {
  return { ...pending, [action.id]: action };
}

// Resolve any pending action whose id matches an incoming action_result event.
export function reconcilePendingWithEvent(
  pending: PendingMap,
  event: IControlEvent,
): PendingMap {
  if (event.type !== 'action_result') {
    return pending;
  }
  const { id, ok, error, data } = event.payload || {};
  if (!id || !pending[id]) {
    return pending;
  }
  return {
    ...pending,
    [id]: {
      ...pending[id],
      status: ok ? 'applied' : 'failed',
      error: ok ? null : error || 'action failed',
      data: data || {},
      slow: false,
    },
  };
}

// Flag long-running queued actions as "slow" (keep waiting).
export function markSlowActions(
  pending: PendingMap,
  now: number = Date.now(),
): PendingMap {
  let changed = false;
  const next: PendingMap = {};
  Object.keys(pending).forEach((id) => {
    const p = pending[id];
    if (
      p.status === 'queued' &&
      !p.slow &&
      now - p.submittedAt > ACTION_SLOW_TIMEOUT_MS
    ) {
      next[id] = { ...p, slow: true };
      changed = true;
    } else {
      next[id] = p;
    }
  });
  return changed ? next : pending;
}

export function countQueued(pending: PendingMap): number {
  return Object.values(pending).filter((p) => p.status === 'queued').length;
}

export function hasFailure(pending: PendingMap): boolean {
  return Object.values(pending).some((p) => p.status === 'failed');
}

// Drop resolved (applied/failed) actions older than `keepMs` so the map stays small.
export function pruneResolved(
  pending: PendingMap,
  keepMs: number = 30_000,
  now: number = Date.now(),
): PendingMap {
  const next: PendingMap = {};
  Object.keys(pending).forEach((id) => {
    const p = pending[id];
    if (p.status === 'queued' || now - p.submittedAt < keepMs) {
      next[id] = p;
    }
  });
  return next;
}
