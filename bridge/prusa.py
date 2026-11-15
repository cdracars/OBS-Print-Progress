"""Prusa printers with PrusaLink (MINI / MINI+, MK4, MK3.9, XL, CORE One).

- Status: polled over HTTP from /api/v1/status (PrusaLink API v1, Buddy
  firmware 5.1 and newer). /api/v1/job adds the file name.
- Auth: HTTP digest with user "maker" and the password shown on the printer
  (Settings > Network > PrusaLink). Firmware that still uses an API key gets
  the same secret in an X-Api-Key header.
- No layer numbers and no file position are reported, so the Live Toolpath
  overlay can't follow these printers; the status overlay works.
"""

import json
import urllib.error
import urllib.request

from .base import Adapter, CommandRejected

USER = 'maker'
POLL_SECONDS = 2

STATES = {
    'PRINTING': 'printing',
    'PAUSED': 'paused',
    'ATTENTION': 'paused',   # waiting for the user (filament runout, crash...)
    'FINISHED': 'complete',
    'STOPPED': 'cancelled',
    'ERROR': 'error',
}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def normalize_status(status, job=None):
    """PrusaLink /api/v1/status (+ optional /api/v1/job) -> normalized state."""
    printer = status.get('printer') or {}
    sjob = status.get('job') or {}
    raw_state = str(printer.get('state') or '').upper()
    state = STATES.get(raw_state, 'standby')
    has_job = bool(sjob) and state != 'standby'

    progress = (_num(sjob.get('progress')) or 0.0) / 100.0 if has_job else 0.0
    if state == 'complete':
        progress = 1.0
    file = (job or {}).get('file') or {}
    message = ''
    if raw_state == 'ATTENTION':
        message = 'Printer needs attention'
    elif raw_state == 'ERROR':
        message = ((printer.get('status_printer') or {}).get('message')) or 'Printer error'
    return {
        'online': True,
        'message': message,
        'state': state,
        'filename': (file.get('display_name') or file.get('name') or '') if has_job else '',
        'progress': max(0.0, min(1.0, progress)),
        'elapsed': _num(sjob.get('time_printing')) if has_job else None,
        'remaining': _num(sjob.get('time_remaining')) if has_job else None,
        'layer': None,
        'total_layers': None,
        'nozzle': _num(printer.get('temp_nozzle')), 'nozzle_target': _num(printer.get('target_nozzle')),
        'bed': _num(printer.get('temp_bed')), 'bed_target': _num(printer.get('target_bed')),
        'file_size': int(_num(file.get('size')) or 0) if has_job else 0,
    }


class PrusaLinkAdapter(Adapter):
    kind = 'prusalink'

    def __init__(self, cfg):
        super().__init__(cfg)
        self.password = str(cfg.get('accessCode') or '')
        host = self.ip.rstrip('/')
        self.base = host if host.startswith(('http://', 'https://')) else 'http://' + host
        mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        mgr.add_password(None, self.base, USER, self.password)
        self.opener = urllib.request.build_opener(urllib.request.HTTPDigestAuthHandler(mgr))
        self.job_id = None
        self.job = None

    def get_json(self, path, timeout=5):
        req = urllib.request.Request(self.base + path, headers={'Accept': 'application/json'})
        if self.password:
            req.add_header('X-Api-Key', self.password)
        try:
            with self.opener.open(req, timeout=timeout) as r:
                if r.status == 204:
                    return None
                return json.loads(r.read().decode('utf-8') or 'null')
        except urllib.error.HTTPError as err:
            if err.code == 401:
                raise ConnectionError('PrusaLink refused the password. Use the one under Settings > Network > PrusaLink on the printer.')
            if err.code == 404 and path.startswith('/api/v1/'):
                raise ConnectionError('This printer has no PrusaLink v1 API. Update the printer firmware (5.1 or newer).')
            raise ConnectionError('PrusaLink returned HTTP %d for %s' % (err.code, path))

    def run(self):
        if not self.password:
            raise ConnectionError('Enter the PrusaLink password from the printer (Settings > Network > PrusaLink).')
        while not self.stop_event.is_set():
            status = self.get_json('/api/v1/status') or {}
            sjob = status.get('job') or {}
            if sjob.get('id') != self.job_id:
                self.job_id = sjob.get('id')
                self.job = self.get_json('/api/v1/job') if self.job_id is not None else None
            self.update(**dict(normalize_status(status, self.job), _job_id=self.job_id))
            if self.stop_event.wait(POLL_SECONDS):
                return

    def refresh_for_command(self):
        status = self.get_json('/api/v1/status') or {}
        current = (status.get('job') or {}).get('id')
        self.job_id = current
        self.job = self.get_json('/api/v1/job') if current is not None else None
        self.update(**dict(normalize_status(status, self.job), _job_id=current))

    def perform_command(self, action):
        return self._send_command(action, self.job_id)

    def perform_checked_command(self, action, expected_token):
        with self.lock:
            self._track_job()
            if self._job_token != expected_token:
                raise CommandRejected('PrusaLink job changed before dispatch')
            job_id = self.state.get('_job_id')
        # Pin the URL to this job even if the background poll observes a new one.
        return self._send_command(action, job_id)

    def _send_command(self, action, job_id):
        if not isinstance(job_id, int):
            raise CommandRejected('PrusaLink has no current printer job ID')
        path = '/api/v1/job/%d' % job_id
        method = 'DELETE' if action == 'cancel' else 'PUT'
        if action != 'cancel':
            path += '/' + {'pause': 'pause', 'resume': 'resume'}[action]
        request = urllib.request.Request(self.base + path, method=method, headers={'X-Api-Key': self.password})
        try:
            with self.opener.open(request, timeout=5) as response:
                if response.status != 204:
                    raise CommandRejected('Unexpected PrusaLink command response')
        except urllib.error.HTTPError as err:
            err.close()
            raise CommandRejected('PrusaLink rejected the action (HTTP %d)' % err.code)
