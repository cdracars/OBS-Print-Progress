#!/usr/bin/env python3
"""OBS Print Progress server.

Serves the overlays and a setup page, and bridges printers the browser can't
talk to directly. Run it, open http://localhost:8000, add your printer, and
paste the shown URL into an OBS Browser source.

Supported printers:
  - Klipper / Moonraker (Voron, Sovol, RatRig, Creality with Moonraker, ...)
  - Snapmaker U1 (Moonraker on port 7125)
  - Bambu Lab X1 / P1 / A1 / P2S / H2 (LAN mode + access code)
  - Elegoo Centauri Carbon and Saturn 4 Ultra / Mars 5 Ultra resin printers (SDCP)
  - Prusa MINI / MK4 / XL / CORE One (PrusaLink)

Python 3.8+ standard library only.

    python server.py [--port 8000] [--lan] [--no-browser]
"""

import argparse
import ipaddress
import json
import mimetypes
import os
import sys
import threading
import tempfile
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, unquote

from bridge.base import wait_until
from bridge.bambu import BambuAdapter
from bridge.config import ConfigStore, masked, overlay_view
from bridge.discovery import discover, mark_known
from bridge.elegoo import ElegooAdapter, ElegooResinAdapter
from bridge.httputil import send_json, send_error_json, send_bytes, CLIENT_GONE
from bridge.moonraker import MoonrakerAdapter, SnapmakerU1Adapter
from bridge.prusa import PrusaLinkAdapter
from bridge.dashboard import Dashboard
from bridge.access import Access
from bridge.demo import DemoFleet
from bridge.anycubic import PhotonP1Adapter
from bridge.cameras import CameraPool

ROOT = os.path.dirname(os.path.abspath(__file__))
VERSION = '2.0.0'

ADAPTERS = {
    'klipper': MoonrakerAdapter,
    'snapmaker-u1': SnapmakerU1Adapter,
    'bambu': BambuAdapter,
    'elegoo-cc': ElegooAdapter,
    'elegoo-resin': ElegooResinAdapter,
    'prusalink': PrusaLinkAdapter,
    'anycubic-p1': PhotonP1Adapter,
}

# Only these files are served; everything else (server code, printers.json
# with access codes) stays private.
STATIC_EXT = {'.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp'}
STATIC_FILES = {'theme-custom.css'}
PRIVATE_DIRS = ('bridge', 'tests', '.git')


class Hub:
    """Keeps one running adapter per configured printer."""

    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.adapters = {}
        self.reload()

    def reload(self):
        printers = {p['id']: p for p in self.store.printers()}
        with self.lock:
            for pid, ad in list(self.adapters.items()):
                if pid not in printers or printers[pid] != ad.cfg:
                    ad.stop()
                    del self.adapters[pid]
            for pid, cfg in printers.items():
                if pid not in self.adapters:
                    ad = ADAPTERS[cfg['type']](cfg)
                    ad.start()
                    self.adapters[pid] = ad

    def get(self, pid):
        with self.lock:
            return self.adapters.get(pid)

    def summaries(self):
        with self.lock:
            return [a.summary() for a in self.adapters.values()]


