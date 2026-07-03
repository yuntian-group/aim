# Interactive Training UI — Executable Implementation Plan

Companion to [`aim_interactive_training_ui.md`](./aim_interactive_training_ui.md) (the
"design doc"). That file is the **spec**; this file is the **ordered task list**. Follow
tasks in order — each has a Goal, exact Files, Steps, and a **Verify** block that must
pass before moving on.

All work happens in the **Aim fork** (v3.29.1). Paths below are relative to the fork
root unless stated otherwise.

---

## 0. Rules for the implementing agent

1. **Do tasks in order.** Later tasks assume earlier ones are done and verified.
2. **Never rename protocol fields.** `knobs`, `KnobView`, `set_knob`, `payload`, `seq`,
   etc. are a shared wire contract (design doc §3). "Hyperparams" is a display label
   only.
3. **Only touch listed files.** Every task lists the files it creates or edits. If you
   believe another file must change, stop and re-read the task — the design intends
   additive changes only.
4. **If an internal Aim API doesn't match this plan** (version drift), find the nearest
   equivalent by searching for the anchor text given in the task, adapt minimally, and
   leave a `// NOTE(deviation): ...` comment.
5. **Run the Verify block after every task.** Do not batch verification.
6. **Frontend build environment:** Node 16+; if `npm start`/`npm run build` fails with
   an OpenSSL error, prefix with `NODE_OPTIONS=--openssl-legacy-provider`.
7. **Backend runtime:** the Aim server is started with `aim up --repo <path>`; Python
   changes require restarting it. UI production build:
   `cd aim/web/ui && npm run build` (output is served by the Python server). For
   development use `npm start` (proxies API to `http://127.0.0.1:43800`; check
   `src/setupProxy.js` if requests 404).
8. Keep every new file under ~300 lines; split otherwise.

---

## Phase 0 — test harness (no Aim changes yet)

### T0.1 Stub trainer

**Goal:** a fake training process implementing the Control Protocol (design doc §3), so
every later task is testable without a GPU.

**Files:** `tests/interactive_stub/stub_trainer.py` (new, in the fork).

**Steps:** create the file with exactly this behavior (code below is complete — copy,
then fix imports/lint only):

