"""Behavior at the fleet/inventory interface (AC-01, AC-03, AC-04, AC-10)."""
import pathlib
import sys
import tempfile
import unittest
import json
import threading
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from bridge.dashboard import Dashboard
from bridge.base import Adapter
from bridge.config import ConfigStore
import server


class FleetTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.now = 100.0
        self.app = Dashboard(str(pathlib.Path(self.folder.name) / 'fleet.sqlite3'), clock=lambda: self.now)
        self.cfg = {'id': 'saturn', 'name': 'Saturn', 'type': 'elegoo-resin', 'ip': 'printer.local',
                    'accessCode': 'private', 'camera': 'rtsp://user:password@camera/live'}
        self.adapter = Adapter(self.cfg)

    def tearDown(self):
        self.folder.cleanup()

    def fleet(self):
        return self.app.fleet([self.cfg], {'saturn': self.adapter})['printers']

    def test_offline_printer_keeps_identity_and_unknown_resin_readings(self):
        card = self.fleet()[0]
        self.assertEqual(card['connection']['state'], 'offline')
        self.assertIsNone(card['readings']['nozzle'])
        self.assertIsNone(card['job']['progress'], 'Unobserved progress is unknown, not a zero measurement')
        self.assertNotIn('private', str(card))
        self.assertNotIn('password', str(card))
        self.app.update_item(card['ci_id'], {'name': 'Resin workhorse', 'lifecycle': 'maintenance'})
        renamed = self.fleet()[0]
        self.assertEqual(renamed['ci_id'], card['ci_id'])
        self.assertEqual(renamed['name'], 'Resin workhorse')
        self.assertEqual(renamed['id'], 'saturn')

    def test_cached_reads_do_not_refresh_observation_and_restart_preserves_ci(self):
        self.adapter.update(online=True, state='printing', filename='part.goo', progress=0.4)
        self.adapter.observed_at = 100.0
        initial = self.fleet()[0]
        self.assertFalse(initial['connection']['stale'])
        self.now = 116.0
        stale = self.fleet()[0]
        self.assertTrue(stale['connection']['stale'])
        self.assertEqual(stale['connection']['observed_at'], 100.0)
        self.assertEqual(stale['job']['state'], 'printing')
        restarted = Dashboard(self.app.path, clock=lambda: self.now)
        self.assertEqual(restarted.items()[0]['ci_id'], initial['ci_id'])

    def test_inventory_export_restore_keeps_identity_and_rejects_conflicts(self):
        item = self.fleet()[0]
        self.app.update_item(item['ci_id'], {'owner': 'Cody', 'location': 'Workshop'})
        exported = self.app.export_inventory()
        self.assertNotIn('private', json.dumps(exported))
        restored = Dashboard(str(pathlib.Path(self.folder.name) / 'restored.sqlite3'))
        restored.import_inventory(exported)
        self.assertEqual(restored.items()[0]['ci_id'], item['ci_id'])
        self.assertEqual(restored.items()[0]['owner'], 'Cody')
        bad = json.loads(json.dumps(exported))
        bad['equipment'][0]['ci_id'] = 'different-physical-printer'
        with self.assertRaises(ValueError):
            restored.import_inventory(bad)

    def test_unknown_command_is_not_retried_and_stale_targets_are_blocked(self):
        class Controlled(Adapter):
            calls = 0
            def perform_command(self, action):
                self.calls += 1
                raise TimeoutError('response lost')
        ad = Controlled(self.cfg)
        ad.update(online=True, state='printing', filename='part.goo')
        ad.observed_at = 100.0
        adapters = {'saturn': ad}
        card = self.app.fleet([self.cfg], adapters)['printers'][0]
        self.app.update_item(card['ci_id'], {'evidence': 'Supervised test fixture'})
        self.app.enable_controls(card['ci_id'], True)
        req = {'request_id': 'request-1', 'ci_id': card['ci_id'], 'id': 'saturn', 'action': 'pause',
               'job_token': card['job']['token']}
        result = self.app.command(req, [self.cfg], adapters)
        self.assertEqual(result['outcome'], 'unknown')
        self.assertEqual(self.app.command(req, [self.cfg], adapters)['outcome'], 'unknown')
        self.assertEqual(ad.calls, 1)
        self.now = 120.0
        with self.assertRaises(ValueError):
            self.app.command(dict(req, request_id='request-2'), [self.cfg], adapters)
        self.assertEqual(ad.calls, 1)

    def test_host_relationship_is_explicit_and_survives_export(self):
        printer = self.fleet()[0]
        host = self.app.create_item({'name': 'Workshop computer', 'class': 'host', 'owner': 'Cody'})
        self.app.update_item(host['ci_id'], {'relationships': [{'type': 'controls', 'target': printer['ci_id']}]})
        exported = self.app.export_inventory()
        restored = Dashboard(str(pathlib.Path(self.folder.name) / 'relations.sqlite3'))
        restored.import_inventory(exported)
        saved = next(x for x in restored.items() if x['ci_id'] == host['ci_id'])
        self.assertEqual(saved['relationships'][0]['target'], printer['ci_id'])
        self.assertEqual(len(restored.fleet([self.cfg], {'saturn': self.adapter})['printers']), 1)
        with self.assertRaises(ValueError):
            self.app.update_item(host['ci_id'], {'relationships': [{'type': 'controls', 'target': 'missing'}]})

    def test_connection_change_revokes_permission_and_replaced_job_is_blocked(self):
        class Controlled(Adapter):
            calls = 0
            def perform_command(self, action):
                self.calls += 1
        ad = Controlled(self.cfg)
        ad.update(online=True, state='printing', filename='first.goo')
        ad.observed_at = 100
        card = self.app.fleet([self.cfg], {'saturn': ad})['printers'][0]
        self.app.update_item(card['ci_id'], {'evidence': 'Supervised fixture'})
        self.app.enable_controls(card['ci_id'], True)
        ad.update(state='complete')
        ad.update(state='printing', filename='first.goo')
        ad.observed_at = 100
        with self.assertRaises(ValueError):
            self.app.command({'request_id': 'old-job', 'id': 'saturn', 'ci_id': card['ci_id'],
                              'job_token': card['job']['token'], 'action': 'pause'}, [self.cfg], {'saturn': ad})
        self.assertEqual(ad.calls, 0)
        moved = dict(self.cfg, ip='replacement.local')
        updated = self.app.fleet([moved], {'saturn': ad})['printers'][0]
        self.assertFalse(updated['capabilities']['controls_enabled'])
        self.assertEqual(updated['ci_id'], card['ci_id'])


