"""Bambu Lab printers (X1, P1, A1, P2S, H2D ...) over the local LAN API.

- Status: MQTT over TLS on port 8883, user "bblp", password = LAN access code,
  topic device/<serial>/report. P1/A1 send only changed fields, so reports
  are merged into one state.
- G-code (for the toolpath overlay and thumbnails): the print job's .3mf is
  downloaded over implicit FTPS (port 990) and the plate's G-code extracted.
- Camera: P1/A1 stream JPEG frames over TLS on port 6000; they are re-served
  as a normal MJPEG stream. X1/P2S/H2D use RTSPS on port 322 instead, which a
  browser can't play - add that to OBS as a Media Source.

Printer setup: enable "LAN Only" mode and note the access code. On newer
firmware also enable "Developer Mode" so third-party tools may connect.
"""

import base64
import ftplib
import io
import json
import re
import socket
import ssl
import struct
import threading
import time
import zipfile

from . import mqtt
from .base import Adapter, deep_merge
from .facade import estimate_elapsed
from .httputil import recv_exact, start_mjpeg, write_mjpeg_frame, send_error_json, CLIENT_GONE

# Bed sizes (mm) by MQTT/SSDP model code or name fragment.
BED_SIZES = [
    (('N1', 'A1 MINI', 'A1MINI'), (180, 180)),
    (('O1D', 'H2D'), (350, 320)),
    (('O1S', 'H2S'), (340, 320)),
]

STATE_MAP = {
    'RUNNING': 'printing', 'PREPARE': 'printing', 'SLICING': 'printing',
    'PAUSE': 'paused', 'FINISH': 'complete', 'FAILED': 'cancelled', 'IDLE': 'standby',
}


def tls_context():
    # Bambu printers use certificates signed by Bambu's own CA for their LAN
    # services, so the system trust store can't verify them. This is a LAN
    # connection authenticated by the access code.
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def bed_size_for(model):
    m = (model or '').upper()
    for keys, size in BED_SIZES:
        if any(k in m for k in keys):
            return size
    return (256, 256)


def normalize_report(p, model=''):
    """Bambu `print` report dict -> normalized state fields."""
    def num(key):
        v = p.get(key)
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    gstate = str(p.get('gcode_state') or 'IDLE').upper()
    state = STATE_MAP.get(gstate, 'standby')
    if gstate == 'FAILED' and p.get('print_error'):
        state = 'error'

    percent = num('mc_percent')
    progress = max(0.0, min(1.0, (percent or 0) / 100.0))
    remaining_min = num('mc_remaining_time')
    remaining = remaining_min * 60 if remaining_min is not None else None
    if state == 'complete':
        progress, remaining = 1.0, 0

    layer = p.get('layer_num')
    total = p.get('total_layer_num')

    return {
        'online': True,
        'message': '',
        'state': state,
        'filename': job_filename(p),
        'progress': progress,
        'remaining': remaining,
        'elapsed': estimate_elapsed(progress, remaining),
        'layer': int(layer) if isinstance(layer, (int, float)) and layer > 0 else None,
        'total_layers': int(total) if isinstance(total, (int, float)) and total > 0 else None,
        'nozzle': num('nozzle_temper'),
        'nozzle_target': num('nozzle_target_temper'),
        'bed': num('bed_temper'),
        'bed_target': num('bed_target_temper'),
        # Only X1/H2 have a real chamber sensor; others report a fixed 0/5.
        'chamber': num('chamber_temper') if (num('chamber_temper') or 0) > 5 else None,
        'bed_size': bed_size_for(model),
    }


def job_filename(p):
    """A stable, readable filename for the current job (what overlays show)."""
    name = (p.get('subtask_name') or '').strip()
    if not name:
        g = (p.get('gcode_file') or '').strip()
        name = g.rsplit('/', 1)[-1]
        for ext in ('.gcode.3mf', '.3mf', '.gcode'):
            if name.lower().endswith(ext):
                name = name[:-len(ext)]
                break
    return (name + '.gcode') if name else ''


# ============================================================
# FTPS (implicit TLS, port 990)
# ============================================================