```python
"""Stub trainer: implements the Control Protocol (design doc §3) + Aim discovery (§4).

Usage:
    python stub_trainer.py --repo /tmp/stub_repo
Then serve that repo:  aim up --repo /tmp/stub_repo --port 43800
"""
import argparse, json, math, random, threading, time, uuid
from collections import deque
from queue import Queue

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

WIRE_VERSION = 2

class Bus:
    def __init__(self):
        self.buf = deque(maxlen=10_000)
        self.subs = set()
        self.seq = 0
        self.lock = threading.Lock()

    def publish(self, type, payload, branch="main"):
        with self.lock:
            ev = {"v": WIRE_VERSION, "seq": self.seq, "type": type,
                  "payload": payload, "ts": time.time(), "branch_id": branch}
            self.seq += 1
            self.buf.append(ev)
            subs = tuple(self.subs)
        for q in subs:
            q.put(ev)
        return ev

    def replay(self, since=0):
        with self.lock:
            return [e for e in self.buf if e["seq"] >= since]

class StubSession:
    def __init__(self):
        self.bus = Bus()
        self.status = "running"
        self.step = 0
        self.knobs = {"lr": {"name": "lr", "value": 1e-4, "dtype": "float",
                             "min": 0.0, "max": None, "step": None,
                             "description": "learning rate"},
                      "weight_decay": {"name": "weight_decay", "value": 0.01,
                                       "dtype": "float", "min": 0.0, "max": 1.0,
                                       "step": None, "description": "weight decay"}}
        self.actions = [
            {"type": "set_knob", "description": "Set a registered knob to a value",
             "payload_keys": ["name", "value"]},
            {"type": "pause", "description": "Pause training", "payload_keys": []},
            {"type": "resume", "description": "Resume training", "payload_keys": []},
            {"type": "evaluate", "description": "Run evaluation", "payload_keys": ["split"]},
            {"type": "note", "description": "Record an annotation", "payload_keys": ["text"]},
            {"type": "set_agent", "description": "Enable/disable the agent",
             "payload_keys": ["enabled"]},
        ]
        self.agent = {"attached": True, "active": False}
        self.pending = Queue()
        threading.Thread(target=self.loop, daemon=True).start()

    def state(self):
        return {"status": self.status, "goal": {"name": "eval_loss", "metric": "eval_loss",
                                                  "direction": "min", "target": None},
                "knobs": list(self.knobs.values()), "actions": self.actions,
                "agent": self.agent, "step": self.step, "branch_id": "main",
                "branches": [{"id": "main", "parent": None, "from_checkpoint": None,
                               "created_at": time.time()}],
                "checkpoints": [], "model_tree": None, "context": "stub run"}

    def submit(self, action):
        action.setdefault("id", uuid.uuid4().hex)
        action.setdefault("payload", {})
        self.pending.put(action)
        return action["id"]

    def apply(self, a):
        t, p, ok, data, err = a["type"], a["payload"], True, {}, None
        if t == "set_knob" and p.get("name") in self.knobs:
            k = self.knobs[p["name"]]
            v = float(p["value"])
            if k["min"] is not None: v = max(v, k["min"])
            if k["max"] is not None: v = min(v, k["max"])
            k["value"] = v
            data = {"name": p["name"], "value": v}
            self.bus.publish("knob_changed", data)
        elif t == "pause":
            self.status = "paused"; self.bus.publish("status_changed", {"status": "paused"})
        elif t == "resume":
            self.status = "running"; self.bus.publish("status_changed", {"status": "running"})
        elif t == "evaluate":
            self.bus.publish("evaluate_requested", dict(p))
        elif t == "note":
            self.bus.publish("note", {"text": p.get("text", "")})
        elif t == "set_agent":
            self.agent["active"] = bool(p.get("enabled", True))
            self.bus.publish("agent_enabled", {"enabled": self.agent["active"]})
        else:
            ok, err = False, f"unknown action type: {t}"
        self.bus.publish("action_result", {"id": a["id"], "type": t, "ok": ok,
                                            "data": data, "error": err})

    def loop(self):
        while True:
            while not self.pending.empty():
                self.apply(self.pending.get())
            if self.status == "running":
                self.step += 1
                lr = self.knobs["lr"]["value"]
                loss = 2.0 * math.exp(-self.step / 300) + random.random() * 0.05 + lr * 100
                self.bus.publish("metrics", {"loss": round(loss, 4),
                                              "learning_rate": lr, "step": self.step})
                if self.step % 25 == 0:
                    self.bus.publish("metrics", {"eval_loss": round(loss + 0.02, 4),
                                                  "step": self.step, "eval": True})
            time.sleep(0.5)

def build_app(sess):
    app = FastAPI()

    @app.get("/state")
    def state(): return sess.state()

    @app.post("/actions")
    def actions(body: dict): return {"id": sess.submit(body)}

    @app.get("/events")
    def events(since: int = 0): return {"events": sess.bus.replay(since)}

    @app.websocket("/events")
    async def ws(sock: WebSocket):
        import asyncio
        await sock.accept()
        q = Queue()
        for ev in sess.bus.replay(int(sock.query_params.get("since", 0))):
            q.put(ev)
        with sess.bus.lock:
            sess.bus.subs.add(q)
        try:
            while True:
                ev = await asyncio.get_event_loop().run_in_executor(None, q.get)
                await sock.send_json(ev)
        except WebSocketDisconnect:
            pass
        finally:
            with sess.bus.lock:
                sess.bus.subs.discard(q)
    return app

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()

    import socket
    if args.port == 0:
        s = socket.socket(); s.bind(("127.0.0.1", 0))
        args.port = s.getsockname()[1]; s.close()
    url = f"http://127.0.0.1:{args.port}"

    from aim import Repo, Run
    if not Repo.exists(args.repo):
        Repo.from_path(args.repo, init=True)
    run = Run(repo=args.repo, experiment="stub_session")
    run["control"] = {"url": url}
    run["round"] = 0
    run["goal"] = {"name": "eval_loss", "metric": "eval_loss",
                   "direction": "min", "target": None}
    print(f"[stub] control endpoint: {url}   aim run: {run.hash}")

    sess = StubSession()
    uvicorn.run(build_app(sess), host="127.0.0.1", port=args.port, log_level="warning")

if __name__ == "__main__":
    main()
```

**Verify:**

