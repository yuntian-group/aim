"""Stub trainer: implements the Control Protocol (design doc §3) + Aim discovery (§4).

Usage:
    python stub_trainer.py --repo /tmp/stub_repo
Then serve that repo:  aim up --repo /tmp/stub_repo --port 43800
"""
import argparse
import math
import random
import threading
import time
import uuid

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

    def publish(self, type, payload, branch='main'):
        with self.lock:
            ev = {
                'v': WIRE_VERSION,
                'seq': self.seq,
                'type': type,
                'payload': payload,
                'ts': time.time(),
                'branch_id': branch,
            }
            self.seq += 1
            self.buf.append(ev)
            subs = tuple(self.subs)
        for q in subs:
            q.put(ev)
        return ev

    def replay(self, since=0):
        with self.lock:
            return [e for e in self.buf if e['seq'] >= since]


class StubSession:
    def __init__(self):
        self.bus = Bus()
        self.status = 'running'
        self.step = 0
        self.knobs = {
            'lr': {
                'name': 'lr',
                'value': 1e-4,
                'dtype': 'float',
                'min': 0.0,
                'max': None,
                'step': None,
                'description': 'learning rate',
            },
            'weight_decay': {
                'name': 'weight_decay',
                'value': 0.01,
                'dtype': 'float',
                'min': 0.0,
                'max': 1.0,
                'step': None,
                'description': 'weight decay',
            },
        }
        self.actions = [
            {
                'type': 'set_knob',
                'description': 'Set a registered knob to a value',
                'payload_keys': ['name', 'value'],
            },
            {'type': 'pause', 'description': 'Pause training', 'payload_keys': []},
            {'type': 'resume', 'description': 'Resume training', 'payload_keys': []},
            {'type': 'evaluate', 'description': 'Run evaluation', 'payload_keys': ['split']},
            {'type': 'note', 'description': 'Record an annotation', 'payload_keys': ['text']},
            {
                'type': 'set_agent',
                'description': 'Enable/disable the agent',
                'payload_keys': ['enabled'],
            },
        ]
        self.agent = {'attached': True, 'active': False}
        self.pending = Queue()
        threading.Thread(target=self.loop, daemon=True).start()

    def state(self):
        return {
            'status': self.status,
            'goal': {'name': 'eval_loss', 'metric': 'eval_loss', 'direction': 'min', 'target': None},
            'knobs': list(self.knobs.values()),
            'actions': self.actions,
            'agent': self.agent,
            'step': self.step,
            'branch_id': 'main',
            'branches': [
                {'id': 'main', 'parent': None, 'from_checkpoint': None, 'created_at': time.time()}
            ],
            'checkpoints': [],
            'model_tree': None,
            'context': 'stub run',
        }

    def submit(self, action):
        action.setdefault('id', uuid.uuid4().hex)
        action.setdefault('payload', {})
        self.pending.put(action)
        return action['id']

    def apply(self, a):
        t, p, ok, data, err = a['type'], a['payload'], True, {}, None
        if t == 'set_knob' and p.get('name') in self.knobs:
            k = self.knobs[p['name']]
            v = float(p['value'])
            if k['min'] is not None:
                v = max(v, k['min'])
            if k['max'] is not None:
                v = min(v, k['max'])
            k['value'] = v
            data = {'name': p['name'], 'value': v}
            self.bus.publish('knob_changed', data)
        elif t == 'pause':
            self.status = 'paused'
            self.bus.publish('status_changed', {'status': 'paused'})
        elif t == 'resume':
            self.status = 'running'
            self.bus.publish('status_changed', {'status': 'running'})
        elif t == 'evaluate':
            self.bus.publish('evaluate_requested', dict(p))
        elif t == 'note':
            self.bus.publish('note', {'text': p.get('text', '')})
        elif t == 'set_agent':
            self.agent['active'] = bool(p.get('enabled', True))
            self.bus.publish('agent_enabled', {'enabled': self.agent['active']})
        else:
            ok, err = False, f'unknown action type: {t}'
        self.bus.publish('action_result', {'id': a['id'], 'type': t, 'ok': ok, 'data': data, 'error': err})

    def loop(self):
        while True:
            while not self.pending.empty():
                self.apply(self.pending.get())
            if self.status == 'running':
                self.step += 1
                lr = self.knobs['lr']['value']
                loss = 2.0 * math.exp(-self.step / 300) + random.random() * 0.05 + lr * 100
                self.bus.publish('metrics', {'loss': round(loss, 4), 'learning_rate': lr, 'step': self.step})
                if self.step % 25 == 0:
                    self.bus.publish('metrics', {'eval_loss': round(loss + 0.02, 4), 'step': self.step, 'eval': True})
            time.sleep(0.5)


def build_app(sess):
    app = FastAPI()

    @app.get('/state')
    def state():
        return sess.state()

    @app.post('/actions')
    def actions(body: dict):
        return {'id': sess.submit(body)}

    @app.get('/events')
    def events(since: int = 0):
        return {'events': sess.bus.replay(since)}

    @app.websocket('/events')
    async def ws(sock: WebSocket):
        import asyncio

        await sock.accept()
        q = Queue()
        for ev in sess.bus.replay(int(sock.query_params.get('since', 0))):
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
    ap.add_argument('--repo', required=True)
    ap.add_argument('--port', type=int, default=0)
    args = ap.parse_args()

    import socket

    if args.port == 0:
        s = socket.socket()
        s.bind(('127.0.0.1', 0))
        args.port = s.getsockname()[1]
        s.close()
    url = f'http://127.0.0.1:{args.port}'

    from aim import Repo, Run

    if not Repo.exists(args.repo):
        Repo.from_path(args.repo, init=True)
    run = Run(repo=args.repo, experiment='stub_session')
    run['control'] = {'url': url}
    run['round'] = 0
    run['goal'] = {'name': 'eval_loss', 'metric': 'eval_loss', 'direction': 'min', 'target': None}
    print(f'[stub] control endpoint: {url}   aim run: {run.hash}')

    sess = StubSession()
    uvicorn.run(build_app(sess), host='127.0.0.1', port=args.port, log_level='warning')


if __name__ == '__main__':
    main()
