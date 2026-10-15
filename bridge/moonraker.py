"""Klipper / Moonraker printers (Voron, Snapmaker U1, Sovol, Creality K1 with
Moonraker, ...). Everything is proxied straight through, so the overlays see
the real Moonraker API but from the same origin - no CORS setup needed.
"""

import json
import socket
import threading
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urljoin

from .base import Adapter, describe_error
from .httputil import send_error_json, CLIENT_GONE

HOP_HEADERS = {'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer'}


class MoonrakerAdapter(Adapter):
    kind = 'klipper'
    default_ports = (None, 7125)   # try port 80 (nginx) first, then Moonraker's own

    def __init__(self, cfg):
        super().__init__(cfg)
        self.base = None

    # ---------------- connection ----------------

    def candidates(self):
        host = self.ip.rstrip('/')
        if host.startswith('http://') or host.startswith('https://'):
            return [host]
        if ':' in host.split('/')[0]:
            return ['http://' + host]
        return ['http://%s:%d' % (host, p) if p else 'http://' + host for p in self.default_ports]

    def resolve_base(self):
        last = None
        for base in self.candidates():
            try:
                with urllib.request.urlopen(base + '/server/info', timeout=4) as r:
                    info = json.loads(r.read().decode('utf-8'))
                if 'result' in info:
                    self.base = base
                    return base
            except Exception as err:
                last = err
        raise ConnectionError(describe_error(last) if last else 'Moonraker not found')

    def run(self):
        base = self.base or self.resolve_base()
        while not self.stop_event.is_set():
            try:
                url = base + '/printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed'
                with urllib.request.urlopen(url, timeout=5) as r:
                    st = json.loads(r.read().decode('utf-8'))['result']['status']
            except urllib.error.HTTPError as err:
                if err.code in (401, 403):
                    raise ConnectionError('Moonraker refused access (HTTP %d). Add this computer to trusted_clients in moonraker.conf.' % err.code)
                raise ConnectionError('Klipper not ready (HTTP %d)' % err.code)
            except Exception:
                self.base = None
                raise
            ps = st.get('print_stats', {})
            self.update(
                online=True, message='', state=ps.get('state') or 'standby', filename=ps.get('filename') or '',
                progress=st.get('virtual_sdcard', {}).get('progress') or 0,
                layer=(ps.get('info') or {}).get('current_layer'), total_layers=(ps.get('info') or {}).get('total_layer'),
                nozzle=st.get('extruder', {}).get('temperature'), bed=st.get('heater_bed', {}).get('temperature'),
            )
            if self.stop_event.wait(3):
                return

    # ---------------- proxy ----------------

    def handle(self, h, sub, query):
        if sub.startswith('/webcam'):
            return self.serve_camera(h)
        base = self.base
        if not base:
            try:
                base = self.resolve_base()
            except Exception as err:
                return send_error_json(h, 502, describe_error(err))
        if h.headers.get('Upgrade', '').lower() == 'websocket':
            return self.pipe_websocket(h, base, sub, query)
        url = base + sub + ('?' + query if query else '')
        self.proxy(h, url)

    def proxy(self, h, url):
        body = None
        if h.command in ('POST', 'PUT'):
            length = int(h.headers.get('Content-Length') or 0)
            body = h.rfile.read(length) if length else b''
        headers = {}
        for name in ('Range', 'Content-Type', 'Accept'):
            if h.headers.get(name):
                headers[name] = h.headers[name]
        req = urllib.request.Request(url, data=body, headers=headers, method=h.command)
        try:
            resp = urllib.request.urlopen(req, timeout=15)
        except urllib.error.HTTPError as err:
            resp = err
        except Exception as err:
            self.base = None
            return send_error_json(h, 502, describe_error(err))
        try:
            h.send_response(resp.status if hasattr(resp, 'status') else resp.code)
            for k, v in resp.headers.items():
                if k.lower() not in HOP_HEADERS and not k.lower().startswith('access-control'):
                    h.send_header(k, v)
            h.send_header('Connection', 'close')
            h.end_headers()
            if h.command == 'HEAD':
                return
            # read1 returns whatever has arrived, so MJPEG frames aren't held back
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

    def pipe_websocket(self, h, base, sub, query):
        """Forward a websocket upgrade to Moonraker and relay raw bytes both ways."""
        parts = urlsplit(base)
        host, port = parts.hostname, parts.port or 80
        try:
            up = socket.create_connection((host, port), timeout=5)
        except Exception as err:
            return send_error_json(h, 502, describe_error(err))
        lines = ['GET %s%s HTTP/1.1' % (sub, '?' + query if query else ''), 'Host: %s:%d' % (host, port)]
        for k, v in h.headers.items():
            # Dropping Origin means Moonraker treats us like any non-browser client.
            if k.lower() not in ('host', 'origin'):
                lines.append('%s: %s' % (k, v))
        up.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode('latin-1'))
        up.settimeout(None)
        client = h.connection
        client.settimeout(None)

        def pump(src, dst):
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                for s in (src, dst):
                    try:
                        s.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

        t = threading.Thread(target=pump, args=(up, client), daemon=True)
        t.start()
        pump(client, up)
        t.join(timeout=2)
        up.close()
        h.close_connection = True

    # ---------------- camera ----------------

    def camera_url(self):
        host = urlsplit(self.base or self.candidates()[0]).hostname
        web_root = 'http://%s/' % host  # webcams are usually served by nginx on port 80
        if self.cfg.get('camera'):
            return self.cfg['camera']
        try:
            with urllib.request.urlopen((self.base or self.resolve_base()) + '/server/webcams/list', timeout=4) as r:
                cams = json.loads(r.read().decode('utf-8'))['result']['webcams']
            for cam in cams:
                if cam.get('enabled', True) and cam.get('stream_url'):
                    return urljoin(web_root, cam['stream_url'])
        except Exception:
            pass
        return web_root + 'webcam/?action=stream'

    def serve_camera(self, h):
        self.proxy(h, self.camera_url())


class SnapmakerU1Adapter(MoonrakerAdapter):
    kind = 'snapmaker-u1'
    default_ports = (7125, None)   # U1 exposes Moonraker on 7125