```bash
python tests/interactive_stub/stub_trainer.py --repo /tmp/stub_repo --port 45001 &
sleep 3
curl -s http://127.0.0.1:45001/state | python -m json.tool | head -20   # knobs visible
curl -s -X POST http://127.0.0.1:45001/actions \
     -H 'Content-Type: application/json' \
     -d '{"type":"set_knob","payload":{"name":"lr","value":5e-5}}'       # -> {"id": "..."}
sleep 1
curl -s "http://127.0.0.1:45001/events?since=0" | grep -c action_result # >= 1
```

---

## Phase 1 — backend proxy (`/api/live`)

### T1.1 Router skeleton + registration

**Goal:** empty `/api/live/` router mounted and answering.

**Files:**
- new: `aim/web/api/live/__init__.py` (empty), `aim/web/api/live/views.py`
- edit: `aim/web/api/__init__.py`

**Steps:**

1. `views.py` skeleton:

```python
import time
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

live_router = APIRouter()
_client = httpx.Client(timeout=5.0)   # module-level, reused

@live_router.get('/')
def list_live_sessions():
    return {'sessions': []}   # filled in T1.2
```

2. In `aim/web/api/__init__.py`, inside `create_app()` — anchor: the line
   `from aim.web.api.reports.views import reports_router` — add the import
   `from aim.web.api.live.views import live_router`, and after the line
   `api_app.include_router(reports_router, prefix='/reports')` add:
   `api_app.include_router(live_router, prefix='/live')`.
3. If `httpx` is missing from the fork's `requirements.txt`, add `httpx`.

**Verify:**

```bash
pip install -e .            # or restart the server if already editable
aim up --repo /tmp/stub_repo --port 43800 &
sleep 5
curl -s http://127.0.0.1:43800/api/live/    # -> {"sessions": []}
```

### T1.2 Discovery

**Goal:** `GET /api/live/` lists sessions per design doc §5.2.

**Files:** edit `aim/web/api/live/views.py`.

**Steps:**

1. Add a TTL cache (module-level dict `{ts, data}`, 5 s) around the scan.
2. Scan: `from aim.web.api.projects.project import Project`; `repo = Project().repo`;
   iterate `repo.iter_runs()`; for each run read `run.get('control', None)`
   (dict with `url`), `run.get('round', 0)`, `run.get('goal', None)`,
   `run.experiment` (name), `run.hash`. Wrap each run in try/except and skip on error.
   Note: `iter_runs()` is O(repo); acceptable behind the 5 s cache for research repos —
   leave a `# NOTE(perf)` comment.
3. Group runs by `control.url`. For each group: newest = max round. Ping
   `GET <url>/state` (timeout 1.5 s) with the module `_client`; on success take
   `status`, `step`; on failure `reachable=False, status='ended', step=None`.
4. Return the §5.2 shape exactly (keys: `run_hash`, `experiment`, `round`, `status`,
   `reachable`, `goal`, `step`, `run_hashes`).

**Verify:** with stub + server running:

```bash
curl -s http://127.0.0.1:43800/api/live/ | python -m json.tool
# -> one session, "reachable": true, "status": "running", experiment "stub_session"
kill %1 2>/dev/null   # stop the stub, wait >5s (cache), then:
curl -s http://127.0.0.1:43800/api/live/ | grep '"reachable": false'
```

(Restart the stub afterwards.)

### T1.3 State/actions/events HTTP proxy

**Goal:** the three pass-through routes (§5.1, §5.3).

**Files:** edit `aim/web/api/live/views.py`.

**Steps:**

1. Helper `_control_url(run_hash)`: `Project().repo.get_run(run_hash)`; if run is None
   → `HTTPException(404, 'run not found')`; `run.get('control')` missing/None
   → `HTTPException(404, 'not an interactive run')`; return `control['url']`.
2. Routes — forward verbatim, map errors:

```python
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
```

3. `_forward` uses `_client.request(...)`; on `httpx.ConnectError` →
   `HTTPException(502, 'control endpoint unreachable')`; on `httpx.TimeoutException` →
   `HTTPException(504, ...)`. Return
   `Response(content=r.content, media_type='application/json')` (byte pass-through —
   do not re-serialize). **Never log request bodies** (§3.8 key rule).

**Verify:**

