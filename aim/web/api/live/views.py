"""Live proxy API for interactive training sessions.

This router discovers live training sessions tracked in the Aim repo (runs stamped
with a ``control`` param, see design doc §4) and forwards control traffic to the
trainer's loopback Control Protocol endpoint (design doc §3, §5).

The proxy is a byte-level pass-through: it never validates or re-serializes protocol
payloads, and — critically — never logs ``/actions`` request bodies (they may carry an
API key, design doc §3.8).

NOTE(deviation): the plan/design reference ``httpx``; this fork uses ``requests``
(already a hard dependency) for HTTP forwarding and ``websockets`` (also already a
dependency) for the WS bridge, to avoid adding a new dependency. FastAPI runs the sync
routes below in its threadpool, so blocking ``requests`` calls are safe here.
"""
import threading
import time

from typing import Optional

import requests

from fastapi import APIRouter, HTTPException, Request, Response, WebSocket, WebSocketDisconnect


live_router = APIRouter()

# Shared HTTP session (connection pooling / keep-alive), reused across requests.
_session = requests.Session()

# Timeouts (seconds).
_PING_TIMEOUT = 1.5
_PROXY_TIMEOUT = 5.0

# Discovery TTL cache (design doc §5.2): repo scans + pings must not run per keystroke.
_DISCOVERY_TTL = 5.0
_discovery_cache = {'ts': 0.0, 'data': None}
_discovery_lock = threading.Lock()


def _repo():
    from aim.web.api.projects.project import Project

    return Project().repo


def _read_control(run) -> Optional[dict]:
    """Return the ``control`` param dict of a run, or ``None`` if it is not interactive."""
    try:
        # strict=True (default) reads the run's actual param values; strict=False would
        # return the repo-wide param *schema* (example types), not the real URL.
        control = run.get('control', None)
    except Exception:
        return None
    if not control:
        return None
    # ``control`` may come back as an AimObject / dict-like; normalize to a plain dict.
    try:
        url = control['url'] if not isinstance(control, dict) else control.get('url')
    except Exception:
        url = None
    if not url:
        return None
    return {'url': url}


def _scan_sessions():
    """Scan the repo for interactive runs and group them into sessions by control URL.

    NOTE(perf): ``iter_runs()`` is O(repo); acceptable behind the TTL cache for research
    repos. Each run is wrapped in try/except and skipped on error.
    """
    repo = _repo()
    groups = {}  # url -> list of {run_hash, experiment, round, goal}
    for run in repo.iter_runs():
        try:
            control = _read_control(run)
            if control is None:
                continue
            info = {
                'run_hash': run.hash,
                'experiment': run.experiment,
                'round': _safe_int(run.get('round', 0)),
                'goal': _plain(run.get('goal', None)),
            }
            groups.setdefault(control['url'], []).append(info)
        except Exception:
            continue

    sessions = []
    for url, runs in groups.items():
        runs.sort(key=lambda r: r['round'])
        newest = runs[-1]
        reachable, status, step = _ping(url)
        sessions.append(
            {
                'run_hash': newest['run_hash'],
                'experiment': newest['experiment'],
                'round': newest['round'],
                'status': status,
                'reachable': reachable,
                'goal': newest['goal'],
                'step': step,
                'run_hashes': [r['run_hash'] for r in runs],
            }
        )
    sessions.sort(key=lambda s: (not s['reachable'], s['experiment'] or ''))
    return sessions


def _ping(url: str):
    """Ping ``GET <url>/state``; return (reachable, status, step)."""
    try:
        resp = _session.get(f'{url.rstrip("/")}/state', timeout=_PING_TIMEOUT)
        if resp.status_code == 200:
            body = resp.json()
            return True, body.get('status', 'running'), body.get('step')
    except Exception:
        pass
    return False, 'ended', None


def _safe_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _plain(value):
    """Best-effort convert AimObject-like structures into plain JSON-serializable data."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    try:
        return {k: _plain(v) for k, v in dict(value).items()}
    except Exception:
        return value


@live_router.get('/')
def list_live_sessions():
    now = time.time()
    with _discovery_lock:
        cached = _discovery_cache
        if cached['data'] is not None and now - cached['ts'] < _DISCOVERY_TTL:
            return {'sessions': cached['data']}
    sessions = _scan_sessions()
    with _discovery_lock:
        _discovery_cache['ts'] = time.time()
        _discovery_cache['data'] = sessions
    return {'sessions': sessions}


def _control_url(run_hash: str) -> str:
    run = _repo().get_run(run_hash)
    if run is None:
        raise HTTPException(status_code=404, detail='run not found')
    control = _read_control(run)
    if control is None:
        raise HTTPException(status_code=404, detail='not an interactive run')
    return control['url'].rstrip('/')


def _forward(method: str, run_hash: str, path: str, content: Optional[bytes] = None) -> Response:
    url = _control_url(run_hash) + path
    try:
        # Do NOT log request bodies here (may contain an API key, §3.8).
        resp = _session.request(
            method,
            url,
            data=content,
            headers={'Content-Type': 'application/json'} if content is not None else None,
            timeout=_PROXY_TIMEOUT,
        )
    except requests.exceptions.ConnectTimeout:
        raise HTTPException(status_code=504, detail='control endpoint timed out')
    except requests.exceptions.ReadTimeout:
        raise HTTPException(status_code=504, detail='control endpoint timed out')
    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=502, detail='control endpoint unreachable')
    except requests.exceptions.RequestException:
        raise HTTPException(status_code=502, detail='control endpoint unreachable')
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get('content-type', 'application/json'),
    )


@live_router.get('/{run_hash}/state')
def proxy_state(run_hash: str):
    return _forward('GET', run_hash, '/state')


@live_router.post('/{run_hash}/actions')
async def proxy_actions(run_hash: str, request: Request):
    body = await request.body()
    return _forward('POST', run_hash, '/actions', content=body)


@live_router.get('/{run_hash}/events')
def proxy_events(run_hash: str, since: int = 0):
    return _forward('GET', run_hash, f'/events?since={since}')


@live_router.websocket('/{run_hash}/events/ws')
async def proxy_events_ws(browser_ws: WebSocket, run_hash: str, since: int = 0):
    """Bridge the browser WebSocket to the trainer's ``WS /events`` (design doc §5.3, T3.1).

    No frame inspection: upstream text frames are relayed downstream verbatim.
    """
    import asyncio

    import websockets

    await browser_ws.accept()

    try:
        base = _control_url(run_hash)
    except HTTPException:
        # 4404: control URL absent / run unknown.
        await browser_ws.close(code=4404)
        return

    ws_base = base.replace('http://', 'ws://', 1).replace('https://', 'wss://', 1)
    upstream_url = f'{ws_base}/events?since={since}'

    try:
        async with websockets.connect(upstream_url, max_size=None) as upstream:

            async def pump_upstream_to_browser():
                async for frame in upstream:
                    if isinstance(frame, bytes):
                        frame = frame.decode('utf-8', 'replace')
                    await browser_ws.send_text(frame)

            async def drain_browser():
                # The socket is one-directional; just detect browser close.
                try:
                    while True:
                        await browser_ws.receive_text()
                except WebSocketDisconnect:
                    pass

            up_task = asyncio.ensure_future(pump_upstream_to_browser())
            down_task = asyncio.ensure_future(drain_browser())
            done, pending = await asyncio.wait(
                {up_task, down_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
    except Exception:
        # Upstream refused / closed: signal "session ended" to the browser.
        try:
            await browser_ws.close(code=1011)
        except Exception:
            pass
        return

    try:
        await browser_ws.close()
    except Exception:
        pass
