import asyncio
import json
import logging
import uuid
from pathlib import Path
from typing import Any, Dict, List, Tuple

from aim.sdk.agent.constants import COMMAND_TYPE_IDENTIFY
from aim.web.api.agent.pydantic_models import AgentCommandIn, AgentCommandOut
from aim.web.api.utils import APIRouter
from fastapi import Body, HTTPException, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

agent_router = APIRouter()

# Connected agents: run_hash -> WebSocket
_connected_agents: Dict[str, WebSocket] = {}
# Pending command futures: cmd_id -> asyncio.Future
_pending_commands: Dict[str, asyncio.Future] = {}


# Persistent storage for structured Codex responses
_STORE_DIR = Path("~/.aim/agent_saved").expanduser()
_PROBE_IDEAS_FILE = _STORE_DIR / "probe_ideas.json"
_DEV_DOCS_FILE = _STORE_DIR / "dev_docs.json"


def _ensure_store_dir() -> None:
    _STORE_DIR.mkdir(parents=True, exist_ok=True)


def _read_json_file(path: Path, default: Dict[str, Any]) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as fp:
            return json.load(fp)
    except FileNotFoundError:
        return {k: v if not isinstance(v, list) else list(v) for k, v in default.items()}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail=f"Corrupted store: {path}: {exc}") from exc


def _write_json_file(path: Path, payload: Dict[str, Any]) -> None:
    _ensure_store_dir()
    with path.open("w", encoding="utf-8") as fp:
        json.dump(payload, fp, indent=2, ensure_ascii=False)


def _selected_ordered_item(
    item: Dict[str, Any],
    *,
    selected_default: bool = False,
    id_key: str | None = None,
    id_value: str | None = None,
    require_id: bool = False,
) -> Dict[str, Any]:
    if not isinstance(item, dict):
        raise HTTPException(status_code=400, detail="Each entry must be an object")

    raw_selected = item.get("selected", selected_default)
    selected = raw_selected if isinstance(raw_selected, bool) else selected_default
    ordered: Dict[str, Any] = {"selected": selected}

    if id_key:
        if id_value is not None:
            ordered[id_key] = id_value
        else:
            if id_key not in item:
                if require_id:
                    raise HTTPException(status_code=400, detail=f"Missing required field '{id_key}'")
                ordered[id_key] = None
            else:
                ordered[id_key] = item[id_key]

    for key, value in item.items():
        if key in ("selected", id_key):
            continue
        ordered[key] = value

    return ordered


def _load_probe_store() -> Dict[str, Any]:
    return _read_json_file(_PROBE_IDEAS_FILE, {"PROBE_IDEA": []})


def _load_dev_doc_store() -> Dict[str, Any]:
    return _read_json_file(_DEV_DOCS_FILE, {"DEV_DOC": []})