```bash
H=$(curl -s http://127.0.0.1:43800/api/live/ | python -c "import sys,json;print(json.load(sys.stdin)['sessions'][0]['run_hash'])")
curl -s http://127.0.0.1:43800/api/live/$H/state | grep '"knobs"'
curl -s -X POST http://127.0.0.1:43800/api/live/$H/actions \
     -H 'Content-Type: application/json' \
     -d '{"type":"set_knob","payload":{"name":"lr","value":7e-5},"source":"human:web"}'
sleep 1
curl -s "http://127.0.0.1:43800/api/live/$H/events?since=0" | grep '7e-05'
# 404 path:
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:43800/api/live/deadbeef/state  # 404
```

### T1.4 Backend tests

**Goal:** pytest coverage for T1.1–T1.3.

**Files:** new `tests/interactive_stub/test_live_proxy.py`.

**Steps:** use `fastapi.testclient.TestClient` on the aim app + launch the stub in a
subprocess against a tmp repo (pytest `tmp_path`). Test: list shape; state/actions/events
pass-through incl. `v` field; 404 (no control param); 502 (stub killed). Mark the suite
`@pytest.mark.integration` if repo fixtures are slow.

**Verify:** `pytest tests/interactive_stub/ -x -q` → all pass.

---

## Phase 2 — UI milestone 1 (polling workspace)

### T2.1 Route, sidebar entry, page shell

**Files:**
- edit: `aim/web/ui/src/config/enums/routesEnum.ts` — add `Live = '/live'` to `PathEnum`.
- edit: `aim/web/ui/src/config/pageTitles/pageTitles.ts` — add
  `LIVE: 'Interactive Training',`.
- edit: `aim/web/ui/src/routes/routes.tsx` — add lazy import + entry (anchor: the
  `REPORTS` entry; copy its shape):

```ts
const Live = React.lazy(
  () => import(/* webpackChunkName: "live" */ 'pages/Live/LiveContainer'),
);
// in the routes object:
LIVE: {
  path: PathEnum.Live,
  component: Live,
  showInSidebar: true,
  displayName: 'Live',
  icon: 'runs',            // reuse existing icon font name; custom icon = later polish
  isExact: true,
  title: pageTitlesEnum.LIVE,
},
```

- new: `aim/web/ui/src/pages/Live/LiveContainer.tsx`, `Live.tsx`, `Live.scss` — shell
  that renders "Interactive Training" and an empty list.

**Verify:** `cd aim/web/ui && npx tsc --noEmit` passes;
`NODE_OPTIONS=--openssl-legacy-provider npm start` → sidebar shows "Live", `/live`
renders the shell.

### T2.2 API service

**Files:** new `aim/web/ui/src/services/api/liveControl/liveControlService.ts`
(pattern: copy `services/api/dashboard/dashboardService.ts`).

Functions (all through the shared `API` helper, base `live`):
`fetchSessions()`, `fetchState(runHash)`, `postAction(runHash, action)`,
`fetchEvents(runHash, since)`. Types in
`aim/web/ui/src/types/services/models/live/live.d.ts`: `ILiveSession`, `IControlState`,
`IKnobView`, `IActionSchema`, `IControlEvent` — field names exactly per design doc §3/§5.

**Verify:** `npx tsc --noEmit`.

### T2.3 Session list (mission-control state)

**Files:** `pages/Live/SessionList.tsx` (+ scss).

Poll `fetchSessions()` every 10 s. Card per session: experiment name, status `Badge`
(green running / amber paused / grey ended), round, step, goal direction + metric.
Click → select session (store in component state + URL query `?run=<hash>`; deep-link
`/live/:runHash` routing is M3 polish). Empty state: short "launch a training script
with the Aim frontend enabled" hint (design doc §6.2.1). One live session → auto-select.

**Verify:** with stub running, `/live` lists `stub_session`, card shows RUNNING and a
growing step count (10 s refresh).

### T2.4 Workspace shell: header + panel rail

**Files:** `pages/Live/Workspace/Workspace.tsx`, `Header.tsx`, `PanelRail.tsx` (+ scss).

- Poll `fetchState(runHash)` every 2 s (M1; WS replaces this in M2) into a
  `React.useReducer` store (design doc §6.7 — keep the store in
  `pages/Live/liveStore.ts` as plain functions + reducer so M2 can extend it).
- Header per design doc §6.3: status pill, round, step, goal, buttons Pause/Resume
  (swap on status), End round (confirm `Modal`, sends `stop`), Evaluate, Checkpoint
  (sends `save_checkpoint`), agent `Switcher` (sends `set_agent`), connection dot
  (green = last poll ok, red = last poll 502 → freeze widgets, banner "session ended").
