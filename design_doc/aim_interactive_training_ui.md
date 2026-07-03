# Interactive Training UI for Aim — Design Document

Status: draft for implementation
Target: Aim fork v3.29.1 (`aim/web/api` + `aim/web/ui`)
Audience: an implementer working **only inside the Aim repository**. This document is
self-contained: every external API and schema the Aim code must interact with is fully
specified here. No access to the trainer's source code is required.

---

## Table of contents

1. [Overview and goals](#1-overview-and-goals)
2. [System architecture](#2-system-architecture)
3. [The Control Protocol (trainer-side HTTP/WS API)](#3-the-control-protocol)
   - 3.1 Transport and wire format
   - 3.2 `GET /state`
   - 3.3 `POST /actions`
   - 3.4 `GET /events` and `WS /events`
   - 3.5 Event catalog
   - 3.6 Built-in action catalog
   - 3.7 Protocol semantics (must-read)
   - 3.8 Agent configuration and API-key handling
4. [Discovery: how Aim finds live sessions](#4-discovery)
5. [Aim server: the Live proxy API](#5-aim-server-live-proxy-api)
6. [Aim UI: the Interactive Training page](#6-aim-ui-design)
7. [Startup workflow (how a user begins interactive training)](#7-startup-workflow)
8. [Implementation plan and milestones](#8-implementation-plan)
9. [Testing](#9-testing)
10. [Appendix A: feature parity with the legacy dashboard](#appendix-a)
11. [Appendix B: full JSON examples](#appendix-b)

> **Executable task breakdown:** see the companion file
> [`implementation_plan.md`](./implementation_plan.md) — an ordered, step-by-step
> playbook (exact files, skeletons, verification commands) for implementing this design.

---

## 1. Overview and goals

Interactive training lets a human (and optionally an LLM "babysitter" agent) steer a live
training run: tune hyperparameters ("knobs"), pause/resume, trigger evaluation, save/load/fork
checkpoints, reset modules, leave notes, and toggle the agent — all while training is in
progress.

The training process already exposes a small, self-describing HTTP+WebSocket control
endpoint (the **Control Protocol**, §3) and already logs its metrics/events into a local Aim
repository, stamping each Aim run with the control endpoint's URL. This document specifies
the Aim-side work:

- **A proxy API** inside the Aim web server that discovers live training sessions in the
  repo and forwards control traffic to them (§5).
- **A full-page "Interactive Training" workspace** in the Aim web UI, reachable from the
  left sidebar, that renders the control surface entirely from the protocol's
  self-describing schemas (§6).

Design principles:

1. **Schema-driven UI.** The trainer declares its knobs and actions with types, bounds and
   descriptions. The UI renders widgets from those declarations. New trainer capabilities
   appear in the UI with zero UI changes.
2. **Push, not poll, for live data.** Charts and feeds are fed from the WebSocket event
   stream, bypassing the Aim repo's indexing latency (Aim explorers only refresh on
   re-query; the live page must not depend on that).
3. **Additive fork changes.** Everything lands as new files plus a few registration lines.
   Stock Aim behavior is untouched when no live session exists.
4. **The trainer owns the process.** Aim attaches to running trainers; it never spawns them.

---

## 2. System architecture

```
             (browser, via one SSH tunnel to the aim server port)
                                   │
                        ┌──────────▼──────────┐
                        │      Aim Web UI     │  new: Interactive Training page
                        └──────────┬──────────┘
                                   │ same-origin /api/...
                        ┌──────────▼──────────┐
                        │    Aim Web Server   │  new: /api/live/* proxy router
                        │  (FastAPI, aim up)  │
                        └───────┬─────────┬───┘
              reads .aim repo   │         │ forwards HTTP/WS to control URL
                        ┌───────▼──┐   ┌──▼───────────────────────┐
                        │ .aim repo │   │ Trainer control endpoint │
                        │ (metrics, │   │ (FastAPI inside training │
                        │  params)  │   │  process, 127.0.0.1:rand)│
                        └───────────┘   └──────────────────────────┘
```

Key facts that motivate the proxy:

- The trainer's control endpoint binds `127.0.0.1` on a **random free port** on the compute
  node. It is *not* reachable through the user's single SSH tunnel and has **no CORS
  headers**. The Aim server runs on the same node, so it can reach `127.0.0.1:<port>`
  directly.
- The proxy therefore gives: one tunnel for everything, no CORS issues, a liveness check
  (ping failed ⇒ process gone), and the trainer endpoint stays private to the node.

Both the trainer process and the Aim server may serve multiple runs over time; the linkage
is per-Aim-run metadata (§4).

---

## 3. The Control Protocol

This is the API served by the training process. The Aim proxy is a byte-level pass-through
for these routes; the Aim UI consumes these payloads. Treat this section as the contract.

### 3.1 Transport and wire format

- Plain HTTP/1.1 + JSON, plus one WebSocket route. No authentication (endpoint is
  loopback-only; the Aim server is the trust boundary).
- Every Action/Event object on the wire carries a version field: `"v": 2`. The proxy must
  pass `v` through untouched. The UI should check `v === 2` and show an "unsupported
  protocol" banner otherwise (future-proofing).
- All timestamps are Unix epoch seconds as floats.

### 3.2 `GET /state` — full session snapshot

Returns everything needed to render the control surface. Poll this on page load and as a
fallback (see §6.7); it is cheap (in-memory snapshot).

Response body:

```jsonc
{
  "status": "running",            // "idle" | "running" | "paused" | "stopped" | "ended"
  "goal": {                        // may be null
    "name": "eval_loss",
    "metric": "eval_loss",         // metric key the goal reads
    "direction": "min",            // "min" | "max"
    "target": null                 // float or null; reaching it ends the experiment
  },
  "knobs": [                       // KnobView[] — the tunable hyperparameters
    {
      "name": "lr",
      "value": 1e-4,               // current value (any JSON type; usually number)
      "dtype": "float",            // python type name: "float" | "int" | "bool" | "str"
      "min": 0.0,                  // number or null
      "max": null,
      "step": null,                // suggested UI increment, or null
      "description": "base/peak learning rate. ..."   // human-readable, may be long
    }
  ],
  "actions": [                     // ActionSchema[] — everything POST /actions accepts
    {
      "type": "set_knob",
      "description": "Set a registered knob to a value",
      "payload_keys": ["name", "value"]
    }
  ],
  "agent": {
    "attached": true,              // an LLM babysitter is attached to the session
    "active": false,               // it is currently allowed to act (toggle via set_agent)
    // ---- extended agent config (absent on older trainers — feature-detect, §3.8) ----
    "model": "gpt-5.5",            // model slug, or null if none attached
    "provider": "openai",          // "openai" | "openrouter" | ...
    "base_url": null,              // custom endpoint, or null for provider default
    "reasoning_effort": "high",    // provider-specific, or null
    "every": 100,                  // agent acts every N training steps
    "api_key_set": true            // whether a usable API key is configured.
                                   // THE KEY ITSELF IS NEVER RETURNED (§3.8)
  },
  "context": "Task: fine-tune bert-base-uncased for binary IMDB sentiment ...",
                                   // free-text training context given to the agent in
                                   // every plan/act/reflect prompt (may be absent on
                                   // older trainers)

  // ---- TrainingState snapshot (merged into the same object) ----
  "step": 640,                     // latest training step seen
  "branch_id": "main",             // current branch ("main" or "main/<8 hex>")
  "branches": [                    // full branch tree
    {
      "id": "main",
      "parent": null,              // branch id or null
      "from_checkpoint": null,     // checkpoint id it was forked from, or null
      "created_at": 1751500000.0
    }
  ],
  "checkpoints": [                 // registry of saved checkpoints, oldest first
    {
      "id": "a3f9...32hex",
      "path": "/abs/path/to/checkpoint-600",
      "step": 600,
      "tag": "before-lr-drop",     // or null
      "branch_id": "main",
      "ts": 1751500123.4
    }
  ],
  "model_tree": {                  // nested module tree, or null if not bound
    "name": "bert",
    "module_type": "BertForSequenceClassification",
    "children": [ { "name": "bert.encoder", "module_type": "BertEncoder",
                    "children": [ /* recursive */ ] } ]
  }
}
```

Notes:

- `knobs` may be empty early in a round (they are re-registered at each round start).
- `actions` includes the built-ins (§3.6) **plus any recipe-specific actions** the training
  script registered (e.g. `freeze`, `mix_weights`). The UI must render unknown action types
  generically from `payload_keys`.
- `status` semantics: `paused` means the training loop is blocked at a control point;
  `stopped` means the current *round* is ending (not the whole experiment; see §3.7);
  `ended` means the session is over (endpoint may disappear at any moment after this).

### 3.3 `POST /actions` — submit a control action

Request body (an **Action**):

```jsonc
{
  "type": "set_knob",              // required — one of GET /state "actions"[].type
  "payload": {"name": "lr", "value": 3e-5},   // keys per ActionSchema.payload_keys
  "source": "human:web"           // optional but strongly recommended (see below)
  // "id", "ts", "v" are optional; the trainer generates them if absent
}
```

Response, immediately (HTTP 200):

```jsonc
{ "id": "6f2c...32hex" }           // the action id — correlate with action_result events
```

**Submission is asynchronous.** The action is queued and applied at the trainer's next
*control point* (once per training step, and continuously while paused). The authoritative
outcome arrives later as an `action_result` event carrying the same `id` (§3.5). The UI
must implement the queued → applied/failed lifecycle (§6.5).

`source` is a free-form string recorded on every event the action generates; it is how the
event feed distinguishes human actions from agent actions. The UI should always send
`"human:web"` (or `"human:web:<username>"` if a name is available).

### 3.4 `GET /events` and `WS /events` — the event stream

Every state change in the session is an **Event**:

```jsonc
{
  "v": 2,
  "seq": 1382,                     // monotonically increasing, 0-based, no gaps
  "type": "knob_changed",          // see catalog §3.5
  "payload": { "name": "lr", "value": 3e-5 },
  "ts": 1751500200.7,
  "branch_id": "main"              // branch the event belongs to
}
```

Two ways to consume:

- `GET /events?since=<seq>` → `{ "events": [Event, ...] }` — everything the trainer still
  has with `seq >= since`. The trainer keeps a ring buffer of the **last 10 000 events**;
  older events are gone from this endpoint (but persisted in the Aim repo, see §4).
- `WS /events?since=<seq>` — server first replays buffered events with `seq >= since`, then
  streams new events as JSON text frames (one Event per frame). No client→server messages
  are expected; the socket is one-directional.

Reconnect strategy: remember the highest `seq` seen; on reconnect, open
`WS /events?since=<last_seq + 1>`. Because `seq` has no gaps, any missed events are
replayed exactly once.

### 3.5 Event catalog

| `type` | `payload` | When |
|---|---|---|
| `status_changed` | `{"status": "running"\|"paused"\|"stopped"\|"ended"}` | session start/end, pause/resume/stop |
| `metrics` | `{"<metric>": <number>, ..., "step": int}` — plus `"eval": true` when it is an eval report | every logged training step / eval |
| `round_started` | `{"round": int}` | a multi-round experiment begins round N (0-based) |
| `round_finished` | `{"round": int, "score": float\|null}` | round N ended; score is the goal score |
| `knob_changed` | `{"name": str, "value": any}` | a set_knob was applied (value already clamped to min/max) |
| `action_result` | `{"id": str, "type": str, "ok": bool, "data": object, "error": str\|null}` | any action finished dispatching |
| `checkpoint_saved` | `{"id", "path", "step", "tag", "branch_id", "ts"}` (a Checkpoint, §3.2) | checkpoint written |
| `checkpoint_loaded` | `{"checkpoint_id": str, "path": str, "branch_id": str}` | load/fork applied; `branch_id` is the (possibly new) branch |
| `evaluate_requested` | `{"split": str}` or `{}` | evaluate action accepted (results arrive later as `metrics` with `eval: true`) |
| `module_reset` | `{"module_name": str}` | a module's parameters were re-initialized |
| `note` | `{"text": str}` | an annotation was recorded |
| `model_tree` | `{"tree": <model_tree object>}` | model was (re)bound, e.g. at round start |
| `agent_attached` | `{"name": str, "every": int\|null, "active": bool}` | an agent is attached (at session start); `every` = acts every N steps |
| `agent_enabled` | `{"enabled": bool}` | set_agent toggled the babysitter |
| `agent_configured` | `{"provider", "model", "base_url", "reasoning_effort", "every", "api_key_set": bool}` — **never the key itself** (§3.8) | configure_agent applied |
| `context_changed` | `{"context": str}` | set_context replaced the training context |
| `agent_plan` | reserved — text payload | agent's round plan (may not be emitted yet) |
| `agent_reflection` | reserved — text payload | agent's end-of-round reflection (may not be emitted yet) |

UI guidance: render unknown event types generically (type + JSON payload) so protocol
additions degrade gracefully.

Metric conventions worth knowing for chart labels: training metrics commonly include
`loss`, `grad_norm`, `learning_rate` (the *effective* per-step LR after any scheduler),
`epoch`; eval reports commonly include `eval_loss`, `eval_runtime`, etc., and always carry
`"eval": true`.

### 3.6 Built-in action catalog

Always present in `GET /state` `actions`; recipes may add more.

| `type` | `payload` | Effect / notes |
|---|---|---|
| `set_knob` | `{"name": str, "value": any}` | value is clamped to the knob's min/max; result carries the clamped value |
| `pause` | `{}` | training blocks at next control point; actions are still processed while paused |
| `resume` | `{}` | unblocks; also the "Start" button in the paused-start flow (§7) |
| `stop` | `{}` | ends the **current round only** — the experiment proceeds to the next round; it terminates on goal or max-rounds. Label the UI accordingly ("End round") |
| `evaluate` | `{"split": str}` (optional) | requests an eval pass; results arrive as `metrics` + `eval: true` |
| `save_checkpoint` | `{"tag": str}` (optional) | requests a checkpoint save at next opportunity → `checkpoint_saved` |
| `load_checkpoint` | `{"checkpoint_id": str, "fork": bool}` | restores weights/optimizer from the checkpoint; `fork: true` creates a new branch (id `parent/<8hex>`) instead of continuing the current one |
| `reset_module` | `{"module_name": str}` | re-initializes the named module (dotted path from `model_tree`) |
| `note` | `{"text": str}` | free-text annotation into the event stream |
| `set_agent` | `{"enabled": bool}` | turn the attached LLM babysitter on/off at runtime |

**Agent-configuration extension** (feature-detect by presence in `actions`; see §3.8):

| `type` | `payload` | Effect / notes |
|---|---|---|
| `configure_agent` | `{"provider": str, "model": str, "base_url": str\|null, "api_key": str\|null, "reasoning_effort": str\|null, "every": int\|null}` — all keys optional; only provided keys change | (re)configures the LLM babysitter at runtime, attaching one if none exists. `api_key` is write-only (§3.8). Result data mirrors the new config **without** the key; a redacted `agent_configured` event follows |
| `set_context` | `{"context": str}` | replaces the free-text training context handed to the agent in every plan/act/reflect prompt; echoed back in `/state.context` and a `context_changed` event |

### 3.7 Protocol semantics (must-read for UI correctness)

1. **Asynchronous application.** Actions apply at the next control point (~once per
   training step). Between POST and the `action_result` event the action is *in flight*.
   Expect sub-second latency normally, but unbounded if the loop is inside a long eval.
2. **Clamping.** `set_knob` values are clamped server-side; the `knob_changed` /
   `action_result` payload contains the value actually applied. Always reconcile the UI to
   the event value, not the submitted value.
3. **`stop` ends the round, not the experiment.** A multi-round session then starts the
   next round (fresh knobs, same endpoint, `round_started` event). The UI must survive
   knobs disappearing and reappearing across a round boundary.
4. **Rounds reset per-round state.** At `round_started`: knob registry is rebuilt (may be
   briefly empty), step resets, branch tree and checkpoint registry reset, status becomes
   `running`. Aim-side: **a new Aim run is created per round** (§4).
5. **Branches.** `load_checkpoint` with `fork: true` moves the session onto a new branch;
   subsequent events/metrics carry the new `branch_id`. Charts should render one series
   per branch (a branch is an alternative trajectory from the fork step).
6. **Effective vs base LR.** When an LR scheduler is active, the `lr` knob is the *base
   (peak)* value — setting it rescales the schedule — while the `learning_rate` metric is
   the *effective per-step* value. Show both; users will otherwise report the knob as
   "broken" (the knob's `description` explains this and should be surfaced as a tooltip).
7. **The endpoint dies with the process.** Any request may fail at any time. Treat
   connection failure as "session over" (see proxy 502 semantics, §5.3, and archive mode,
   §6.8).
8. **Concurrency.** The human UI and an LLM agent submit actions on equal footing; the
   event stream (with `source` on `action_result` via correlation, and distinct event
   types for agent lifecycle) is the shared record. The UI never assumes it is the only
   writer — state can change under it at any time, so it must be event-driven.

### 3.8 Agent configuration and API-key handling

The `configure_agent` / `set_context` actions and the extended `/state.agent` /
`/state.context` fields let the user choose the babysitter's **provider, model, API key,
reasoning effort, cadence** and the **training context** from the UI instead of trainer
launch flags. They are a protocol extension:

- **Feature detection.** The UI must key the configuration form off the presence of
  `configure_agent` in `/state.actions` (and the context editor off `set_context`).
  Trainers that predate the extension simply don't list them; the Agent panel then shows
  read-only info + the on/off toggle only. This follows the schema-driven principle —
  no version sniffing.
- **API-key rules (both sides of the wire):**
  1. The key travels **write-only**: it may appear in a `configure_agent` POST body and
     nowhere else. `/state` reports only `api_key_set: bool`.
  2. The trainer must redact the key from everything it emits: `action_result.data`,
     the `agent_configured` event, logs, and — critically — the `agent_actions` Text
     sequence persisted into the Aim repo (the repo is world-readable to anyone who can
     open the UI).
  3. The UI renders a password field that is never pre-filled; when `api_key_set` is
     true it shows "key configured ✓ — replace?". The UI must not cache the key in
     localStorage or query params.
  4. Precedence (trainer-side): a key sent via `configure_agent` overrides the
     environment variable for the current process; it is held in memory only and dies
     with the process.
- **Transit path:** browser → (SSH tunnel) → Aim server → loopback → trainer. The proxy
  is a pass-through and must not log request bodies for `/actions` routes.
- **Timing:** `configure_agent` applies at the next control point like any action. The
  new config takes effect from the agent's next `act()`/`plan()` call; an in-flight LLM
  request completes under the old config. `set_context` likewise affects only future
  prompts.

---

## 4. Discovery

How the Aim server finds live sessions inside a repo it is already serving:

- The trainer creates **one Aim run per round**, in the repo's default experiment or a
  named experiment (e.g. `hf_bert_imdb_frontend-20260703_002635`).
- Each such run has these **run params** (top-level keys in the run's params dict):
  - `control`: `{"url": "http://127.0.0.1:<port>"}` — the control endpoint. **Presence of
    this key marks a run as interactive.**
  - `round`: int — which round this run is.
  - `goal`: the Goal object (same shape as §3.2), if a goal is set.
  - `status`: last status string written by the trainer (best-effort; the proxy ping is
    the authoritative liveness signal).
- Metrics are tracked with context `{"round": int, "branch": str}` plus
  `{"subset": "eval"}` for eval metrics. `round_score` (one point per round, step=round)
  lands on the last run.
- Non-metric events are tracked as an Aim `Text` sequence named **`agent_actions`** with
  context `{"type": <event type>, "branch": <branch_id>}`, step = event `seq`, body = the
  JSON-serialized event payload including its `type`. This is the *persistent* event
  history — the UI's archive mode (§6.8) reads it after the process is gone.

Liveness definition used by the proxy: a run is **live** iff it has a `control.url` param
and `GET <control.url>/state` answers within a short timeout. A run that has
`control.url` but no answer is **dead** (crashed or finished); it still renders in archive
mode.

Note: multiple rounds of one session share the same `control.url`. The proxy should
de-duplicate by URL when listing *sessions* and attach the newest run hash.

---

## 5. Aim server: Live proxy API

New FastAPI router mounted at **`/api/live`** in `aim/web/api/__init__.py` (alongside
`/runs`, `/experiments`, ...). New package: `aim/web/api/live/` (`views.py`,
`pydantic_models.py`).

### 5.1 Routes

| Route | Method | Purpose |
|---|---|---|
| `/api/live/` | GET | list live (and recently-dead interactive) sessions |
| `/api/live/{run_hash}/state` | GET | proxy → `GET <control>/state` |
| `/api/live/{run_hash}/actions` | POST | proxy → `POST <control>/actions` (body passed through) |
| `/api/live/{run_hash}/events` | GET | proxy → `GET <control>/events?since=` |
| `/api/live/{run_hash}/events/ws` | WS | bridge → `WS <control>/events?since=` |

`{run_hash}` is the Aim run hash of *any* run of the session (typically the newest); the
proxy resolves it to the `control.url` param of that run.

### 5.2 `GET /api/live/` response

```jsonc
{
  "sessions": [
    {
      "run_hash": "d9e2c1a8...",        // newest run of this session
      "experiment": "hf_bert_imdb_frontend-20260703_002635",
      "round": 2,
      "status": "running",             // from live /state if reachable, else "ended"
      "reachable": true,
      "goal": { "name": "eval_loss", "metric": "eval_loss",
                 "direction": "min", "target": null },   // or null
      "step": 640,                      // from live /state; null if unreachable
      "run_hashes": ["<round0>", "<round1>", "<round2>"]  // all rounds, oldest first
    }
  ]
}
```

Implementation notes:

- Repo access: `from aim.web.api.projects.project import Project; repo = Project().repo`.
  Enumerate candidate runs via the structured DB (`repo.structured_db`) restricted to
  in-progress runs when possible (a run object's `end_time` is unset while open), falling
  back to a bounded scan of recent runs. For each candidate, read params with
  `repo.get_run(run_hash).get('control', ...)`.
- **Cache** the discovery result for ~5 seconds (module-level TTL cache); repo scans and
  pings must not run per keystroke.
- Ping = `GET <control>/state` with a 1–2 s timeout via `httpx.AsyncClient`. Reuse one
  client instance.
- De-duplicate sessions by `control.url`; group run hashes, order rounds by the `round`
  param.

### 5.3 Proxy semantics

- **Pass-through:** request and response bodies are forwarded verbatim (no schema
  validation in the proxy — the protocol is versioned end-to-end between trainer and UI).
  Do not forward the `Host` header; set reasonable timeouts (state/actions: 5 s).
- **Errors:**
  - `404` — run hash unknown, or run has no `control` param (body:
    `{"detail": "not an interactive run"}`).
  - `502` — control URL did not answer / connection refused (trainer gone). Body:
    `{"detail": "control endpoint unreachable"}`. The UI treats 502 as "session ended".
  - `504` — timeout mid-request.
- **WS bridge:** accept the browser socket, connect upstream with `websockets` (or
  `httpx-ws`), then pump frames upstream→downstream until either side closes; propagate
  closure. Pass the `since` query param through. No frame inspection.
- Dependencies: `httpx` and `websockets` — add to `requirements.txt` (aim already pulls in
  `aiohttp` transitively for other extras, but `httpx` is the cleaner choice here).

Security note: the proxy deliberately does **not** expose `control.url` values to the
browser, and forwards only to URLs read from the repo's own run params. Anyone who can
reach the Aim server can control training runs tracked in it — same trust model as the
rest of Aim (no auth). Document this in the fork's README.

---

## 6. Aim UI: the Interactive Training page

### 6.1 Placement and routing

- New sidebar entry **"Live"** (icon: a pulse/broadcast glyph), registered in
  `src/routes/routes.tsx` + `PathEnum` (`/live`) + `pageTitlesEnum`. `showInSidebar: true`.
- The page owns the full content area, like Metrics Explorer. The Aim sidebar is only the
  ~60 px icon rail — all layout below happens inside the page, so available space is the
  same as the legacy standalone dashboard had.
- Optional deep link: `/live/:runHash` selects a session directly. (A later milestone
  mounts the same panel as a RunDetail tab; the component must take `runHash` as a prop.)
- Runs whose params contain `control` get a green **LIVE** badge in the Runs table and
  RunDetail header (small, separate change; can ship later).

### 6.2 Page states

1. **No interactive sessions:** empty state with a short "how to launch" hint (a code
   snippet: run your training script with the Aim frontend enabled) — this is the answer
   to "how do I start" rendered in-product.
2. **One live session:** open its workspace directly.
3. **Multiple sessions:** card list first (mission control): experiment name, status
   pill, round, step, goal + best score, sparkline (from `round_score` / last metrics),
   Pause/Stop inline, click → workspace.

### 6.3 Workspace layout

Mirrors the legacy dashboard (icon rail + panel + charts + bottom drawer), rebuilt from
Aim kit components (`Card`, `Badge`, `Button`, `Slider`, `Switcher`, `SelectDropdown`,
`Input`, `Modal`, `Spinner`, `Icon`, `JsonViewPopover`) and Aim's d3 `LineChart`:

```
┌ header: session picker ▾ · ● RUNNING · round 2/5 · step 640 · goal eval_loss ↓ best 0.38
│         [❚❚ Pause] [■ End round] [⚑ Evaluate] [💾 Checkpoint]   agent ● ON ⇄   WS ●
├─────────┬──────────────────────────────────────────────────────────────────────────────
│ ⓘ Info  │
│ ⚙ Hyper │                live charts (small multiples)
│ 💾 Ckpts │                one series per branch; eval points as dots;
│ 🧠 Model │                vertical action markers, color-coded by source
│ 🤖 Agent │
├─────────┴──────────────────────────────────────────────────────────────────────────────
│ ▲ resizable bottom drawer:  [Events] [Console] [Layers]                                │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

Left rail = the legacy `SideControl` pattern: icons switch the ~24 rem panel. Panels
scale better than tabs as capabilities grow; adding a panel = one icon + one component.

**Panel mechanics (VS Code activity-bar model):**

- Two strips: icon rail (~56 px) + one panel body (~24 rem, resizable ~280–480 px).
  Exactly **one panel is visible at a time**; icons switch it. Clicking the active icon
  collapses the body (charts get full width). Active panel + collapsed state persist in
  localStorage. No accordion/stacking — each panel gets full column height.
- **Nothing critical lives only in a panel**: urgent controls (pause/resume, stop,
  evaluate, save-checkpoint, agent toggle, status) stay in the sticky header; the event
  feed stays in the bottom drawer. Panels hold the deep versions, the header the urgent
  ones — so switching panels never hides a safety control.
- **Icon badges** keep closed panels informative: Hyperparams = pending-action count (red on
  failure); Ckpts = dot for checkpoints saved since last opened; Agent = pulsing dot
  while active, static when attached-but-off; Info = warning glyph on
  `paused`/`stopped`/protocol mismatch.
- Inside a panel: single vertical scroll, sticky action bars where needed (Hyperparams: sticky
  "Apply (N) / Discard" footer; Ckpts: sticky "Save now + tag" header, newest-first list,
  collapsible branch tree at the bottom; Model: filter box + tree; Agent: toggle on top,
  plan/reflection feed below). Content too wide for the column (per-layer tables) goes to
  a bottom-drawer tab, not a wider panel.

### 6.4 Panels

**Info** — read-only session facts from `/state` + discovery: status, round, step,
branch, goal (+ live best score computed from received metrics), experiment/run hashes
(links to RunDetail per round), agent attached/active, protocol version.

**Hyperparams** (panel header: "Hyperparameters") — the core control panel.

> Naming note: the UI label is **Hyperparams**; on the wire these remain `knobs`
> (`/state.knobs`, `KnobView`, the `set_knob` action). Do **not** rename protocol
> fields — the schema is shared with the trainer and the LLM agent; this is a
> display-name mapping only.

Rendering rules, purely from `KnobView`:

| KnobView | Widget |
|---|---|
| `dtype: float`/`int` with `min` & `max` | `Input` + `Slider` (log-scale slider when `max/min > 1e3`) |
| `dtype: float`/`int` without bounds | `Input` (numeric) |
| `dtype: bool` | `Switcher` |
| `dtype: str` | `Input` (text) |

- `description` → info tooltip. `step` → input increment.
- Special-case `lr` when the description mentions a scheduler: show
  "base <knob value> / effective <latest `learning_rate` metric>" side by side (§3.7.6).
- Edits are local until **Apply** (one button for all dirty knobs → one `set_knob` action
  per changed knob). See lifecycle §6.5.

**Checkpoints** — list from `/state.checkpoints` + `checkpoint_saved` events (newest
first): tag, step, branch chip, relative time. Buttons: **Load** (`fork: false`, confirm
modal: "restores weights & optimizer; current progress on this branch continues from
step N") and **Fork** (`fork: true`, creates a new branch; explain that charts will show
a new series). Header button: **Save now** with optional tag field. Branch tree
mini-view (indented list from `/state.branches`, current branch highlighted).

**Model** — collapsible tree from `/state.model_tree` (name + module_type). Per-node
context action: **Reset module** (`reset_module`, confirm modal). If the recipe registered
layer-scoped actions (e.g. `freeze`), they appear here too: any action whose
`payload_keys` include `module_name` is offered on tree nodes. This rule generalizes the
legacy per-layer operations without hardcoding.

**Agent** — four stacked sections:

1. *Status & toggle:* attached/model/cadence from `/state.agent`; big on/off `Switcher`
   (`set_agent`); toggling off takes effect at the next control point.
2. *Configuration* (rendered only if `configure_agent` ∈ `/state.actions`, §3.8):
   provider `SelectDropdown` (openai / openrouter / custom), model slug `Input`,
   base URL `Input` (shown for "custom"), reasoning-effort `SelectDropdown`
   (low/medium/high), cadence `Input` (`every` N steps), and an **API key password
   field** — never pre-filled; when `api_key_set` is true it renders as
   "key configured ✓ — [Replace]". One **Apply** button submits a single
   `configure_agent` action with only the changed keys; §6.5 lifecycle applies.
   Warning banner when `attached: true` but `api_key_set: false` ("agent cannot act —
   no API key").
3. *Training context* (rendered only if `set_context` ∈ `/state.actions`): a textarea
   initialized from `/state.context` with Save (`set_context`) / Revert. This is the
   task description the agent sees in every plan/act/reflect prompt — edits steer future
   agent behavior. Show a "context updated" marker in the event feed via
   `context_changed`.
4. *Journal:* feed of `agent_plan` / `agent_reflection` texts when they arrive (reserved
   types — render as markdown-ish cards).

**Actions (generic):** any action type in `/state.actions` that is not covered by a
curated panel (the built-ins are) renders in an "Other actions" section at the bottom of
the Hyperparams panel: a button per action; if it has `payload_keys`, a popover form with one
free-form field per key. This is the extensibility escape hatch.

### 6.5 Action lifecycle (critical UX)

Because application is asynchronous (§3.7.1), every mutating widget follows one state
machine, implemented once in the store:

```
 idle → dirty (local edit) → queued (POSTed, have id) → applied (action_result ok:true)
                                        │                        └→ flash green, reconcile value
                                        └→ failed (ok:false / POST error / 10 s timeout)
                                                 └→ revert widget, inline error toast
```

- Correlate by action `id` (from the POST response) against `action_result.id`.
- While `queued`, the widget shows the pending value greyed/italic with a spinner chip;
  a counter "N pending" appears next to Apply.
- On `knob_changed`, reconcile to the event's (clamped) value even if it differs from what
  was submitted.
- Timeout: if no `action_result` after 10 s *and* the WS is healthy, keep waiting but mark
  "slow (training may be in eval)"; if the WS is down, resolve via `/state` re-poll.

### 6.6 Live charts

**Data source — hybrid (Aim storage for history, WS for the live tail):**

The trainer's event buffer is a ring of the last 10 000 events (§3.4), so the WS alone
cannot backfill charts when the page opens mid-run. Conversely, Aim's repo has the full
history (the trainer already tracks every metric into it, §4) but reads of an in-progress
run carry write-queue + indexing lag of seconds — the exact staleness this page must
avoid. Therefore:

1. **History (on chart mount):** fetch from Aim's existing run metric batch API
   (`POST /api/runs/{run_hash}/metric`, `requested_traces` by name + context). Stitch
   rounds using the session's `run_hashes` list from discovery (§5.2) — each round is a
   separate Aim run. Contexts to request: `{"round": N, "branch": ...}` and eval subsets
   (`{"subset": "eval"}`). No new backend work; this is the same endpoint RunDetail uses.
2. **Live tail:** append `metrics` events from the WS into a ring buffer per
   (metric, branch_id) — keep the last ~5 000 points per series. Dedupe at the seam with
   the fetched history by (`step`, `branch_id`).
3. Non-metric chart content (action markers, round boundaries, status) comes from WS
   events only — it has no real-time representation in Aim storage.

M1 simplification (optional): skip the merge logic and use WS `metrics` events purely as
a doorbell that triggers a refetch of the batch endpoint (one data path, seconds of extra
latency). Measure the actual track-to-readable lag with the stub trainer before adopting
this permanently. Do **not** poll Aim storage on a timer as the only source — that
reintroduces the indexing-lag dependency the page exists to avoid.

- Default charts: the goal metric (pinned first), then `loss`, `learning_rate`, and any
  metric the user pins from a "+" metric picker (all keys seen so far). Eval metrics
  (`eval: true`) draw as point markers on the same x-axis (step).
- One series per `branch_id`; older branches dimmed; fork points annotated.
- **Action markers:** vertical rules at the step of each `knob_changed`,
  `checkpoint_saved`, `checkpoint_loaded`, `module_reset`, `note`, `evaluate_requested`
  event; color by origin (human vs agent — derive from the correlated `action_result` /
  `source`); hover → event summary; click → scrolls the event feed to it. This is the
  primary tool for "did that intervention help?".
- On `round_started`: push the previous round's series into a dimmed background set (or
  clear, per a toggle), reset x-domain.
- Rendering: reuse `components/LineChart` (d3) like `RunMetricCard` does; ECharts is not
  needed.

### 6.7 Data layer (store)

One store per open session (Aim's codebase mixes MobX/custom stores; a small
self-contained store module like `RunLogRecordsStore` is the model to copy):

- `sessionList` — from `GET /api/live/`, polled every 10 s while the page is open.
- `state` — from proxied `/state`: fetched on session open, after WS (re)connect, and as
  a 5 s fallback poll **only while the WS is disconnected**.
- `events` — WS `/api/live/{hash}/events/ws?since=<lastSeq+1>`; store tracks `lastSeq`,
  auto-reconnects with exponential backoff (1 s → 10 s), replays are idempotent
  (dedupe by `seq`).
- `pendingActions` — map id → {type, payload, submittedAt, widgetKey} driving §6.5.
- `metricHistory` — one-shot fetch per (metric, run_hash) from the Aim batch endpoint
  (§6.6), merged with the WS ring buffers; refetched on `round_started` (new run hash
  appears via the 10 s session-list poll).
- Derived: metric ring buffers, checkpoint list, branch list, feed items — all reduced
  from events, with `/state` as the initial/reset snapshot.
- Connection health drives the header WS dot: green (open) / amber (reconnecting) /
  red (proxy returns 502 ⇒ flip to archive mode).

**Consistency model (WS vs. Aim storage).** Both paths are subscribers of one ordered
event log inside the trainer (monotonic `seq`, no gaps): the WS forwards it live, the
trainer's Aim writer persists it (metrics as series; control events into the
`agent_actions` Text sequence **with `step = seq`**). Consequences the implementation
relies on:

- Content can never disagree between the two paths — only recency (disk lags by a write
  queue, typically < 1 s). Merging is therefore pure deduplication, never reconciliation.
- Events unify *exactly*: backfill `agent_actions` from the repo, take the max `seq`
  seen, open `WS ...?since=<seq+1>`. Metrics unify by key
  (`step`, `branch_id`, metric, round) — identical keys are guaranteed identical values.
- **Do not add a proxy-side event store.** The repo is already the durable copy, written
  by the trainer itself (complete even if the Aim server restarts mid-run); a second
  store would be a real two-sources-of-truth risk for zero coverage gain. The WS ring
  buffer (10 000 events) is a reconnect window, not a store.
- Known persistence gap: `model_tree` is not written to the repo (it lives only in
  `/state` and the WS), so archive mode cannot render the Model panel until the trainer
  also stores the tree as a run param (trainer-side one-liner; tracked as a gap).

### 6.8 Ended sessions (archive mode)

When the proxy answers 502 (or `status_changed: ended` arrives): freeze all widgets
(disabled with "session ended" banner), keep charts/feed as-is, and offer "view full
history in Run Detail". The persistent record lives in the Aim repo: metrics as normal
Aim series, events in the `agent_actions` Text sequence (§4) — a later milestone renders
that sequence with the same feed component inside RunDetail.

### 6.9 Bottom drawer

- **Events** — virtualized list (copy the `RunLogRecords` pattern): time, source chip
  (`human` / agent name / `system`), humanized one-liner ("lr 1e-4 → 3e-5",
  "checkpoint @600 saved (tag: before-lr-drop)"), ✓/✗ from the matching `action_result`,
  raw JSON behind `JsonViewPopover`. Filter chips by event type; free-text filter.
- **Console** — power-user escape hatch: a one-line JSON input that POSTs a raw Action
  (`{"type": ..., "payload": {...}}`), with history (↑/↓) persisted in localStorage, and
  the response/result echoed inline. Ships in milestone 2 for parity with the legacy
  terminal.
- **Layers** — wide per-layer table version of the Model panel (name, type, actions),
  useful for large models; milestone 3.

---

## 7. Startup workflow

How a user begins an interactive session (documented here because the UI renders around
it):

1. User launches their training script on the compute node (the script embeds the control
   endpoint, writes to the Aim repo, and typically starts `aim up` itself).
2. User opens the Aim UI through their SSH tunnel and clicks **Live** — the session is
   already listed (discovery does not depend on Aim's runs-table indexing, so it appears
   within seconds of process start, even before the first metric).
3. **Paused-start (recommended trainer-side convention):** scripts may start with status
   `paused` at step 0. The workspace detects `status == "paused" && step == 0` and renders
   a **pre-flight view**: amber "waiting to start" banner, Hyperparams panel promoted to
   the center alongside the Agent configuration + training-context editor (§6.4) — so the
   user picks hyperparameters, **agent model, API key, and the task context** before any
   step runs — and one primary **Start training** button that simply sends `resume`. If
   an agent is attached without an API key, the Start button warns (but does not block:
   human-only training is valid). This gives configure-then-launch UX with zero launcher
   infrastructure.
4. Similarly, if a session pauses at a round boundary (trainer-side option), the Agent
   panel surfaces the proposed next-round config as a diff with **Accept** (= `resume`)
   / **Edit first**.

The UI must not assume these conventions exist — they are progressive enhancements keyed
purely off `status`/`step`/events.

---

## 8. Implementation plan

**M1 — proxy + read-only workspace** (backend first, UI can be tested against it)
- `aim/web/api/live/` router: list, state, actions, events (HTTP only), registration,
  TTL cache, httpx client. ~250 lines.
- UI: route + sidebar entry; session list; workspace shell (header, rail, Info panel);
  Hyperparams and generic Actions panels with the §6.5 lifecycle over *polling* (`/state` every
  2 s, `/events?since=` every 2 s). Functional control surface end-to-end.

**M2 — live plumbing**
- WS bridge in the proxy; store switches to WS with reconnect/replay; fallback polling.
- Live charts with action markers and branch series; Events drawer; Console.

**M3 — full parity + polish**
- Checkpoints, Model, Agent panels (incl. configuration form + context editor, §3.8 —
  requires the trainer-side `configure_agent`/`set_context` extension; feature-detected,
  so the panel degrades gracefully against older trainers); Layers drawer tab; pre-flight
  mode; archive mode; LIVE badges in Runs table / RunDetail; mount the workspace panel as
  a RunDetail tab reading `agent_actions` for archives.

Build/deploy reminders for the fork: python-side changes need only a server restart;
UI changes need `cd aim/web/ui && npm install && npm run build` (dev loop:
`npm start` against a running server). Add `httpx`, `websockets` to `requirements.txt`.

---

## 9. Testing

- **Protocol stub:** a ~100-line FastAPI script that fakes a trainer (serves §3 endpoints,
  emits synthetic metrics/events on a timer, honors pause/resume/set_knob). Lives in the
  fork's `tests/` and doubles as the UI dev harness — no GPU needed to develop the page.
- **Proxy unit tests:** against the stub — discovery (param present/absent), pass-through
  fidelity (incl. `v`), 404/502 mapping, WS bridge replay-then-stream, TTL cache.
- **Key-redaction tests:** submit `configure_agent` with an `api_key` against the stub;
  assert the key never appears in `/state`, any event, the `agent_actions` Text sequence,
  or proxy/server logs (grep the captured log output), while `api_key_set` flips to true.
- **UI:** component tests for the knob lifecycle state machine (queued → applied with
  clamped value; failure revert); a Cypress-style smoke: stub trainer + real server →
  page lists session, applies a knob, sees the marker on the chart.
- **Manual e2e:** real training script on the cluster; verify one-tunnel operation,
  round rollover (knobs disappear/reappear), fork → second chart series, kill the trainer
  → archive mode.

---

## Appendix A: feature parity with the legacy dashboard

Mapping from the legacy standalone React dashboard (interactive_training v1,
`frontend/interactive_optimizer`) to this design:

| Legacy | Here | Notes |
|---|---|---|
| ControlBar › Info | Info panel | — |
| ControlBar › Optimizer (sliders per param) | Hyperparams panel | generalized: any knob, not just optimizer params; requires recipes to register their params as knobs |
| ControlBar › Checkpoint (+ branch load popup) | Checkpoints panel | fork = named-branch load; branch *naming* is a trainer-side gap (ids are `parent/<hex>`) |
| ControlBar › Dataset (interactive params) | Hyperparams panel | dataset params should be registered as knobs by the recipe |
| ControlBar › Model (tree + layer ops) | Model panel + Layers drawer | layer ops = module-scoped actions (`reset_module` built-in; `freeze` etc. are recipe actions) |
| MetricsPanel (branch-aware ECharts) | Live charts | plus action markers; d3 LineChart instead of ECharts |
| Bottom log/terminal (command history) | Events + Console drawer tabs | console posts raw Actions |
| WebSocket middleware/store (Redux) | §6.7 store | seq-based replay improves on the legacy reconnect |
| LLM agent tuning | Agent panel | richer: runtime on/off, plans/reflections feed |

## Appendix B: full JSON examples

`POST /actions` request/response pairs:

```jsonc
// human drops the learning rate
→ POST /actions   {"type": "set_knob", "payload": {"name": "lr", "value": 3e-5}, "source": "human:web"}
← 200             {"id": "0f3a9c2e4b5d6a7f8091a2b3c4d5e6f7"}
// later, on the event stream:
{"v":2,"seq":1401,"type":"knob_changed","payload":{"name":"lr","value":3e-5},"ts":1751500201.2,"branch_id":"main"}
{"v":2,"seq":1402,"type":"action_result","payload":{"id":"0f3a9c2e4b5d6a7f8091a2b3c4d5e6f7","type":"set_knob","ok":true,"data":{"name":"lr","value":3e-5},"error":null},"ts":1751500201.2,"branch_id":"main"}
```

```jsonc
// fork from a checkpoint
→ POST /actions   {"type": "load_checkpoint", "payload": {"checkpoint_id": "a3f9...", "fork": true}, "source": "human:web"}
← 200             {"id": "77aa..."}
// events:
{"v":2,"seq":1520,"type":"checkpoint_loaded","payload":{"checkpoint_id":"a3f9...","path":"/.../checkpoint-600","branch_id":"main/1f2e3d4c"},"ts":...,"branch_id":"main/1f2e3d4c"}
{"v":2,"seq":1521,"type":"action_result","payload":{"id":"77aa...","type":"load_checkpoint","ok":true,"data":{"path":"/.../checkpoint-600","branch_id":"main/1f2e3d4c"},"error":null},"ts":...,"branch_id":"main/1f2e3d4c"}
```

```jsonc
// a failed action (unknown knob)
{"v":2,"seq":1600,"type":"action_result","payload":{"id":"beef...","type":"set_knob","ok":false,"data":{},"error":"unknown knob: warmup"},"ts":...,"branch_id":"main"}
```

```jsonc
// configure the babysitter from the UI (§3.8) — note the key goes in, never comes back
→ POST /actions   {"type": "configure_agent",
                   "payload": {"provider": "openrouter", "model": "gpt-5.5",
                                "api_key": "sk-or-...", "every": 50},
                   "source": "human:web"}
← 200             {"id": "c0ffee..."}
// events (key redacted everywhere):
{"v":2,"seq":1700,"type":"agent_configured","payload":{"provider":"openrouter","model":"gpt-5.5","base_url":null,"reasoning_effort":"high","every":50,"api_key_set":true},"ts":...,"branch_id":"main"}
{"v":2,"seq":1701,"type":"action_result","payload":{"id":"c0ffee...","type":"configure_agent","ok":true,"data":{"provider":"openrouter","model":"gpt-5.5","every":50,"api_key_set":true},"error":null},"ts":...,"branch_id":"main"}

// set the training context
→ POST /actions   {"type": "set_context", "payload": {"context": "Fine-tune BERT on IMDB; minimize eval_loss; budget 5 rounds..."}, "source": "human:web"}
← 200             {"id": "f00d..."}
{"v":2,"seq":1710,"type":"context_changed","payload":{"context":"Fine-tune BERT on IMDB; ..."},"ts":...,"branch_id":"main"}
```

Training + eval metrics events:

```jsonc
{"v":2,"seq":900,"type":"metrics","payload":{"loss":0.412,"grad_norm":7.3,"learning_rate":8.2e-5,"epoch":1.6,"step":640},"ts":...,"branch_id":"main"}
{"v":2,"seq":905,"type":"metrics","payload":{"eval_loss":0.389,"eval_runtime":2.84,"step":650,"eval":true},"ts":...,"branch_id":"main"}
```