class Handler(BaseHTTPRequestHandler):
    server_version = 'OBSPrintProgress/' + VERSION
    hub = None
    store = None

    def log_message(self, fmt, *args):
        if self.server.verbose:
            sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    # ---------------- routing ----------------

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        self.route()

    def do_POST(self):
        self.route()

    def do_DELETE(self):
        self.route()

    def trusted_host(self):
        """Refuse DNS-rebinding: a web page on some evil.example domain that
        resolves to 127.0.0.1 would send Host: evil.example."""
        if self.server.lan:
            return True
        host = urlsplit('//' + (self.headers.get('Host') or '')).hostname or ''
        if host == 'localhost':
            return True
        try:
            ipaddress.ip_address(host)
            return True
        except ValueError:
            return False

    def route(self):
        parts = urlsplit(self.path)
        path, query = parts.path, parts.query
        if not self.trusted_host():
            return send_error_json(self, 403, 'Use http://localhost:%d/ (or start the server with --lan)' % self.server.server_port)
        try:
            sensitive = path.startswith(('/p/', '/api/')) or path in ('/printers.json', '/dashboard-links.local.js')
            access = getattr(self.server, 'access', None)
            if sensitive and path not in ('/api/info', '/api/session') and access and not access.authorized(self.headers.get('Cookie')):
                return send_error_json(self, 401, 'Sign in to access this workshop')
            if sensitive and not self.same_origin():
                return send_error_json(self, 403, 'Cross-origin request blocked')
            if path == '/api/session' and self.command == 'POST':
                if not access:
                    return send_json(self, {'signed_in': True})
                token = access.login(self.read_json().get('password'), self.client_address[0])
                body = b'{"signed_in":true}'
                self.send_response(200)
                self.send_header('Set-Cookie', 'printdesk_session=%s; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200' % token)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
                return
            if path.startswith('/p/'):
                pid, _, rest = path[3:].partition('/')
                adapter = self.hub.get(unquote(pid))
                if not adapter:
                    return send_error_json(self, 404, 'Unknown printer "%s". Add it on the setup page.' % pid)
                # Generic proxy writes (including JSON-RPC over websockets on LAN)
                # must not bypass target/job/permission checks in the command interface.
                if self.command not in ('GET', 'HEAD'):
                    return send_error_json(self, 403, 'Use the checked dashboard command interface')
                is_websocket = self.headers.get('Upgrade', '').lower() == 'websocket'
                if is_websocket:
                    return send_error_json(self, 403, 'Overlay clients use read-only polling; raw JSON-RPC cannot bypass command checks')
                safe = ('printer/objects/query', 'printer/objects/list', 'printer/info', 'server/info', 'server/files/metadata')
                if not is_websocket and rest.split('?')[0] not in safe and not rest.startswith(('server/files/gcodes/', 'webcam')):
                    return send_error_json(self, 403, 'This printer route is not a read-only overlay resource')
                if rest.startswith('webcam') and getattr(self.server, 'cameras', None) and adapter.kind in ('klipper', 'snapmaker-u1', 'elegoo-cc'):
                    return self.server.cameras.serve(self, adapter)
                return adapter.handle(self, '/' + rest, query)
            if path.startswith('/api/'):
                return self.api(path[5:], query)
            if path == '/':
                self.send_response(302)
                self.send_header('Location', '/dashboard.html')
                self.end_headers()
                return
            if path == '/printers.json':
                return send_json(self, overlay_view(self.store.printers(), self.headers.get('Host') or 'localhost'))
            return self.static(path)
        except CLIENT_GONE:
            pass
        except (ValueError, TypeError, KeyError) as err:
            return send_error_json(self, 400, str(err))

    # ---------------- static files ----------------

    def static(self, path):
        rel = os.path.normpath(unquote(path).lstrip('/'))
        full = os.path.join(ROOT, rel)
        ext = os.path.splitext(rel)[1].lower()
        inside = os.path.commonpath([os.path.realpath(ROOT), os.path.realpath(full)]) == os.path.realpath(ROOT)
        allowed = inside and (ext in STATIC_EXT or rel in STATIC_FILES) and not rel.startswith(('..', '/')) \
            and not rel.split(os.sep)[0] in PRIVATE_DIRS
        if not allowed or not os.path.isfile(full):
            return send_error_json(self, 404, 'Not found')
        with open(full, 'rb') as f:
            data = f.read()
        ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype in ('application/javascript', 'application/json'):
            ctype += '; charset=utf-8'
        send_bytes(self, data, ctype)

    # ---------------- API ----------------

    def same_origin(self):
        """Block other websites from changing settings via the browser (CSRF)."""
        origin = self.headers.get('Origin')
        if not origin:
            return True
        return urlsplit(origin).netloc == self.headers.get('Host')

    def read_json(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length < 0 or length > 1_000_000:
            raise ValueError('request too large')
        data = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
        if not isinstance(data, dict):
            raise ValueError('Expected a JSON object')
        return data

    def api(self, route, query):
        if self.command != 'GET' and not self.same_origin():
            return send_error_json(self, 403, 'Cross-origin request blocked')

        if route == 'info' and self.command == 'GET':
            return send_json(self, {'version': VERSION, 'types': list(ADAPTERS)})

        dashboard = getattr(self.server, 'dashboard', None)
        demo = getattr(self.server, 'demo', None)
        if 'demo=1' in query.split('&'):
            if not demo:
                return send_error_json(self, 404, 'Simulation unavailable')
            dashboard, configs, adapters = demo.dashboard, demo.configs, demo.adapters
            if route not in ('fleet', 'events', 'equipment', 'commands', 'inventory/export', 'inventory/preview', 'inventory/import') and not route.startswith(('equipment/', 'connections/', 'camera/')):
                return send_error_json(self, 400, 'Simulation cannot change real printer connections')
        else:
            configs = self.store.printers()
            with self.hub.lock:
                adapters = dict(self.hub.adapters)
        if dashboard and route == 'fleet' and self.command == 'GET':
            if 'demo=1' in query.split('&'):
                demo.tick()
            payload = dashboard.fleet(configs, adapters)
            payload['mode'] = 'simulation' if 'demo=1' in query.split('&') else 'live'
            return send_json(self, payload)
        if dashboard and route == 'events' and self.command == 'GET':
            return send_json(self, {'events': dashboard.events()})
        if dashboard and route == 'equipment' and self.command == 'POST':
            return send_json(self, {'equipment': dashboard.create_item(self.read_json())})
        if dashboard and route == 'inventory/export' and self.command == 'GET':
            return send_json(self, dashboard.export_inventory())
        if dashboard and route in ('inventory/preview', 'inventory/import') and self.command == 'POST':
            doc = self.read_json()
            if route.endswith('preview'):
                items = dashboard.preview_import(doc)
                return send_json(self, {'summary': '%d equipment records will be restored. Control permissions reset to disabled.' % len(items)})
            return send_json(self, dashboard.import_inventory(doc))
        if dashboard and route.startswith('equipment/') and self.command == 'POST':
            ci_id, _, operation = route[len('equipment/'):].partition('/')
            data = self.read_json()
            if operation == 'controls':
                return send_json(self, dashboard.enable_controls(ci_id, data.get('enabled') is True))
            if operation:
                return send_error_json(self, 404, 'Unknown equipment operation')
            return send_json(self, {'equipment': dashboard.update_item(ci_id, data)})
        if dashboard and route == 'commands' and self.command == 'POST':
            return send_json(self, {'command': dashboard.command(self.read_json(), configs, adapters)})
        if dashboard and route.startswith('connections/') and self.command == 'POST':
            ad = adapters.get(route[len('connections/'):])
            if not ad or not hasattr(ad, 'handoff'):
                raise ValueError('This connection does not support handoff')
            ad.handoff(self.read_json().get('release') is True)
            return send_json(self, {'updated': True})
        if route.startswith('camera/') and self.command == 'GET':
            ad = adapters.get(route[len('camera/'):])
            if not ad:
                return send_error_json(self, 404, 'Camera not configured')
            pool = getattr(self.server, 'cameras', None)
            if not pool:
                return send_error_json(self, 404, 'Camera sharing unavailable')
            return pool.serve(self, ad)

        if route == 'printers' and self.command == 'GET':
            status = {s['id']: s for s in self.hub.summaries()}
            return send_json(self, {'printers': [dict(masked(p), status=status.get(p['id'])) for p in self.store.printers()]})

        if route == 'printers' and self.command == 'POST':
            data = self.read_json()
            printer, err = self.store.upsert(data, data.get('originalId'))
            if err:
                return send_error_json(self, 400, err)
            self.hub.reload()
            return send_json(self, {'printer': masked(printer)})

        if route.startswith('printers/') and self.command == 'DELETE':
            ok = self.store.delete(unquote(route[len('printers/'):]))
            self.hub.reload()
            return send_json(self, {'deleted': ok})

        if route == 'status' and self.command == 'GET':
            return send_json(self, {'printers': self.hub.summaries()})

        if route == 'discover' and self.command == 'POST':
            return send_json(self, {'found': mark_known(discover(5.0), self.store.printers())})

        if route == 'test' and self.command == 'POST':
            return self.test_connection(self.read_json())

        return send_error_json(self, 404, 'Unknown API route')

    def test_connection(self, data):
        cfg = dict(data)
        cfg['id'] = cfg.get('id') or 'test'
        kind = cfg.get('type') if cfg.get('type') in ADAPTERS else 'klipper'
        if cfg.get('accessCode') == '********':
            saved = self.store.get(cfg.get('originalId') or cfg['id'])
            cfg['accessCode'] = (saved or {}).get('accessCode', '')
        ad = ADAPTERS[kind](cfg)
        ad.start()
        ok = wait_until(lambda: ad.snapshot()['online'] and ad.snapshot()['message'] == '', 12)
        summary = ad.summary()
        ad.stop()
        summary['ok'] = ok
        if not ok and summary['online']:
            summary['message'] = summary['message'] or 'Connected, but no status received yet.'
        return send_json(self, summary)


def main():
    ap = argparse.ArgumentParser(description='OBS Print Progress overlay server and printer bridge')
    ap.add_argument('--port', type=int, default=int(os.environ.get('PORT', 8000)))
    ap.add_argument('--host', default=os.environ.get('HOST', '127.0.0.1'),
                    help='interface to listen on (default 127.0.0.1, this computer only)')
    ap.add_argument('--lan', action='store_true', help='also accept connections from other computers (0.0.0.0)')
    ap.add_argument('--config', default=os.path.join(ROOT, 'printers.json'))
    ap.add_argument('--no-browser', action='store_true', help="don't open the setup page")
    ap.add_argument('--verbose', action='store_true', help='log every request')
    args = ap.parse_args()

    host = '0.0.0.0' if args.lan else args.host
    try:
        network = not ipaddress.ip_address(host).is_loopback
    except ValueError:
        network = host != 'localhost'
    try:
        access = Access(os.environ.get('DASHBOARD_PASSWORD', ''), required=network)
    except ValueError as err:
        ap.error(str(err))

    store = ConfigStore(args.config)
    Handler.store = store
    Handler.hub = Hub(store)

    try:
        httpd = ThreadingHTTPServer((host, args.port), Handler)
    except OSError as err:
        print('Could not listen on port %d: %s' % (args.port, err))
        print('Is the server already running? Otherwise try: python server.py --port 8001')
        sys.exit(1)
    httpd.daemon_threads = True
    httpd.verbose = args.verbose
    httpd.lan = network
    httpd.access = access
    httpd.cameras = CameraPool()
    httpd.dashboard = Dashboard(os.path.join(os.path.dirname(os.path.abspath(args.config)), 'dashboard.sqlite3'))
    demo_folder = tempfile.TemporaryDirectory(prefix='printdesk-demo-')
    httpd.demo = DemoFleet(os.path.join(demo_folder.name, 'demo.sqlite3'))

    url = 'http://localhost:%d/' % args.port
    print('OBS Print Progress %s' % VERSION)
    print('  Dashboard:    %s' % url)
    print('  Printers:     %d configured (%s)' % (len(store.printers()), args.config))
    if args.lan:
        print('  Listening on all network interfaces (--lan)')
    print('Keep this window open while streaming. Press Ctrl+C to stop.')
    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
    finally:
        httpd.cameras.close()
        httpd.server_close()
        for ad in Handler.hub.adapters.values():
            ad.stop()
        demo_folder.cleanup()


if __name__ == '__main__':
    main()