- PanelRail per §6.3 mechanics: icons Info / Hyperparams / Ckpts / Model / Agent, one
  visible panel, click-active-to-collapse, localStorage persistence. Render Info panel
  (fact list from state) now; others as placeholders.

**Verify:** manual — open session; pause from the UI; `curl .../state` shows
`"status": "paused"`; resume; kill stub → red dot + disabled buttons.

### T2.5 Hyperparams panel + action lifecycle

**Files:** `pages/Live/Workspace/panels/HyperparamsPanel.tsx`,
`pages/Live/liveActionLifecycle.ts`.

- Render widgets from `state.knobs` per design doc §6.4 table (Input+Slider when
  min&max; Input otherwise; Switcher for bool; Input for str). Tooltip from
  `description`. **Label the panel "Hyperparameters"; never rename wire fields.**
- Lifecycle per §6.5 implemented in `liveActionLifecycle.ts`:
  dirty → (Apply) → POST → queued(id) → resolve on matching `action_result` in polled
  events (M1 polls `fetchEvents(runHash, lastSeq+1)` every 2 s) → applied (reconcile to
  event value) | failed (revert + error text). 10 s timeout → "slow" hint, keep waiting.
- Sticky footer: `Apply (N)` + `Discard`.
- "Other actions" section (§6.4 generic actions): every `state.actions[].type` not in
  the curated set `{set_knob, pause, resume, stop, evaluate, save_checkpoint,
  load_checkpoint, set_agent}` → button (+ popover form from `payload_keys`).

**Verify:** manual with stub — set lr to `-5` → applied value comes back `0.0`
(clamped, reconciled); set lr while stub paused → stays queued until resume;
`note` appears under Other actions, posting one shows `ok` in the poll log.

### T2.6 M1 build gate

**Verify (all must pass):**

```bash
cd aim/web/ui
npx tsc --noEmit
npx eslint src/pages/Live src/services/api/liveControl --ext .ts,.tsx
NODE_OPTIONS=--openssl-legacy-provider npm run build
cd ../../.. && pytest tests/interactive_stub -x -q
```

Then the manual E2E of T2.3–T2.5 against the stub through the *production* build
(`aim up`, not `npm start`).

---

## Phase 3 — milestone 2 (live plumbing)

### T3.1 WS bridge in the proxy

**Files:** edit `aim/web/api/live/views.py`; add `websockets` to `requirements.txt`.

`@live_router.websocket('/{run_hash}/events/ws')`: accept browser socket; resolve
control URL (404 close code 4404 if absent); connect upstream
`ws://<host:port>/events?since=<since>` via the `websockets` package; loop: receive
upstream text frame → `await browser_ws.send_text(frame)`; on either side closing,
close the other. No frame parsing.

**Verify:** `python -c` snippet with `websockets` client → connect to
`ws://127.0.0.1:43800/api/live/<hash>/events/ws?since=0`, assert ≥1 frame arrives
within 3 s and it JSON-parses with a `seq` key.

### T3.2 Store switches to WS

**Files:** `pages/Live/liveStore.ts`, `pages/Live/useLiveEvents.ts`.

Per design doc §6.7: track `lastSeq`; connect WS with `since=lastSeq+1`; dedupe by
`seq`; exponential backoff reconnect (1 s → 10 s cap); while WS closed, fall back to
2 s polling (reuse M1 path); resolve action lifecycle from WS events instead of polls.
Header dot: green open / amber reconnecting / red 502.

**Verify:** manual — kill stub for 5 s, restart on same port: dot amber → green, no
duplicate feed rows (seq dedupe), no lost `action_result` for an action posted during
the outage.

### T3.3 Live charts

**Files:** `pages/Live/Workspace/charts/LiveCharts.tsx`, `useMetricBuffers.ts`.

Per design doc §6.6: ring buffers (5 000 points) per (metric, branch) from WS `metrics`
events; history backfill via existing endpoint `POST /api/runs/{hash}/metric`
(`requested_traces`; see `runDetailAppModel.ts` usage) stitched across `run_hashes`;
dedupe seam by (step, branch). Charts: goal metric pinned, then `loss`,
`learning_rate`, "+" picker. Eval points as dots. Action markers: vertical rules at
steps of `knob_changed` / `checkpoint_*` / `module_reset` / `note` /
`evaluate_requested`; hover = summary. Reuse `components/LineChart/LineChart`; if its
props fight streaming updates, fall back to a thin SVG polyline component — do not
import a new chart library.