def _save_probe_list(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    if len(items) != 10:
        raise HTTPException(status_code=400, detail="PROBE_IDEA payload must contain exactly 10 items")

    normalized = []
    for idx, item in enumerate(items):
        normalized.append(
            _selected_ordered_item(
                item,
                selected_default=False,
                id_key="id",
                id_value=f"probe_{idx}",
            )
        )

    payload = {"PROBE_IDEA": normalized}
    _write_json_file(_PROBE_IDEAS_FILE, payload)
    return payload


def _probe_order_key(probe: Dict[str, Any]) -> int:
    probe_id = str(probe.get("id", "probe_0"))
    try:
        _, suffix = probe_id.split("_", 1)
        return int(suffix)
    except (ValueError, IndexError):
        return 0


def _save_dev_doc_list(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    if len(items) != 3:
        raise HTTPException(status_code=400, detail="DEV_DOC payload must contain exactly 3 items")

    normalized = []
    for item in items:
        if "doc_id" not in item or not item["doc_id"]:
            raise HTTPException(status_code=400, detail="Each DEV_DOC item must include 'doc_id'")
        normalized.append(
            _selected_ordered_item(
                item,
                selected_default=False,
                id_key="doc_id",
                require_id=True,
            )
        )

    payload = {"DEV_DOC": normalized}
    _write_json_file(_DEV_DOCS_FILE, payload)
    return payload


def _apply_patch(
    items: List[Dict[str, Any]],
    identifier: str,
    *,
    id_key: str,
    patch: Dict[str, Any],
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    updated_items: List[Dict[str, Any]] = []
    updated_entry: Dict[str, Any] | None = None
    for entry in items:
        if entry.get(id_key) == identifier:
            updated = dict(entry)
            updated.update(patch)
            updated_entry = updated
            updated_items.append(updated)
        else:
            updated_items.append(entry)

    if updated_entry is None:
        raise HTTPException(status_code=404, detail=f"{id_key} '{identifier}' not found")

    return updated_items, updated_entry


@agent_router.websocket('/ws')
async def agent_websocket(websocket: WebSocket):
    """WebSocket endpoint for research agents to connect to.

    Protocol:
        1. Agent connects and sends an identify message:
           {"type": "identify", "run_hash": "<hash>"}
        2. Server sends commands; agent replies with ack / completed / failed.
    """
    await websocket.accept()
    run_hash: str | None = None

    try:
        # First message must be an identify handshake
        raw = await websocket.receive_text()
        data = json.loads(raw)

        if data.get("type") != COMMAND_TYPE_IDENTIFY or not data.get("run_hash"):
            await websocket.close(code=4001, reason="First message must be identify with run_hash")
            return

        run_hash = data["run_hash"]
        _connected_agents[run_hash] = websocket
        logger.info(f"Agent connected: run_hash={run_hash}")

        # Listen for agent responses
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            cmd_id = data.get("id")
            if cmd_id and cmd_id in _pending_commands:
                status = data.get("status")
                if status in ("completed", "failed"):
                    _pending_commands[cmd_id].set_result(data)

    except WebSocketDisconnect:
        logger.info(f"Agent disconnected: run_hash={run_hash}")
    except json.JSONDecodeError:
        logger.warning(f"Invalid JSON from agent: run_hash={run_hash}")
    finally:
        if run_hash:
            _connected_agents.pop(run_hash, None)


@agent_router.get('/', response_model=List[str])
async def list_connected_agents():
    """Return the run hashes of all currently connected agents."""
    return list(_connected_agents.keys())


@agent_router.post('/{run_hash}/instruct', response_model=AgentCommandOut)
async def send_agent_command(run_hash: str, command: AgentCommandIn):
    """Send a command to a connected agent and wait for its response."""
    ws = _connected_agents.get(run_hash)
    if not ws:
        raise HTTPException(status_code=404, detail=f"No agent connected with run_hash={run_hash}")

    cmd_id = str(uuid.uuid4())
    message = {
        "id": cmd_id,
        "type": command.type,
        "prompt": command.prompt,
        "timeout": command.timeout,
    }

    loop = asyncio.get_running_loop()
    future = loop.create_future()
    _pending_commands[cmd_id] = future

    try:
        await ws.send_text(json.dumps(message))
        result = await asyncio.wait_for(future, timeout=command.timeout)
        return result
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Agent command timed out")
    finally:
        _pending_commands.pop(cmd_id, None)


@agent_router.get('/saved/probe_ideas')
async def get_saved_probe_ideas():
    """Return saved probe ideas from the local store."""
    return _load_probe_store()


@agent_router.post('/saved/probe_ideas')
async def post_probe_ideas(payload: Dict[str, Any] = Body(...)):
    """Persist the full set of probe ideas."""
    probes = payload.get("PROBE_IDEA")
    if not isinstance(probes, list):
        raise HTTPException(status_code=400, detail="Body must include 'PROBE_IDEA' list")
    return _save_probe_list(probes)


@agent_router.patch('/saved/probe_ideas/{probe_id}')
async def patch_probe_idea(probe_id: str, payload: Dict[str, Any] = Body(...)):
    """Patch a single probe idea entry."""
    patch = payload.get("patch")
    if not isinstance(patch, dict):
        raise HTTPException(status_code=400, detail="Body must include 'patch' object")

    store = _load_probe_store()
    probes = store.get("PROBE_IDEA", [])
    updated_items, _ = _apply_patch(probes, probe_id, id_key="id", patch=patch)
    ordered = sorted(updated_items, key=_probe_order_key)
    return _save_probe_list(ordered)


@agent_router.get('/saved/dev_docs')
async def get_saved_dev_docs():
    """Return saved dev docs from the local store."""
    return _load_dev_doc_store()


@agent_router.post('/saved/dev_docs')
async def post_dev_docs(payload: Dict[str, Any] = Body(...)):
    """Persist the full set of dev docs."""
    docs = payload.get("DEV_DOC")
    if not isinstance(docs, list):
        raise HTTPException(status_code=400, detail="Body must include 'DEV_DOC' list")
    return _save_dev_doc_list(docs)


@agent_router.patch('/saved/dev_docs/{doc_id}')
async def patch_dev_doc(doc_id: str, payload: Dict[str, Any] = Body(...)):
    """Patch a single dev doc entry."""
    patch = payload.get("patch")
    if not isinstance(patch, dict):
        raise HTTPException(status_code=400, detail="Body must include 'patch' object")

    store = _load_dev_doc_store()
    docs = store.get("DEV_DOC", [])
    updated_items, _ = _apply_patch(docs, doc_id, id_key="doc_id", patch=patch)
    return _save_dev_doc_list(updated_items)
