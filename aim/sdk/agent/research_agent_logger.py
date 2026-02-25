import json


AGENT_LOG_TEST_PREFIX = 'agent_log_test_'
AGENT_LOG_PROBER_PREFIX = 'agent_log_prober_'

TYPE_METRIC = 'metric'
TYPE_IMAGE = 'image'
TYPE_AUDIO = 'audio'
TYPE_FIGURE = 'figure'
TYPE_LOG = 'log'
TYPE_STATUS = 'status'
TYPE_DONE = 'done'


def _emit(data: dict):
    print(json.dumps(data), flush=True)


class ResearchAgentLogger:
    def log(self, name: str, value: float, step: int = None, epoch: int = None):
        _emit({'type': TYPE_METRIC, 'name': name, 'value': value, 'step': step, 'epoch': epoch})

    def track_image(self, name: str, path: str, step: int = None, epoch: int = None):
        _emit({'type': TYPE_IMAGE, 'name': name, 'path': path, 'step': step, 'epoch': epoch})

    def track_figure(self, name: str, path: str, step: int = None, epoch: int = None):
        _emit({'type': TYPE_FIGURE, 'name': name, 'path': path, 'step': step, 'epoch': epoch})
