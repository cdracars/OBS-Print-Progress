"""Elegoo Centauri Carbon (original CC1) over SDCP v3.

- Status: WebSocket on ws://<ip>:3030/websocket. Requests go to topic
  sdcp/request/<MainboardID>; the printer pushes sdcp/status/<MainboardID>.
  MainboardID comes from UDP discovery (send "M99999" to port 3000) or from
  any message the printer sends.
- Camera: MJPEG on http://<ip>:3031/video (enabled with Cmd 386).
- G-code: downloaded over HTTP (/downloadFile/...) for the toolpath overlay.

The Centauri Carbon 2 uses a different protocol (MQTT, port 1883) and is not
supported yet.
"""

import json
import socket
import threading
import time
import urllib.request
import uuid
from urllib.parse import quote

from .base import Adapter, deep_merge
from .httputil import CLIENT_GONE, send_error_json
from .websocket import WebSocket

CMD_STATUS, CMD_ATTRIBUTES, CMD_ENABLE_VIDEO, CMD_SUBSCRIBE = 0, 1, 386, 512

PAUSED, CANCELLED = (5, 6), (7, 8)


def discover_mainboard_id(ip, timeout=2.0, port=3000):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.sendto(b'M99999', (ip, port))
        data, _ = s.recvfrom(65536)
        return (json.loads(data.decode('utf-8', 'replace')).get('Data') or {}).get('MainboardID')
    except (OSError, ValueError):
        return None
    finally:
        s.close()


def _temp(v):
    """Temperatures are numbers on current firmware, [target, actual] on old."""
    if isinstance(v, (list, tuple)) and v:
        return float(v[-1]), float(v[0])
    try:
        return float(v), None
    except (TypeError, ValueError):
        return None, None


def _seconds(ticks, total):
    """Ticks are seconds on CC1 firmware 1.1.x but milliseconds in the SDCP
    spec; a "total" above ~55 hours of seconds is treated as milliseconds."""
    if ticks is None:
        return None
    return ticks / 1000.0 if (total or 0) > 200000 else float(ticks)


def normalize_status(st):
    info = st.get('PrintInfo') or {}
    code = info.get('Status')
    try:
        code = int(code)
    except (TypeError, ValueError):
        code = 0
    if code == 0:
        state = 'standby'
    elif code in PAUSED:
        state = 'paused'
    elif code in CANCELLED:
        state = 'cancelled'
    elif code == 9:
        state = 'complete'
    elif code == 14:
        state = 'error'
    else:
        state = 'printing'

    total_ticks = info.get('TotalTicks')
    elapsed = _seconds(info.get('CurrentTicks'), total_ticks)
    total = _seconds(total_ticks, total_ticks)
    remaining = max(0.0, total - elapsed) if (elapsed is not None and total) else None
    try:
        progress = max(0.0, min(1.0, float(info.get('Progress') or 0) / 100.0))
    except (TypeError, ValueError):
        progress = 0.0
    if state == 'complete':
        progress = 1.0

    nozzle, n_old_target = _temp(st.get('TempOfNozzle'))
    bed, b_old_target = _temp(st.get('TempOfHotbed'))
    box, _ = _temp(st.get('TempOfBox'))
    filename = (info.get('Filename') or '').rsplit('/', 1)[-1]

    def target(key, old):
        v = st.get(key)
        try:
            return float(v)
        except (TypeError, ValueError):
            return old

    layer, total_layers = info.get('CurrentLayer'), info.get('TotalLayer')
    return {
        'online': True,
        'message': '',
        'state': state,
        'filename': filename,
        'progress': progress,
        'elapsed': elapsed,
        'remaining': remaining,
        'layer': int(layer) if isinstance(layer, (int, float)) and layer > 0 else None,
        'total_layers': int(total_layers) if isinstance(total_layers, (int, float)) and total_layers > 0 else None,
        'nozzle': nozzle, 'nozzle_target': target('TempTargetNozzle', n_old_target),
        'bed': bed, 'bed_target': target('TempTargetHotbed', b_old_target),
        'chamber': box, 'chamber_target': target('TempTargetBox', None),
        'bed_size': (256, 256),
        '_path': info.get('Filename') or '',
    }


