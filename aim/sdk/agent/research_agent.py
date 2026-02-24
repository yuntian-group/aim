# This is a sandbox agent for the Codex API with Aim interface

import asyncio
import json
import subprocess

from pathlib import Path
from typing import Any

import websockets

from aim.sdk.agent.constants import (
    AGENT_STATE_CONTEXT_COLLECTING,
    AGENT_STATE_HYPOTHESIS_DEV_PLAN_GENERATION,
    AGENT_STATE_HYPOTHESIS_GENERATING,
    AGENT_STATE_HYPOTHESIS_SELECTION,
    AGENT_STATE_IDLE,
    AGENT_STATE_INIT,
    AGENT_STATE_READY_TO_TRAIN,
    AGENT_STATE_REFLECTING,
    AGENT_STATE_TRAINING,
    COMMAND_TYPE_CODEX_DEV_PLAN_SELECTION,
    COMMAND_TYPE_CODEX_EXEC,
    COMMAND_TYPE_CODEX_HYPOTHESIS_GENERATION,
    COMMAND_TYPE_CODEX_HYPOTHESIS_SELECTION,
    COMMAND_TYPE_IDENTIFY,
    COMMAND_TYPE_METRICS,
    COMMAND_TYPE_RUN_REACT_LOOP,
    COMMAND_TYPE_STOP_REACT_LOOP,
    COMMAND_TYPE_UPDATE_CONTEXT_INFO,
)
from aim.sdk.run import Run
from aim.web.configs import AIM_UI_DEFAULT_PORT


WEBSOCKET_ADDRESS = f'ws://localhost:{AIM_UI_DEFAULT_PORT}/api/agent/ws'


def mock_codex_hypothesis_gen_call(prompt: str) -> str:
    pass


def mock_codex_dev_plan_gen_call(prompt: str) -> str:
    pass


def mock_codex_code_gen_call(prompt: str) -> str:
    pass