**Verify:** manual — loss chart draws within 2 s of opening; change lr → vertical
marker appears at that step; eval dots every ~25 steps; reload page → history still
there (backfill), tail continues.

### T3.4 Events drawer + console

**Files:** `pages/Live/Workspace/drawer/EventsFeed.tsx`, `Console.tsx`,
`BottomDrawer.tsx`.

Feed per §6.9: virtualized list (pattern: `pages/RunDetail/RunLogRecords`), source chip,
humanized text, ✓/✗ join with `action_result`, type filter chips, raw JSON via
`JsonViewPopover`. Console: one-line JSON input → `postAction`, ↑/↓ history in
localStorage, echo result. Drawer: resizable (pattern: RunDetail uses fixed tabs — a
simple CSS `resize: vertical` container is acceptable at this milestone).

**Verify:** manual — feed shows live rows; filter to `knob_changed` only; console
`{"type":"note","payload":{"text":"hi"}}` → ✓ row appears.

---

## Phase 4 — milestone 3 (parity + polish)

Each item independent; do in any order after Phase 3.

- **T4.1 Checkpoints panel** (§6.4): list + Save now + Load/Fork confirm modals
  (stub: extend `stub_trainer.py` to fake `save_checkpoint`/`load_checkpoint` +
  `checkpoint_saved`/`checkpoint_loaded` events first).
- **T4.2 Model panel + Layers drawer tab** (§6.4): tree from `model_tree` (stub: add a
  small fake tree), `reset_module` on nodes; any action with `module_name` in
  `payload_keys` appears on nodes.
- **T4.3 Agent panel** (§6.4, §3.8): status/toggle; config form + context editor
  **feature-detected** via `configure_agent`/`set_context` in `state.actions`
  (stub: implement both, incl. `api_key_set` redaction, so the form is testable);
  API key field never pre-filled; journal from `agent_plan`/`agent_reflection`.
- **T4.4 Pre-flight mode** (§7): `status=='paused' && step==0` → banner + promoted
  Hyperparams/Agent panels + Start button (`resume`); warn if agent attached and
  `api_key_set` false.
- **T4.5 Archive mode** (§6.8): on 502 freeze widgets; charts stay; "view in Run
  Detail" link.
- **T4.6 LIVE badges**: Runs table + RunDetail header badge when run params contain
  `control` and `/api/live/` reports it reachable.
- **T4.7 RunDetail Control tab**: mount the Workspace component read-only for archived
  runs, feeding the feed from the `agent_actions` Text sequence (existing runs text
  API).
- **T4.8 Key-redaction test** (design doc §9): stub `configure_agent` with a key →
  assert key absent from `/state`, all events, and server logs.

---

## Phase 5 — trainer-side extension (separate repo: interactive_training_v2)

Out of scope for the Aim fork agent; listed for coordination. Blockers for T4.3's real
(non-stub) use:

- `configure_agent` + `set_context` action handlers in `core/session.py`
  (redact `api_key` in results/events; update `LLMAgent` client/model between control
  points), extended `/state.agent` + `/state.context` fields (design doc §3.8).
- Persist `model_tree` as a run param (archive-mode Model panel, §6.7 gap).
- Optional: branch naming on fork; `agent_plan`/`agent_reflection` event emission.

---

## Troubleshooting quick table

| Symptom | Likely cause / fix |
|---|---|
| `npm start`/`build` OpenSSL error | prefix `NODE_OPTIONS=--openssl-legacy-provider` |
| `/api/live/` 404 | router not registered (T1.1 step 2) or server not restarted |
| `/api/live/` empty with stub running | stub run in a different repo than `aim up --repo`; TTL cache (wait 5 s) |
| proxy 502 with stub alive | stub bound a different port than the run param says — restart stub (it writes the param at startup) |
| UI dev server API 404 | check `aim/web/ui/src/setupProxy.js` target port matches `aim up` port |
| WS connects then instantly closes | `since` param not forwarded, or upstream URL used `http://` instead of `ws://` |
| duplicate feed rows after reconnect | seq dedupe missing (T3.2) |
| knob shows wrong value after Apply | reconcile step skipped — must set widget to `action_result`/`knob_changed` value (§6.5) |