class FleetHttpTests(unittest.TestCase):
    def test_fleet_route_uses_shared_inventory_and_root_opens_dashboard(self):
        with tempfile.TemporaryDirectory() as folder:
            store = ConfigStore(str(pathlib.Path(folder) / 'printers.json'))
            store.upsert({'id': 'offline', 'name': 'Offline printer', 'ip': 'not-connected.local'})
            class Handler(server.Handler):
                pass
            Handler.store = store
            Handler.hub = SimpleNamespace(adapters={}, lock=threading.Lock())
            httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            httpd.verbose, httpd.lan = False, False
            httpd.dashboard = Dashboard(str(pathlib.Path(folder) / 'inventory.sqlite3'))
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            base = 'http://127.0.0.1:%d' % httpd.server_port
            try:
                with urllib.request.urlopen(base + '/api/fleet', timeout=3) as response:
                    fleet = json.load(response)
                self.assertEqual(fleet['printers'][0]['name'], 'Offline printer')
                with urllib.request.urlopen(base + '/', timeout=3) as response:
                    self.assertTrue(response.url.endswith('/dashboard.html'))
            finally:
                httpd.shutdown()
                thread.join()
                httpd.server_close()

    def test_network_access_blocks_legacy_writes_and_requires_session(self):
        from bridge.access import Access
        access = Access('a-long-workshop-password', required=True)
        self.assertFalse(access.authorized(None))
        with self.assertRaises(ValueError):
            access.login('wrong')
        cookie = access.login('a-long-workshop-password')
        self.assertTrue(access.authorized('printdesk_session=' + cookie))
        self.assertFalse(access.authorized('printdesk_session=not-a-session'))
        class Handler(server.Handler):
            hub = SimpleNamespace(get=lambda pid: Adapter({'id': pid}))
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        httpd.verbose, httpd.lan, httpd.access = False, True, access
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        base = 'http://127.0.0.1:%d' % httpd.server_port
        def rejected(path, code, headers=None, data=None):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(urllib.request.Request(base + path, headers=headers or {}, data=data), timeout=3)
            self.assertEqual(caught.exception.code, code)
            caught.exception.close()
        try:
            rejected('/api/fleet', 401)
            rejected('/dashboard-links.local.js', 401)
            request = urllib.request.Request(base + '/api/session', data=json.dumps({'password': 'a-long-workshop-password'}).encode(),
                                             headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=3) as response:
                session = response.headers['Set-Cookie']
            self.assertIn('HttpOnly', session)
            self.assertIn('SameSite=Strict', session)
            headers = {'Cookie': session.split(';')[0]}
            rejected('/p/saturn/printer/print/cancel', 403, headers, b'{}')
            rejected('/p/saturn/websocket', 403, dict(headers, Upgrade='websocket'))
            rejected('/api/session', 403, {'Origin': 'http://untrusted.example'}, b'{}')
        finally:
            httpd.shutdown()
            thread.join()
            httpd.server_close()

    def test_demo_commands_change_only_simulated_printers(self):
        from bridge.demo import DemoFleet
        with tempfile.TemporaryDirectory() as folder:
            demo = DemoFleet(str(pathlib.Path(folder) / 'demo.sqlite3'))
            before = demo.dashboard.fleet(demo.configs, demo.adapters)['printers']
            self.assertEqual(len(before), 8)
            self.assertTrue(all(not p['camera']['available'] for p in before),
                            'Simulation must never open a real printer camera route')
            printer = next(p for p in before if p['id'] == 'hos')
            result = demo.dashboard.command({'id': 'hos', 'ci_id': printer['ci_id'], 'action': 'pause',
                        'request_id': 'demo-request', 'job_token': printer['job']['token']}, demo.configs, demo.adapters)
            self.assertEqual(result['outcome'], 'accepted')
            after = demo.dashboard.fleet(demo.configs, demo.adapters)['printers']
            self.assertEqual(next(p for p in after if p['id'] == 'hos')['job']['state'], 'paused')


if __name__ == '__main__':
    unittest.main()
