// Live event stream hook (design doc §3.4, §6.7).
//
// Strategy: connect the WS bridge with `since=lastSeq+1`; dedupe by `seq`; reconnect
// with exponential backoff (1s -> 10s). While the WS is closed, fall back to polling
// `GET /events?since=` every 2s. A proxy 502 means the session ended (archive mode).

import React from 'react';

import liveControlService from 'services/api/liveControl/liveControlService';

import { IControlEvent } from 'types/services/models/live/live';
import { IApiRequest } from 'types/services/services';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'ended';

interface IUseLiveEventsResult {
  connection: ConnectionState;
}

const POLL_INTERVAL_MS = 2000;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 10_000;

export default function useLiveEvents(
  runHash: string | null,
  onEvents: (events: IControlEvent[]) => void,
  enabled: boolean = true,
): IUseLiveEventsResult {
  const [connection, setConnection] =
    React.useState<ConnectionState>('connecting');

  const lastSeqRef = React.useRef<number>(-1);
  const onEventsRef = React.useRef(onEvents);
  onEventsRef.current = onEvents;

  React.useEffect(() => {
    if (!runHash || !enabled) {
      return;
    }

    let disposed = false;
    let ws: WebSocket | null = null;
    let backoff = BACKOFF_START_MS;
    let reconnectTimer: number | undefined;
    let pollTimer: number | undefined;
    let pollReq: IApiRequest<{ events: IControlEvent[] }> | null = null;

    lastSeqRef.current = -1;

    const ingest = (events: IControlEvent[]) => {
      const fresh = events.filter((e) => e.seq > lastSeqRef.current);
      if (fresh.length === 0) {
        return;
      }
      fresh.forEach((e) => {
        if (e.seq > lastSeqRef.current) {
          lastSeqRef.current = e.seq;
        }
      });
      onEventsRef.current(fresh);
    };

    const startPolling = () => {
      if (pollTimer !== undefined || disposed) {
        return;
      }
      const tick = () => {
        pollReq = liveControlService.fetchEvents(
          runHash,
          lastSeqRef.current + 1,
        );
        pollReq
          .call((detail: any) => {
            if (detail?.status === 502 || detail?.status === 504) {
              if (!disposed) {
                setConnection('ended');
              }
            }
          })
          .then((data: { events: IControlEvent[] }) => {
            if (!disposed && data?.events) {
              ingest(data.events);
            }
          })
          .catch(() => {});
      };
      tick();
      pollTimer = window.setInterval(tick, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (pollTimer !== undefined) {
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      }
      pollReq?.abort();
      pollReq = null;
    };

    const scheduleReconnect = () => {
      if (disposed) {
        return;
      }
      startPolling(); // keep data flowing while the socket is down
      setConnection('reconnecting');
      reconnectTimer = window.setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
    };

    const connect = () => {
      if (disposed) {
        return;
      }
      let url: string;
      try {
        url = liveControlService.getEventsWsUrl(
          runHash,
          lastSeqRef.current + 1,
        );
        ws = new WebSocket(url);
      } catch (e) {
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        if (disposed) {
          return;
        }
        backoff = BACKOFF_START_MS;
        stopPolling();
        setConnection('open');
      };

      ws.onmessage = (msg: MessageEvent) => {
        try {
          const event: IControlEvent = JSON.parse(msg.data);
          ingest([event]);
        } catch (e) {
          /* ignore malformed frame */
        }
      };

      ws.onerror = () => {
        // onclose handles reconnection.
      };

      ws.onclose = (ev: CloseEvent) => {
        if (disposed) {
          return;
        }
        // 4404 = control URL absent / run unknown -> permanently ended.
        if (ev.code === 4404) {
          setConnection('ended');
          startPolling();
          return;
        }
        scheduleReconnect();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      stopPolling();
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.onopen = null;
        try {
          ws.close();
        } catch (e) {
          /* noop */
        }
      }
    };
  }, [runHash, enabled]);

  return { connection };
}
