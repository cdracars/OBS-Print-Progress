"""Base class for printer adapters that expose a Moonraker facade."""

import copy
import errno
import socket
import threading
import time
from urllib.parse import unquote

from . import facade
from .httputil import send_json, send_bytes, send_error_json


def deep_merge(target, delta):
    """Merge `delta` into `target` in place (dicts recursively, others replaced)."""
    for k, v in delta.items():
        if isinstance(v, dict) and isinstance(target.get(k), dict):
            deep_merge(target[k], v)
        else:
            target[k] = v
    return target


class Adapter:
    """Owns the connection to one printer and serves /p/<id>/... for it."""

    kind = 'base'

    def __init__(self, cfg):
        self.cfg = cfg
        self.id = cfg['id']
        self.ip = (cfg.get('ip') or '').strip()
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.state = facade.empty_state()
        self.thread = None
        self._gcode_cache = {}   # filename -> bytes (only the current file)

    # ---------------- lifecycle ----------------

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self._run_safe, name='adapter-%s' % self.id, daemon=True)
            self.thread.start()

    def stop(self):
        self.stop_event.set()

    def _run_safe(self):
        delay = 2
        while not self.stop_event.is_set():
            try:
                self.run()
                delay = 2
            except Exception as err:  # keep reconnecting forever
                self.set_offline(describe_error(err))
            if self.stop_event.wait(delay):
                return
            delay = min(30, delay * 2)

    def run(self):
        """Connect and pump updates until disconnected (subclasses)."""
        self.stop_event.wait()

    # ---------------- state ----------------

    def update(self, **fields):
        with self.lock:
            self.state.update(fields)

    def set_offline(self, message):
        with self.lock:
            self.state['online'] = False
            self.state['message'] = message

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.state)

    def summary(self):
        s = self.snapshot()
        return {
            'id': self.id, 'type': self.kind, 'online': s['online'], 'message': s['message'],
            'state': s['state'], 'filename': s['filename'], 'progress': s['progress'],
            'layer': s['layer'], 'total_layers': s['total_layers'],
            'nozzle': s['nozzle'], 'bed': s['bed'],
        }

    # ---------------- HTTP facade ----------------

    def handle(self, h, sub, query):
        n = self.snapshot()
        if sub in ('/printer/objects/query', '/printer/objects/subscribe'):
            return send_json(h, facade.query_response(n, query))
        if sub == '/printer/objects/list':
            return send_json(h, facade.list_response(n))
        if sub == '/printer/info':
            return send_json(h, {'result': {'state': 'ready' if n['online'] else 'error', 'state_message': n['message']}})
        if sub == '/server/info':
            return send_json(h, {'result': {'klippy_state': 'ready' if n['online'] else 'disconnected', 'bridge': self.kind}})
        if sub == '/server/files/metadata':
            fname = ''
            for part in query.split('&'):
                if part.startswith('filename='):
                    fname = unquote(part[9:])
            return send_json(h, facade.metadata_response(n, fname))
        if sub.startswith('/server/files/'):
            name = unquote(sub[len('/server/files/'):])
            if name.startswith('gcodes/'):
                name = name[len('gcodes/'):]
            return self.serve_gcode(h, name)
        if sub.startswith('/webcam'):
            return self.serve_camera(h)
        return send_error_json(h, 404, 'Not supported for %s printers: %s' % (self.kind, sub))

    def serve_gcode(self, h, name):
        try:
            data = self.get_gcode(name)
        except Exception as err:
            return send_error_json(h, 502, 'Could not fetch %s from the printer: %s' % (name, describe_error(err)))
        if data is None:
            return send_error_json(h, 404, 'File not found on printer: %s' % name)
        return send_bytes(h, data, 'text/plain; charset=utf-8')

    def get_gcode(self, name):
        if name in self._gcode_cache:
            return self._gcode_cache[name]
        data = self.fetch_gcode(name)
        if data is not None:
            self._gcode_cache = {name: data}
        return data

    def fetch_gcode(self, name):
        return None

    def serve_camera(self, h):
        return send_error_json(h, 404, 'No camera stream available for this printer')


def describe_error(err):
    """Friendly text for network errors; other messages pass through."""
    reason = getattr(err, 'reason', None)   # urllib.error.URLError wraps the socket error
    if isinstance(reason, BaseException):
        err = reason
    if isinstance(err, (socket.timeout, TimeoutError)):
        return 'Printer did not respond (timed out). Check the IP address.'
    if isinstance(err, ConnectionRefusedError):
        return 'Connection refused. Is the printer on and is LAN access enabled?'
    if isinstance(err, socket.gaierror):
        return 'Printer name not found on the network. Check the address.'
    if isinstance(err, OSError) and err.errno in (errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EHOSTDOWN):
        return 'Printer not reachable on the network. Check the IP address.'
    return str(err) or err.__class__.__name__


def wait_until(predicate, timeout, step=0.1):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(step)
    return predicate()
