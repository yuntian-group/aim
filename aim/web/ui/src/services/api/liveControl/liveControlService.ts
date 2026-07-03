import { getAPIHost } from 'config/config';

import {
  IControlAction,
  IControlState,
  IControlEvent,
  ILiveSessionsResponse,
} from 'types/services/models/live/live';
import { IApiRequest } from 'types/services/services';

import API from '../api';

const endpoints = {
  LIVE: 'live',
};

function fetchSessions(): IApiRequest<ILiveSessionsResponse> {
  // Trailing slash: the proxy router mounts the list route at '/'.
  return API.get<ILiveSessionsResponse>(`${endpoints.LIVE}/`);
}

function fetchState(runHash: string): IApiRequest<IControlState> {
  return API.get<IControlState>(`${endpoints.LIVE}/${runHash}/state`);
}

function postAction(
  runHash: string,
  action: IControlAction,
): IApiRequest<{ id: string }> {
  return API.post<{ id: string }>(`${endpoints.LIVE}/${runHash}/actions`, {
    source: 'human:web',
    ...action,
  });
}

function fetchEvents(
  runHash: string,
  since: number = 0,
): IApiRequest<{ events: IControlEvent[] }> {
  return API.get<{ events: IControlEvent[] }>(
    `${endpoints.LIVE}/${runHash}/events`,
    { since: String(since) },
  );
}

// Build the same-origin WebSocket URL for the proxied event stream (§5.1).
function getEventsWsUrl(runHash: string, since: number = 0): string {
  const host = getAPIHost(); // e.g. http://127.0.0.1:43800/api  or  /api
  let base: string;
  if (/^https?:\/\//.test(host)) {
    base = host.replace(/^http/, 'ws');
  } else {
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    base = `${wsProto}//${window.location.host}${host}`;
  }
  return `${base}/${endpoints.LIVE}/${runHash}/events/ws?since=${since}`;
}

const liveControlService = {
  endpoints,
  fetchSessions,
  fetchState,
  postAction,
  fetchEvents,
  getEventsWsUrl,
};

export default liveControlService;