class ImplicitFTPS(ftplib.FTP_TLS):
    """FTP_TLS that wraps the control socket immediately (implicit TLS) and
    reuses the TLS session on data connections (required by the printer)."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._sock = None

    @property
    def sock(self):
        return self._sock

    @sock.setter
    def sock(self, value):
        if value is not None and not isinstance(value, ssl.SSLSocket):
            value = self.context.wrap_socket(value, server_hostname=self.host)
        self._sock = value

    def ntransfercmd(self, cmd, rest=None):
        conn, size = ftplib.FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:
            conn = self.context.wrap_socket(conn, server_hostname=self.host, session=self.sock.session)
        return conn, size


def plate_from(p):
    for key in ('gcode_file', 'param', 'subtask_name'):
        m = re.search(r'plate_(\d+)', str(p.get(key) or ''))
        if m:
            return int(m.group(1))
    return None


def extract_plate_gcode(data, plate=None):
    """Return (gcode_bytes, thumbnail_png_or_None) from a Bambu .3mf."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = z.namelist()
        plates = sorted(int(m.group(1)) for n in names for m in [re.match(r'Metadata/plate_(\d+)\.gcode$', n)] if m)
        if not plates:
            return None, None
        idx = plate if plate in plates else plates[0]
        gcode = z.read('Metadata/plate_%d.gcode' % idx)
        thumb_name = 'Metadata/plate_%d.png' % idx
        thumb = z.read(thumb_name) if thumb_name in names else None
        return gcode, thumb


def with_thumbnail(gcode, png):
    """Prepend a slicer-style thumbnail block if the G-code has none, so the
    overlay's thumbnail preview works for Bambu jobs too."""
    if not png or b'; thumbnail begin' in gcode[:200000]:
        return gcode
    b64 = base64.b64encode(png).decode('ascii')
    lines = ['; thumbnail begin 512x512 %d' % len(b64)]
    lines += ['; ' + b64[i:i + 78] for i in range(0, len(b64), 78)]
    lines.append('; thumbnail end')
    return ('\n'.join(lines) + '\n').encode('ascii') + gcode


# ============================================================
# ADAPTER
# ============================================================

class BambuAdapter(Adapter):
    kind = 'bambu'
    MQTT_PORT, FTP_PORT, CAMERA_PORT = 8883, 990, 6000

    def __init__(self, cfg):
        super().__init__(cfg)
        self.serial = (cfg.get('serial') or '').strip().upper()
        self.code = (cfg.get('accessCode') or '').strip()
        self.model = cfg.get('model') or ''
        self.report = {}
        self.camera = CameraHub(self)

    def run(self):
        if not self.serial or not self.code:
            self.set_offline('Bambu printers need the serial number and LAN access code.')
            self.stop_event.wait()
            return
        raw = socket.create_connection((self.ip, self.MQTT_PORT), timeout=8)
        sock = tls_context().wrap_socket(raw, server_hostname=self.ip)
        try:
            self._session(sock)
        finally:
            try:
                sock.close()
            except OSError:
                pass

    def _session(self, sock):
        rx = lambda n: recv_exact(sock, n)
        sock.sendall(mqtt.connect_packet('obs-print-progress-%d' % int(time.time()), 'bblp', self.code, keepalive=60))
        ptype, _, body = mqtt.read_packet(rx)
        if ptype != mqtt.CONNACK or len(body) < 2:
            raise ConnectionError('Unexpected MQTT reply from printer')
        if body[1] != 0:
            raise ConnectionError('Printer refused the connection: %s' % mqtt.CONNACK_ERRORS.get(body[1], 'code %d' % body[1]))
        sock.sendall(mqtt.subscribe_packet(1, 'device/%s/report' % self.serial))
        sock.sendall(mqtt.publish_packet('device/%s/request' % self.serial, json.dumps(
            {'pushing': {'sequence_id': '0', 'command': 'pushall', 'version': 1, 'push_target': 1}})))
        self.update(online=True, message='Connected, waiting for status...')
        sock.settimeout(1.0)
        last_ping = time.time()
        got_report = False
        connected_at = time.time()
        while not self.stop_event.is_set():
            if time.time() - last_ping > 30:
                sock.sendall(mqtt.PINGREQ_PACKET)
                last_ping = time.time()
            if not got_report and time.time() - connected_at > 15:
                raise ConnectionError('Connected but no status received. Check the serial number.')
            try:
                ptype, flags, body = mqtt.read_packet(rx)
            except socket.timeout:
                continue
            if ptype == mqtt.PUBLISH:
                _, payload = mqtt.parse_publish(flags, body)
                try:
                    msg = json.loads(payload.decode('utf-8', 'replace'))
                except ValueError:
                    continue
                if isinstance(msg.get('print'), dict):
                    got_report = True
                    self.on_report(msg['print'])
        sock.sendall(mqtt.DISCONNECT_PACKET)

    def on_report(self, delta):
        with self.lock:
            deep_merge(self.report, delta)
            self.state.update(normalize_report(self.report, self.model))

    # ---------------- G-code via FTPS ----------------

    def fetch_gcode(self, name):
        with self.lock:
            report = dict(self.report)
        ftp = ImplicitFTPS(context=tls_context(), timeout=20)
        ftp.connect(self.ip, self.FTP_PORT)
        try:
            ftp.login('bblp', self.code)
            ftp.prot_p()
            path = self._find_job_file(ftp, report)
            if not path:
                return None
            buf = io.BytesIO()
            ftp.retrbinary('RETR ' + path, buf.write)
        finally:
            try:
                ftp.quit()
            except Exception:
                ftp.close()
        data = buf.getvalue()
        if path.lower().endswith('.3mf'):
            gcode, png = extract_plate_gcode(data, plate_from(report))
            return with_thumbnail(gcode, png) if gcode else None
        return data

    def _find_job_file(self, ftp, report):
        gfile = (report.get('gcode_file') or '').strip()
        subtask = (report.get('subtask_name') or '').strip()
        base = gfile.rsplit('/', 1)[-1]
        tries = []
        if gfile and not gfile.startswith('/data/Metadata'):
            tries += [gfile, '/' + base, '/cache/' + base]
        for d in ('/cache', '/', '/sdcard', '/model'):
            for n in (subtask + '.gcode.3mf', subtask + '.3mf'):
                if subtask:
                    tries.append(d.rstrip('/') + '/' + n)
        for path in tries:
            try:
                ftp.size(path)
                return path
            except ftplib.all_errors:
                continue
        # Last resort: newest-looking match in the usual folders.
        for d in ('/cache', '/'):
            try:
                names = ftp.nlst(d)
            except ftplib.all_errors:
                continue
            matches = [n for n in names if n.lower().endswith('.3mf') and (not subtask or subtask.lower() in n.lower())]
            if matches:
                m = matches[-1]
                return m if m.startswith('/') else d.rstrip('/') + '/' + m
        return None

    # ---------------- camera ----------------

    def serve_camera(self, h):
        if any(k in (self.model or '').upper() for k in ('X1', 'P2S', 'H2', 'BL-P00', 'C13', 'O1')):
            return send_error_json(h, 501, 'This model streams RTSPS (rtsps://bblp:<code>@%s:322/streaming/live/1). Add it in OBS as a Media Source.' % self.ip)
        self.camera.serve(h)