def extract_status(msg):
    """Status and mainboard id from a pushed SDCP message (either layout)."""
    data = msg.get('Data') if isinstance(msg.get('Data'), dict) else {}
    status = msg.get('Status') or data.get('Status')
    mbid = msg.get('MainboardID') or data.get('MainboardID')
    topic = msg.get('Topic') or ''
    if not mbid and topic.startswith('sdcp/') and topic.count('/') >= 2:
        mbid = topic.rsplit('/', 1)[-1]
    attrs = msg.get('Attributes') or data.get('Attributes')
    if isinstance(attrs, dict):
        mbid = mbid or attrs.get('MainboardID')
    return (status if isinstance(status, dict) else None), mbid


class ElegooAdapter(Adapter):
    kind = 'elegoo-cc'
    WS_PORT, VIDEO_PORT, HTTP_PORT, DISCOVERY_PORT = 3030, 3031, 80, 3000

    def __init__(self, cfg):
        super().__init__(cfg)
        self.mainboard = cfg.get('mainboardId') or None
        self.raw = {}
        self.ws = None
        self.send_lock = threading.Lock()

    def request(self, cmd, data=None):
        ws = self.ws
        if not ws:
            return
        mb = self.mainboard or ''
        msg = {
            'Id': '',
            'Data': {'Cmd': cmd, 'Data': data or {}, 'RequestID': uuid.uuid4().hex,
                     'MainboardID': mb, 'TimeStamp': int(time.time() * 1000), 'From': 1},
            'Topic': 'sdcp/request/%s' % mb,
        }
        with self.send_lock:
            ws.send(json.dumps(msg))

    def run(self):
        if not self.mainboard:
            self.mainboard = discover_mainboard_id(self.ip, port=self.DISCOVERY_PORT)
        ws = WebSocket(self.ip, self.WS_PORT, '/websocket')
        self.ws = ws
        try:
            self.update(online=True, message='Connected, waiting for status...')
            self.request(CMD_ATTRIBUTES)
            self.request(CMD_SUBSCRIBE)
            self.request(CMD_STATUS)
            ws.settimeout(1.0)
            last_poll = time.time()
            while not self.stop_event.is_set():
                if time.time() - last_poll > 5:
                    # Some firmware stops pushing; polling keeps it fresh.
                    self.request(CMD_STATUS)
                    last_poll = time.time()
                try:
                    text = ws.recv()
                except socket.timeout:
                    continue
                try:
                    msg = json.loads(text)
                except ValueError:
                    continue
                if isinstance(msg, dict):
                    self.on_message(msg)
        finally:
            self.ws = None
            ws.close()

    def on_message(self, msg):
        status, mbid = extract_status(msg)
        if mbid and not self.mainboard:
            self.mainboard = mbid
        if status:
            with self.lock:
                deep_merge(self.raw, status)
                self.state.update(normalize_status(self.raw))

    def fetch_gcode(self, name):
        path = self.snapshot().get('_path') or name
        tries = []
        if path.startswith('/'):
            tries.append('/downloadFile' + path)
        tries += ['/downloadFile/local/' + path.lstrip('/'), '/downloadFile/' + path.lstrip('/')]
        for t in tries:
            try:
                with urllib.request.urlopen('http://%s:%d%s' % (self.ip, self.HTTP_PORT, quote(t)), timeout=30) as r:
                    data = r.read()
                if data and not data.lstrip()[:15].lower().startswith(b'<!doctype'):
                    return data
            except Exception:
                continue
        return None

    def serve_camera(self, h):
        try:
            self.request(CMD_ENABLE_VIDEO, {'Enable': 1})
        except OSError:
            pass
        try:
            resp = urllib.request.urlopen('http://%s:%d/video' % (self.ip, self.VIDEO_PORT), timeout=10)
        except Exception as err:
            return send_error_json(h, 502, 'Camera unavailable: %s' % err)
        try:
            h.send_response(200)
            h.send_header('Content-Type', resp.headers.get('Content-Type', 'multipart/x-mixed-replace'))
            h.send_header('Cache-Control', 'no-store')
            h.send_header('Connection', 'close')
            h.end_headers()
            read = getattr(resp, 'read1', resp.read)
            while True:
                chunk = read(65536)
                if not chunk:
                    break
                h.wfile.write(chunk)
                h.wfile.flush()
        except CLIENT_GONE:
            pass
        finally:
            resp.close()
