import asyncio
import json
import logging
import uuid

from typing import Dict, List

from aim.sdk.agent.constants import COMMAND_TYPE_IDENTIFY
from aim.web.api.agent.pydantic_models import AgentCommandIn, AgentCommandOut
from aim.web.api.utils import APIRouter
from fastapi import HTTPException, WebSocket, WebSocketDisconnect


logger = logging.getLogger(__name__)

agent_router = APIRouter()

# Connected agents: run_hash -> WebSocket
_connected_agents: Dict[str, WebSocket] = {}
# Pending command futures: cmd_id -> asyncio.Future
_pending_commands: Dict[str, asyncio.Future] = {}


@agent_router.websocket('/ws')
async def agent_websocket(websocket: WebSocket):
    """WebSocket endpoint for research agents to connect to.

    Protocol:
        1. Agent connects and sends an identify message:
           {"type": "identify", "run_hash": "<hash>"}
        2. Server sends commands; agent replies with ack / completed / failed.
    """
    await websocket.accept()
    print('Agent accepted connection')
    run_hash: str | None = None

    try:
        # First message must be an identify handshake
        raw = await websocket.receive_text()
        data = json.loads(raw)

        if data.get('type') != COMMAND_TYPE_IDENTIFY or not data.get('run_hash'):
            await websocket.close(code=4001, reason='First message must be identify with run_hash')
            return

        run_hash = data['run_hash']
        _connected_agents[run_hash] = websocket
        print(f'Agent connected: run_hash={run_hash}')
        logger.info(f'Agent connected: run_hash={run_hash}')

        # Listen for agent responses
        while True:
            raw = await websocket.receive_text()
            data = json.loads(raw)
            cmd_id = data.get('id')
            if cmd_id and cmd_id in _pending_commands:
                status = data.get('status')
                if status in ('completed', 'failed'):
                    _pending_commands[cmd_id].set_result(data)

    except WebSocketDisconnect:
        print(f'Agent disconnected: run_hash={run_hash}')
        logger.info(f'Agent disconnected: run_hash={run_hash}')
    except json.JSONDecodeError:
        print(f'Invalid JSON from agent: run_hash={run_hash}')
        logger.warning(f'Invalid JSON from agent: run_hash={run_hash}')
    finally:
        if run_hash:
            print(f'Agent disconnected: run_hash={run_hash}')
            _connected_agents.pop(run_hash, None)
        for cmd_id, fut in list(_pending_commands.items()):
            if not fut.done():
                fut.set_result({'id': cmd_id, 'status': 'failed', 'error': 'Agent disconnected'})


@agent_router.get('/', response_model=List[str])
async def list_connected_agents():
    """Return the run hashes of all currently connected agents."""
    ret = list(_connected_agents.keys())
    print(f'List connected agents: {ret}')
    logger.info(f'List connected agents: {ret}')
    return ret


@agent_router.post('/{run_hash}/instruct', response_model=AgentCommandOut)
async def send_agent_command(run_hash: str, command: AgentCommandIn):
    """Send a command to a connected agent and wait for its response."""
    ws = _connected_agents.get(run_hash)
    if not ws:
        raise HTTPException(status_code=404, detail=f'No agent connected with run_hash={run_hash}')

    cmd_id = str(uuid.uuid4())
    message = {
        'id': cmd_id,
        'type': command.type,
        'payload': command.payload,
        'timeout': command.timeout,
    }

    loop = asyncio.get_running_loop()
    future = loop.create_future()
    _pending_commands[cmd_id] = future

    try:
        await ws.send_text(json.dumps(message))
        result = await asyncio.wait_for(future, timeout=command.timeout)
        return result
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail='Agent command timed out')
    finally:
        _pending_commands.pop(cmd_id, None)