class CameraHub:
    """One printer connection shared by any number of MJPEG viewers."""

    def __init__(self, adapter):
        self.adapter = adapter
        self.cond = threading.Condition()
        self.frame = None
        self.seq = 0
        self.viewers = 0
        self.thread = None
        self.error = None

    def serve(self, h):
        with self.cond:
            self.viewers += 1
            if self.thread is None or not self.thread.is_alive():
                self.error = None
                self.thread = threading.Thread(target=self._run, daemon=True)
                self.thread.start()
        try:
            with self.cond:
                self.cond.wait_for(lambda: self.seq > 0 or self.error, timeout=10)
                if not self.seq:
                    return send_error_json(h, 502, 'Camera unavailable: %s' % (self.error or 'no frames'))
            start_mjpeg(h)
            seen = 0
            while True:
                with self.cond:
                    self.cond.wait_for(lambda: self.seq != seen, timeout=10)
                    if self.seq == seen:
                        return
                    seen, jpeg = self.seq, self.frame
                write_mjpeg_frame(h, jpeg)
        except CLIENT_GONE:
            pass
        finally:
            with self.cond:
                self.viewers -= 1

    def _run(self):
        a = self.adapter
        try:
            raw = socket.create_connection((a.ip, a.CAMERA_PORT), timeout=8)
            sock = tls_context().wrap_socket(raw, server_hostname=a.ip)
            auth = struct.pack('<IIII', 0x40, 0x3000, 0, 0) + b'bblp'.ljust(32, b'\0') + a.code.encode('ascii').ljust(32, b'\0')
            sock.sendall(auth)
            while not a.stop_event.is_set():
                with self.cond:
                    if self.viewers <= 0:
                        break
                header = recv_exact(sock, 16)
                size = struct.unpack('<I', header[:4])[0]
                if not 0 < size < 10_000_000:
                    raise ConnectionError('bad camera frame header')
                jpeg = recv_exact(sock, size)
                if jpeg[:2] == b'\xff\xd8' and jpeg[-2:] == b'\xff\xd9':
                    with self.cond:
                        self.frame, self.seq, self.error = jpeg, self.seq + 1, None
                        self.cond.notify_all()
            sock.close()
        except Exception as err:
            with self.cond:
                self.error = str(err) or err.__class__.__name__
                self.cond.notify_all()