class AimResearchAgent:
    def __init__(self, run: Run, repo_path: str):
        self.run = run
        self.repo_path = repo_path
        self.state = AGENT_STATE_INIT
        self._codex_session_id: str | None = None
        self._train_process: asyncio.subprocess.Process | None = None
        self._read_loop_task: asyncio.Task | None = None
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._pending_tasks: set[asyncio.Task] = set()
        self._all_hypotheses: list[str] = []
        self._context_info_path = None
        self._hypothesis_info_path = None

    def _resolve_repo_file_path(self, input_path: str, default_path: str) -> Path:
        if not input_path:
            return Path(self.repo_path) / default_path
        path = Path(input_path)
        if path.is_absolute():
            return path
        return Path(self.repo_path) / path

    def _write_text_file(self, target_path: Path, content: str):
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(content, encoding='utf-8')

    def codex_exec(self, prompt: str, timeout: int = 120) -> str:
        """Execute a prompt via the Codex CLI, maintaining session across calls.

        On the first call, starts a new session and saves the thread_id.
        Subsequent calls resume the existing session for multi-turn conversation.
        """
        if self._codex_session_id:
            cmd = ['codex', 'exec', 'resume', self._codex_session_id, '--json', prompt]
        else:
            cmd = ['codex', 'exec', '--json', prompt]

        result = subprocess.run(
            cmd,
            cwd=self.repo_path,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        if result.returncode != 0:
            error = result.stderr.strip() or 'Unknown error'
            raise RuntimeError(f'codex exec failed ({result.returncode}): {error}')
        response_text = ''
        for line in result.stdout.strip().splitlines():
            if not line:
                continue
            try:
                print(f'[codex_exec] {line}')
                data = json.loads(line)
                if data.get('type') == 'thread.started' and self._codex_session_id is None:
                    self._codex_session_id = data['thread_id']
                elif data.get('type') == 'item.completed':
                    item = data.get('item', {})
                    if item.get('type') == 'agent_message':
                        response_text = item.get('text', '')
            except json.JSONDecodeError:
                continue

        return response_text

    def _handle_training_log(self, data: str):
        try:
            payload: dict = json.loads(data)

            if payload.get('type') == COMMAND_TYPE_METRICS:
                metrics: dict = json.loads(payload.get('metrics'))
                epoch = metrics.pop('epoch', None)
                step = metrics.pop('step', None)
                for name, value in metrics.items():
                    if isinstance(value, (int, float)):
                        self.run.track(value, name=name, step=step, epoch=epoch)
                        print(f'[train] {name}: {value}')
            else:
                print(f'[train] {str(data)}')
        except json.JSONDecodeError:
            print(f'[train] {data}')
        except Exception as e:
            print(f'[train] Error tracking metric: {e}')

    def _run_react_loop(self, num_iterations: int):
        # TODO: implement the react loop
        for i in range(num_iterations):
            print(f'[react_loop] Iteration {i}')
            self.state = AGENT_STATE_TRAINING
            # TODO: start training process and capture the output
            self.state = AGENT_STATE_REFLECTING
            # TODO: call codex with collected metrics and hypothesis to generate optimized code

    def _parse_hypothesis_info(self, codex_responses: str) -> list[str]:
        try:
            data = json.loads(codex_responses)
            ret = data.get('PROBE_IDEA', [])
            return ret
        except json.JSONDecodeError:
            return []

    async def _read_loop(self):
        assert self._train_process and self._train_process.stdout
        print('Training monitor started')
        async for raw in self._train_process.stdout:
            line = raw.decode().strip()
            if not line:
                continue
            try:
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(None, self._handle_training_log, line)
            except json.JSONDecodeError:
                print(f'[train] {line}')
        print('Training process ended')

    async def _handle_command(self, cmd_id: str, data: dict) -> Any:
        cmd_type = data.get('type', '')

        if cmd_type == COMMAND_TYPE_UPDATE_CONTEXT_INFO and self.state == AGENT_STATE_CONTEXT_COLLECTING:
            context_info = data.get('payload') or data.get('context_info') or data.get('content') or data.get('text')
            if not isinstance(context_info, str) or not context_info.strip():
                print('[update_context_info] No context information provided')
                context_info = 'No context information provided'
            context_path = self._resolve_repo_file_path(
                data.get('context_info_path', ''),
                '.codex/context_info.md',
            )
            self._write_text_file(context_path, context_info)
            self._context_info_path = str(context_path)
            self.state = AGENT_STATE_HYPOTHESIS_GENERATING
            return f'Context info updated at {self._context_info_path}'

        if cmd_type == COMMAND_TYPE_CODEX_HYPOTHESIS_GENERATION and self.state == AGENT_STATE_HYPOTHESIS_GENERATING:
            hypothesis_info = (
                data.get('payload') or data.get('hypothesis_info') or data.get('content') or data.get('text')
            )
            if not isinstance(hypothesis_info, str) or not hypothesis_info.strip():
                print('[codex_hypothesis_generation] No hypothesis information provided')
                hypothesis_info = 'No hypothesis information provided'

            context = ''
            if self._context_info_path:
                context_path = Path(self._context_info_path)
                if context_path.exists():
                    context = context_path.read_text(encoding='utf-8')

            codex_prompt = (
                f'Based on the following context:\n{context}\n\n'
                f'And the following guidance:\n{hypothesis_info}\n\n'
                'Generate a list of research hypotheses. '
                "Return ONLY a JSON object with a 'PROBE_IDEA' key "
                'containing an array of hypothesis strings.'
            )

            loop = asyncio.get_running_loop()
            raw_response = await loop.run_in_executor(None, self.codex_exec, codex_prompt, 120)
            self._all_hypotheses = self._parse_hypothesis_info(raw_response)

            self.state = AGENT_STATE_HYPOTHESIS_SELECTION
            return json.dumps(self._all_hypotheses)

        if cmd_type == COMMAND_TYPE_CODEX_HYPOTHESIS_SELECTION and self.state == AGENT_STATE_HYPOTHESIS_SELECTION:
            # TODO: select the best hypothesis from self._all_hypotheses
            self.state = AGENT_STATE_HYPOTHESIS_DEV_PLAN_GENERATION
            # TODO: call codex_exec to generate the dev plan
            return 'Hypothesis selected'

        if (
            cmd_type == COMMAND_TYPE_CODEX_DEV_PLAN_SELECTION
            and self.state == AGENT_STATE_HYPOTHESIS_DEV_PLAN_GENERATION
        ):
            # TODO: select the best dev plan from self._all_dev_plans
            self.state = AGENT_STATE_READY_TO_TRAIN
            # TODO: call codex_exec to generate the code
            return 'Dev plan selected'

        if cmd_type == COMMAND_TYPE_RUN_REACT_LOOP and self.state == AGENT_STATE_READY_TO_TRAIN:
            # TODO: get the number of iterations from the data
            num_iterations = data.get('num_iterations', 2)
            # START THE REACT LOOP
            pass
            return f'React loop requested for {num_iterations} iterations'

        if cmd_type == COMMAND_TYPE_STOP_REACT_LOOP and (
            self.state == AGENT_STATE_TRAINING or self.state == AGENT_STATE_REFLECTING
        ):
            # TODO: stop the training process
            self.state = AGENT_STATE_READY_TO_TRAIN
            return 'React loop stopped'

        if cmd_type == COMMAND_TYPE_CODEX_EXEC:
            prompt = data.get('payload', '')
            if not prompt:
                raise ValueError("codex_exec command requires a non-empty 'payload' field")
            timeout = data.get('timeout', 120)
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, self.codex_exec, prompt, timeout)

        raise ValueError(f'Unknown command type: {cmd_type!r}')

    async def _dispatch_command(self, data: dict):
        cmd_id: str = data.get('id', '')

        await self._send_ws({'id': cmd_id, 'ack': True, 'status': 'received'})

        task = asyncio.create_task(self._run_command(cmd_id, data))
        self._pending_tasks.add(task)
        task.add_done_callback(self._pending_tasks.discard)

    async def _run_command(self, cmd_id: str, data: dict):
        print(f'[run_command] {cmd_id}: {str(data)}')
        try:
            result = await self._handle_command(cmd_id, data)
            await self._send_ws(
                {
                    'id': cmd_id,
                    'status': 'completed',
                    'result': result,
                }
            )
        except Exception as e:
            await self._send_ws(
                {
                    'id': cmd_id,
                    'status': 'failed',
                    'error': str(e),
                }
            )

    async def _receive_instructions(self):
        print('Command receiver started')
        while True:
            try:
                async with websockets.connect(WEBSOCKET_ADDRESS) as ws:
                    self._ws = ws
                    print(f'[ws] Connected to {WEBSOCKET_ADDRESS}')
                    await ws.send(
                        json.dumps(
                            {
                                'type': COMMAND_TYPE_IDENTIFY,
                                'run_hash': self.run.hash,
                            }
                        )
                    )
                    self.state = AGENT_STATE_CONTEXT_COLLECTING
                    async for message in ws:
                        try:
                            data = json.loads(message)
                            await self._dispatch_command(data)
                        except json.JSONDecodeError:
                            print(f'[ws] Invalid JSON: {message}')
            except Exception as e:
                self._ws = None
                print(f'[ws] Connection error: {e}, reconnecting in 2s...')
                await asyncio.sleep(2)

    async def _send_ws(self, data: dict):
        if self._ws:
            await self._ws.send(json.dumps(data))

    async def start(self):
        """Start the agent and listen for instructions via websocket.

        Training is not launched automatically. Send a 'start_training'
        command through the websocket to begin the training process.
        """
        self.state = AGENT_STATE_IDLE
        print('[agent] Agent started, waiting for instructions...')
        await self._receive_instructions()
