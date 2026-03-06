# This is a sandbox agent for the Codex API with Aim interface

import asyncio
import json
import shutil

from pathlib import Path
from typing import Any, Sequence

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
    COMMAND_TYPE_RUN_REACT_LOOP,
    COMMAND_TYPE_STOP_REACT_LOOP,
    COMMAND_TYPE_UPDATE_CONTEXT_INFO,
)
from aim.sdk.agent.prompts import (
    APPLY_DEV_DOC,
    DEV_DOC_GENERATION,
    HYPOTHESIS_GENERATION,
    render_iterative_update,
    render_reflect_and_update,
)
from aim.sdk.agent.research_agent_logger import (
    AGENT_LOG_PROBER_PREFIX,
    AGENT_LOG_TEST_PREFIX,
    TYPE_FIGURE,
    TYPE_IMAGE,
    TYPE_METRIC,
)
from aim.sdk.objects.image import Image as AimImage
from aim.sdk.run import Run
from aim.web.configs import AIM_UI_DEFAULT_PORT


WEBSOCKET_ADDRESS = f'ws://localhost:{AIM_UI_DEFAULT_PORT}/api/agent/ws'


class AimResearchAgent:
    def __init__(
        self,
        run: Run,
        repo_path: str,
        loop_hook_command: Sequence[str] | None = None,
        will_recover_after_a_loop: bool = False,
    ):
        self.run = run
        self.repo_path = repo_path
        self.state = AGENT_STATE_INIT
        self._codex_session_id: str | None = None
        self._train_process: asyncio.subprocess.Process | None = None
        self._read_loop_task: asyncio.Task | None = None
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._pending_tasks: set[asyncio.Task] = set()
        self._all_hypotheses: list[str] = []
        self._all_dev_plans: list[str] = []
        self._context_info_path = None
        self._hypothesis_info_path = None
        self._react_loop_session_id: str | None = None
        self._prober_results_dir = Path(self.repo_path) / '.codex' / 'prober_results'
        self._cur_test_result_metrics: dict[str, list[dict]] = {}
        self._cur_prober_result_metrics: dict[str, list[dict]] = {}
        self._cur_test_result_images: list[dict] = []
        self._cur_prober_result_images: list[dict] = []
        self._loop_hook_command = list(loop_hook_command) if loop_hook_command else None
        self._will_recover_after_a_loop = will_recover_after_a_loop
        self._train_script_backup: str | None = None

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

    async def codex_exec(self, prompt: str, session_id: str = None) -> tuple[str, str | None]:
        """Execute a prompt via the Codex CLI asynchronously.

        Streams JSONL output and detects completion from the process exit
        rather than relying on a hard timeout.

        Returns:
            A tuple of (response_text, session_id). session_id is extracted
            from the JSONL stream and can be used to resume the conversation.
        """

        print(f'[codex_exec] {prompt}')

        if session_id:
            cmd = ['codex', 'exec', 'resume', session_id, '--json', prompt]
        else:
            cmd = ['codex', 'exec', '--json', prompt]
        # xh debug
        xh_debug = True
        if xh_debug:
            import os, subprocess
            print("[agent] cwd:", self.repo_path)
            print("[agent] uid/gid:", os.getuid(), os.getgid())
            print("[agent] HOME:", os.environ.get("HOME"))
            print("[agent] which codex:", shutil.which("codex"))
            try:
                out = subprocess.check_output(["bash","-lc","type -a codex; which codex; readlink -f $(which codex) || true; codex --version || true"], cwd=self.repo_path)
                print(out.decode())
            except Exception as e:
                print("[agent] codex inspect failed:", e)

            # also do a direct write test from the agent process
            try:
                Path(self.repo_path, ".__agent_write_test").write_text("ok", encoding="utf-8")
                Path(self.repo_path, ".__agent_write_test").unlink()
                print("[agent] write_test: OK")
            except Exception as e:
                print("[agent] write_test: FAIL", e)
        # end of xh debug
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=self.repo_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        response_text = ''
        extracted_session_id: str | None = session_id
        assert process.stdout
        while True:
            raw = await process.stdout.readline()
            if not raw:
                break
            line = raw.decode().strip()
            if not line:
                continue
            try:
                print(f'[codex_exec] {line}')
                data = json.loads(line)
                if data.get('type') == 'response.created' and not extracted_session_id:
                    extracted_session_id = data.get('response', {}).get('id')
                if not extracted_session_id:
                    extracted_session_id = data.get('session_id') or data.get('thread_id')
                if data.get('type') == 'item.completed':
                    item = data.get('item', {})
                    if item.get('type') == 'agent_message':
                        response_text = item.get('text', '')
            except json.JSONDecodeError:
                continue

        exit_code = await process.wait()
        if exit_code != 0:
            raise RuntimeError(f'codex exec failed (exit code {exit_code})')

        return response_text, extracted_session_id

    def _handle_training_log(self, data: str):
        try:
            payload: dict = json.loads(data)
            log_type = payload.get('type')
            name = payload.get('name', '')

            if log_type == TYPE_METRIC:
                value = payload.get('value')
                epoch = payload.get('epoch', None)
                step = payload.get('step', None)
                self.run.track(value, name=name, step=step, epoch=epoch)

                record = {'value': value, 'step': step, 'epoch': epoch}
                if name.startswith(AGENT_LOG_TEST_PREFIX):
                    self._cur_test_result_metrics.setdefault(name, []).append(record)
                elif name.startswith(AGENT_LOG_PROBER_PREFIX):
                    self._cur_prober_result_metrics.setdefault(name, []).append(record)

                print(f'[train] {name}: {value}')

            elif log_type in (TYPE_IMAGE, TYPE_FIGURE):
                raw_path = payload.get('path', '')
                step = payload.get('step', None)
                epoch = payload.get('epoch', None)
                abs_path = (
                    str(Path(self.repo_path) / raw_path) if raw_path and not Path(raw_path).is_absolute() else raw_path
                )
                try:
                    aim_img = AimImage(abs_path)
                    self.run.track(aim_img, name=name, step=step, epoch=epoch)
                except Exception as e:
                    print(f'[train] Failed to track image to Aim: {e}')
                record = {'name': name, 'path': abs_path}
                if name.startswith(AGENT_LOG_TEST_PREFIX):
                    self._cur_test_result_images.append(record)
                elif name.startswith(AGENT_LOG_PROBER_PREFIX):
                    self._cur_prober_result_images.append(record)
                print(f'[train] {log_type} {name}: {abs_path}')

            else:
                print(f'[train] {str(data)}')
        except json.JSONDecodeError:
            print(f'[train] {data}')
        except Exception as e:
            print(f'[train] Error tracking metric: {e}')

    def _snapshot_round_images(self, round_number: int):
        """Copy current round's images to round-specific paths so they are not
        overwritten by subsequent rounds.  Updates the image record lists
        in-place to point to the new snapshot paths."""
        dest_dir = self._prober_results_dir / f'round_{round_number}'
        dest_dir.mkdir(parents=True, exist_ok=True)

        for img_list in (self._cur_test_result_images, self._cur_prober_result_images):
            for record in img_list:
                src = Path(record['path'])
                if not src.is_file():
                    continue
                dest = dest_dir / f'{src.stem}_round_{round_number}{src.suffix}'
                shutil.copy2(src, dest)
                record['path'] = str(dest)

    def _save_round_prober_results(self, round_number: int) -> Path:
        """Save the current round's prober results to disk and append to history.

        Returns the path to the cumulative history file.
        """
        self._prober_results_dir.mkdir(parents=True, exist_ok=True)

        prober_metrics = self._serialize_metrics(self._cur_prober_result_metrics)
        prober_images = self._serialize_images(self._cur_prober_result_images)
        eval_metrics = self._serialize_metrics(self._cur_test_result_metrics)
        eval_images = self._serialize_images(self._cur_test_result_images)

        round_md = (
            f'# Round {round_number}\n\n'
            f'## Prober Metrics\n{prober_metrics}\n\n'
            f'## Prober Figures\n{prober_images}\n\n'
            f'## Evaluation Metrics\n{eval_metrics}\n\n'
            f'## Evaluation Figures\n{eval_images}\n'
        )

        round_path = self._prober_results_dir / f'round_{round_number}.md'
        round_path.write_text(round_md, encoding='utf-8')
        print(f'[react_loop] Saved round {round_number} prober results to {round_path}')

        history_path = self._prober_results_dir / 'history.md'
        with history_path.open('a', encoding='utf-8') as f:
            f.write(round_md + '\n---\n\n')

        return history_path

    def _reset_iteration_results(self):
        self._cur_test_result_metrics = {}
        self._cur_prober_result_metrics = {}
        self._cur_test_result_images = []
        self._cur_prober_result_images = []

    @staticmethod
    def _serialize_metrics(metrics: dict[str, list[dict]]) -> str:
        if not metrics:
            return 'No metrics recorded.'
        lines: list[str] = []
        for name, records in metrics.items():
            last = records[-1]
            parts = [f'**{name}**: {last["value"]}']
            if last.get('step') is not None:
                parts.append(f'step={last["step"]}')
            if last.get('epoch') is not None:
                parts.append(f'epoch={last["epoch"]}')
            lines.append(f'- {", ".join(parts)}')
            if len(records) > 1:
                values = [r['value'] for r in records if isinstance(r['value'], (int, float))]
                if values:
                    lines.append(f'  (history: {len(records)} records, min={min(values)}, max={max(values)})')
        return '\n'.join(lines)

    @staticmethod
    def _serialize_images(images: list[dict]) -> str:
        if not images:
            return 'No images/figures recorded.'
        lines: list[str] = []
        for img in images:
            lines.append(f'- **{img["name"]}**: `{img["path"]}`')
        return '\n'.join(lines)

    async def _run_training(self):
        """Run train.py, stream output through _read_loop, and wait for exit."""
        self._train_process = await asyncio.create_subprocess_exec(
            'python',
            'train.py',
            cwd=self.repo_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        self._read_loop_task = asyncio.create_task(self._read_loop())
        await self._train_process.wait()
        await self._read_loop_task

    def _build_eval_and_prober_strings(self) -> tuple[str, str]:
        eval_result = (
            '## Metrics\n'
            f'{self._serialize_metrics(self._cur_test_result_metrics)}\n\n'
            '## Figures\n'
            f'{self._serialize_images(self._cur_test_result_images)}'
        )
        prober_result = (
            '## Metrics\n'
            f'{self._serialize_metrics(self._cur_prober_result_metrics)}\n\n'
            '## Figures\n'
            f'{self._serialize_images(self._cur_prober_result_images)}'
        )
        return eval_result, prober_result

    def _train_script_path(self) -> Path:
        """Absolute path to the train.py script inside the training repo."""
        return Path(self.repo_path) / 'train.py'

    def _ensure_train_script_backup(self):
        if self._train_script_backup is not None:
            return
        try:
            self._train_script_backup = self._train_script_path().read_text(encoding='utf-8')
        except FileNotFoundError:
            self._train_script_backup = None
            print('[react_loop] Warning: train.py not found; cannot create recovery snapshot.')

    def _recover_train_script_if_requested(self):
        if not self._will_recover_after_a_loop:
            return
        if self._train_script_backup is None:
            self._ensure_train_script_backup()
            if self._train_script_backup is None:
                return
        try:
            self._train_script_path().write_text(self._train_script_backup, encoding='utf-8')
            print('[react_loop] train.py recovered from snapshot.')
        except OSError as exc:
            print(f'[react_loop] Failed to recover train.py: {exc}')

    async def _run_react_loop(self, num_iterations: int):
        self._react_loop_session_id = None
        history_path = self._prober_results_dir / 'history.md'
        history_path.parent.mkdir(parents=True, exist_ok=True)
        if history_path.exists():
            history_path.unlink()
        if self._will_recover_after_a_loop:
            self._ensure_train_script_backup()

        for i in range(num_iterations):
            print(f'[react_loop] Optimization round {i}')
            self._reset_iteration_results()
            self.state = AGENT_STATE_TRAINING

            await self._run_training()

            self.state = AGENT_STATE_REFLECTING

            self._snapshot_round_images(i)
            eval_result, prober_result = self._build_eval_and_prober_strings()
            self._save_round_prober_results(i)

            if i == 0:
                prompt = render_reflect_and_update(
                    prober_result=prober_result,
                    eval_result=eval_result,
                )
                _, session_id = await self.codex_exec(prompt)
                self._react_loop_session_id = session_id
                print(f'[react_loop] Captured codex session: {session_id}')
            else:
                prompt = render_iterative_update(
                    round_number=i,
                    prober_result=prober_result,
                    eval_result=eval_result,
                )
                _, session_id = await self.codex_exec(
                    prompt,
                    session_id=self._react_loop_session_id,
                )
                if session_id:
                    self._react_loop_session_id = session_id
            self._recover_train_script_if_requested()

        # Recovery/evaluation runs without Codex guidance XHP
        RECOVERY_RUNS = 3
        previous_recover_flag = self._will_recover_after_a_loop
        if not self._will_recover_after_a_loop:
            self._will_recover_after_a_loop = True
            self._ensure_train_script_backup()
        self._recover_train_script_if_requested()

        for extra_idx in range(RECOVERY_RUNS):
            round_idx = num_iterations + extra_idx
            print(f'[react_loop] Recovery training round {round_idx}')
            self._reset_iteration_results()
            self.state = AGENT_STATE_TRAINING
            await self._run_training()
            self.state = AGENT_STATE_REFLECTING
            self._snapshot_round_images(round_idx)
            eval_result, prober_result = self._build_eval_and_prober_strings()
            self._save_round_prober_results(round_idx)

        if not previous_recover_flag:
            self._will_recover_after_a_loop = previous_recover_flag

        self.state = AGENT_STATE_READY_TO_TRAIN

    @staticmethod
    def _format_probe_design_as_markdown(probe_design: Any) -> str:
        """Convert a probe design item (dict or string) into a readable markdown document."""
        if isinstance(probe_design, str):
            return probe_design

        if not isinstance(probe_design, dict):
            return str(probe_design)

        lines: list[str] = ['# Prober Design Idea', '']

        if 'probe_name' in probe_design:
            lines += [f'## {probe_design["probe_name"]}', '']

        if 'probe_type' in probe_design:
            lines += [f'**Probe Type:** {probe_design["probe_type"]}', '']

        if 'content' in probe_design:
            lines += ['## Design Details', '', probe_design['content'], '']

        known_keys = {'probe_type', 'probe_name', 'content', 'confidence'}
        extra = {k: v for k, v in probe_design.items() if k not in known_keys}
        if extra:
            lines += ['## Additional Information', '']
            for key, value in extra.items():
                lines += [f'**{key}:** {value}', '']

        return '\n'.join(lines)

    def _parse_hypothesis_info(self, codex_responses: str) -> list[str]:
        try:
            data = json.loads(codex_responses)
            ret = data.get('probe_designs', [])
            return ret
        except json.JSONDecodeError:
            return []

    def _parse_dev_plan_info(self, codex_responses: str) -> list[str]:
        try:
            data = json.loads(codex_responses)
            ret = data.get('dev_plans', [])
            return ret
        except json.JSONDecodeError:
            return []

    async def _read_loop(self):
        assert self._train_process and self._train_process.stdout
        print('Training monitor started')
        while True:
            raw = await self._train_process.stdout.readline()
            if not raw:
                break
            line = raw.decode().strip()
            if not line:
                continue
            self._handle_training_log(line)
        print('Training process ended')

    def _stop_react_loop(self):
        if self._train_process and self._train_process.returncode is None:
            self._train_process.terminate()
        if self._read_loop_task and not self._read_loop_task.done():
            self._read_loop_task.cancel()

    async def _handle_command(self, cmd_id: str, data: dict) -> Any:
        cmd_type = data.get('type', '')

        if cmd_type == COMMAND_TYPE_UPDATE_CONTEXT_INFO and self.state == AGENT_STATE_CONTEXT_COLLECTING:
            context_info = data.get('payload') or data.get('context_info') or data.get('content') or data.get('text')
            if not isinstance(context_info, str) or not context_info.strip():
                print('[update_context_info] No context information provided')
                context_info = 'No context information provided'
            context_path = Path(self.repo_path) / '.codex/context_info.md'
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

            hypothesis_path = Path(self.repo_path) / '.codex/prober_guide.md'
            self._write_text_file(hypothesis_path, hypothesis_info)

            codex_prompt = HYPOTHESIS_GENERATION
            raw_response, _ = await self.codex_exec(codex_prompt)
            self._all_hypotheses = self._parse_hypothesis_info(raw_response)

            self.state = AGENT_STATE_HYPOTHESIS_SELECTION
            return json.dumps(self._all_hypotheses)

        if cmd_type == COMMAND_TYPE_CODEX_HYPOTHESIS_SELECTION and self.state == AGENT_STATE_HYPOTHESIS_SELECTION:
            selection_info = data.get('payload') or data.get('selection_info')

            selected_hypothesis_index = int(selection_info) if selection_info else 0

            selected_hypothesis = self._all_hypotheses[selected_hypothesis_index]
            hypothesis_md = self._format_probe_design_as_markdown(selected_hypothesis)

            hypothesis_path = Path(self.repo_path) / '.codex/prober_design_idea.md'

            print(f'[codex_hypothesis_selection] saved prober design idea to {hypothesis_path}')

            self._write_text_file(hypothesis_path, hypothesis_md)
            self.state = AGENT_STATE_HYPOTHESIS_DEV_PLAN_GENERATION
            codex_prompt = DEV_DOC_GENERATION
            raw_response, _ = await self.codex_exec(codex_prompt)
            self._all_dev_plans = self._parse_dev_plan_info(raw_response)
            return json.dumps(self._all_dev_plans)

        if (
            cmd_type == COMMAND_TYPE_CODEX_DEV_PLAN_SELECTION
            and self.state == AGENT_STATE_HYPOTHESIS_DEV_PLAN_GENERATION
        ):
            selection_info = data.get('payload') or data.get('selection_info')
            selected_dev_plan_index = int(selection_info) if selection_info else 0
            selected_dev_plan = self._all_dev_plans[selected_dev_plan_index]
            dev_doc_path = Path(self.repo_path) / '.codex/development_plan.md'
            self._write_text_file(dev_doc_path, selected_dev_plan)

            codex_prompt = APPLY_DEV_DOC
            raw_response, _ = await self.codex_exec(codex_prompt)
            self.state = AGENT_STATE_READY_TO_TRAIN
            return raw_response

        if cmd_type == COMMAND_TYPE_RUN_REACT_LOOP and self.state == AGENT_STATE_READY_TO_TRAIN:
            raw = data.get('payload') or data.get('num_iterations') or 2
            num_iterations = int(raw)
            await self._run_react_loop(num_iterations)
            return f'React loop completed for {num_iterations} iterations'

        if cmd_type == COMMAND_TYPE_STOP_REACT_LOOP and (
            self.state == AGENT_STATE_TRAINING or self.state == AGENT_STATE_REFLECTING
        ):
            self._stop_react_loop()
            self.state = AGENT_STATE_READY_TO_TRAIN
            return 'React loop stopped'

        if cmd_type == COMMAND_TYPE_CODEX_EXEC:
            prompt = data.get('payload', '')
            if not prompt:
                raise ValueError("codex_exec command requires a non-empty 'payload' field")
            response_text, _ = await self.codex_exec(prompt)
            return response_text

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
