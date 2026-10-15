"""Tests for server.py and the bridge package (Bambu, Elegoo, Moonraker proxy).

Run with:  python -m unittest discover -s tests -p "test_*.py"
Integration tests use the fake printers in tests/fake_printers.py; the Bambu
ones need the `openssl` command to make a throwaway TLS certificate.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from http.server import ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server  # noqa: E402
from bridge import facade, mqtt  # noqa: E402
from bridge.bambu import BambuAdapter, normalize_report, job_filename, extract_plate_gcode, with_thumbnail, plate_from  # noqa: E402
from bridge.base import deep_merge, wait_until  # noqa: E402
from bridge.config import ConfigStore, overlay_view, masked, MASK  # noqa: E402
from bridge.discovery import bambu_from_ssdp  # noqa: E402
from bridge.elegoo import ElegooAdapter, normalize_status, extract_status  # noqa: E402
from bridge.websocket import encode_frame, read_frame  # noqa: E402
from fake_printers import FakeBambu, FakeElegoo, SimPrint, FAKE_JPEG  # noqa: E402

HAVE_OPENSSL = shutil.which('openssl') is not None


def reader(data):
    buf = io.BytesIO(data)

    def rx(n):
        out = buf.read(n)
        if len(out) < n:
            raise ConnectionError('eof')
        return out
    return rx


# ============================================================
# PROTOCOL HELPERS
# ============================================================

class MqttPacketTests(unittest.TestCase):
    def test_varint_boundaries(self):
        # Arrange / Act / Assert
        self.assertEqual(mqtt.encode_varint(0), b'\x00')
        self.assertEqual(mqtt.encode_varint(127), b'\x7f')
        self.assertEqual(mqtt.encode_varint(128), b'\x80\x01')
        self.assertEqual(mqtt.encode_varint(16383), b'\xff\x7f')
        self.assertEqual(mqtt.encode_varint(2097152), b'\x80\x80\x80\x01')

    def test_large_publish_round_trip(self):
        # Arrange: Bambu reports are several KB, so lengths need multi-byte varints
        payload = json.dumps({'print': {'x': 'y' * 20000}}).encode()
        pkt = mqtt.publish_packet('device/SN/report', payload)

        # Act
        ptype, flags, body = mqtt.read_packet(reader(pkt))
        topic, got = mqtt.parse_publish(flags, body)

        # Assert
        self.assertEqual(ptype, mqtt.PUBLISH)
        self.assertEqual(topic, 'device/SN/report')
        self.assertEqual(got, payload)

    def test_connect_packet_has_credentials(self):
        pkt = mqtt.connect_packet('cid', 'bblp', 'abc', keepalive=60)
        ptype, _, body = mqtt.read_packet(reader(pkt))
        self.assertEqual(ptype, mqtt.CONNECT)
        self.assertEqual(body[7] & 0xC0, 0xC0, 'username + password flags set')
        self.assertTrue(body.endswith(b'\x00\x04bblp\x00\x03abc'))


class WebSocketFrameTests(unittest.TestCase):
    def test_masked_round_trip_all_length_forms(self):
        for size in (5, 300, 70000):
            text = 'x' * size
            fin, op, data = read_frame(reader(encode_frame(text)))
            self.assertTrue(fin)
            self.assertEqual(op, 1)
            self.assertEqual(data.decode(), text)


# ============================================================
# BAMBU
# ============================================================

class BambuNormalizeTests(unittest.TestCase):
    def test_running_report(self):
        # Arrange
        rep = {'gcode_state': 'RUNNING', 'mc_percent': 40, 'mc_remaining_time': 30, 'layer_num': 12, 'total_layer_num': 100,
               'nozzle_temper': 220.4, 'nozzle_target_temper': 220, 'bed_temper': 55, 'bed_target_temper': 55,
               'subtask_name': 'Benchy', 'chamber_temper': 5}

        # Act
        n = normalize_report(rep, 'P1S')

        # Assert
        self.assertEqual(n['state'], 'printing')
        self.assertAlmostEqual(n['progress'], 0.4)
        self.assertEqual(n['remaining'], 1800)
        self.assertEqual((n['layer'], n['total_layers']), (12, 100))
        self.assertEqual(n['filename'], 'Benchy.gcode')
        self.assertIsNone(n['chamber'], 'P1 reports a placeholder chamber temperature')
        self.assertEqual(n['bed_size'], (256, 256))

    def test_elapsed_estimate_reproduces_remaining_in_overlay(self):
        # The overlay computes remaining = elapsed / progress - elapsed
        n = normalize_report({'gcode_state': 'RUNNING', 'mc_percent': 25, 'mc_remaining_time': 90})
        overlay_remaining = n['elapsed'] / n['progress'] - n['elapsed']
        self.assertAlmostEqual(overlay_remaining, 90 * 60)

    def test_state_mapping(self):
        cases = {'PAUSE': 'paused', 'FINISH': 'complete', 'IDLE': 'standby', 'PREPARE': 'printing'}
        for raw, expected in cases.items():
            self.assertEqual(normalize_report({'gcode_state': raw})['state'], expected, raw)
        self.assertEqual(normalize_report({'gcode_state': 'FAILED', 'print_error': 0})['state'], 'cancelled')
        self.assertEqual(normalize_report({'gcode_state': 'FAILED', 'print_error': 50348044})['state'], 'error')

    def test_a1_mini_and_h2d_bed_sizes(self):
        self.assertEqual(normalize_report({}, 'A1 mini')['bed_size'], (180, 180))
        self.assertEqual(normalize_report({}, 'H2D')['bed_size'], (350, 320))

    def test_job_filename_fallback_to_gcode_file(self):
        self.assertEqual(job_filename({'gcode_file': '/cache/Part A.gcode.3mf'}), 'Part A.gcode')
        self.assertEqual(job_filename({}), '')

    def test_delta_reports_merge(self):
        # Arrange: P1/A1 send a full report then only changed fields
        state = {}
        deep_merge(state, {'gcode_state': 'RUNNING', 'layer_num': 3, 'subtask_name': 'Cube'})

        # Act
        deep_merge(state, {'layer_num': 4})

        # Assert
        n = normalize_report(state)
        self.assertEqual((n['layer'], n['filename'], n['state']), (4, 'Cube.gcode', 'printing'))

    def test_extract_plate_gcode_and_thumbnail(self):
        # Arrange: a minimal Bambu project with two plates
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as z:
            z.writestr('Metadata/plate_1.gcode', '; plate one\n')
            z.writestr('Metadata/plate_2.gcode', '; plate two\n')
            z.writestr('Metadata/plate_2.png', b'\x89PNGfake')

        # Act
        gcode, png = extract_plate_gcode(buf.getvalue(), 2)
        out = with_thumbnail(gcode, png)

        # Assert
        self.assertEqual(gcode, b'; plate two\n')
        self.assertEqual(png, b'\x89PNGfake')
        self.assertTrue(out.startswith(b'; thumbnail begin 512x512'))
        self.assertTrue(out.endswith(b'; plate two\n'))
        self.assertEqual(extract_plate_gcode(buf.getvalue(), None)[0], b'; plate one\n', 'defaults to first plate')
        self.assertEqual(plate_from({'gcode_file': '/data/Metadata/plate_3.gcode'}), 3)

    def test_ssdp_discovery_parse(self):
        msg = ('NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nServer: UPnP/1.0\r\nLocation: 192.168.1.77\r\n'
               'NT: urn:bambulab-com:device:3dprinter:1\r\nUSN: 01P00A123456789\r\nDevModel.bambu.com: C12\r\n'
               'DevName.bambu.com: Workshop P1S\r\n\r\n')
        found = bambu_from_ssdp(msg, '192.168.1.77')
        self.assertEqual(found['serial'], '01P00A123456789')
        self.assertEqual(found['model'], 'P1S')
        self.assertEqual(found['name'], 'Workshop P1S')


# ============================================================
# ELEGOO
# ============================================================

class ElegooNormalizeTests(unittest.TestCase):
    def test_printing_status(self):
        st = {'TempOfNozzle': 219.8, 'TempTargetNozzle': 220, 'TempOfHotbed': 60, 'TempTargetHotbed': 60, 'TempOfBox': 30,
              'PrintInfo': {'Status': 13, 'CurrentLayer': 5, 'TotalLayer': 50, 'CurrentTicks': 600, 'TotalTicks': 3600,
                            'Filename': '/local/cube.gcode', 'Progress': 17}}
        n = normalize_status(st)
        self.assertEqual(n['state'], 'printing')
        self.assertEqual((n['layer'], n['total_layers']), (5, 50))
        self.assertEqual((n['elapsed'], n['remaining']), (600, 3000))
        self.assertEqual(n['filename'], 'cube.gcode')
        self.assertEqual(n['chamber'], 30)
        self.assertAlmostEqual(n['progress'], 0.17)

    def test_millisecond_ticks(self):
        n = normalize_status({'PrintInfo': {'Status': 13, 'CurrentTicks': 600000, 'TotalTicks': 3600000}})
        self.assertEqual((n['elapsed'], n['remaining']), (600, 3000))

    def test_old_firmware_temperature_pairs(self):
        n = normalize_status({'TempOfNozzle': [220, 180.5], 'PrintInfo': {'Status': 0}})
        self.assertEqual((n['nozzle'], n['nozzle_target'], n['state']), (180.5, 220, 'standby'))

    def test_status_codes(self):
        for code, state in ((6, 'paused'), (8, 'cancelled'), (9, 'complete'), (14, 'error'), (16, 'printing')):
            self.assertEqual(normalize_status({'PrintInfo': {'Status': code}})['state'], state, code)

    def test_extract_status_both_layouts(self):
        flat = {'Status': {'a': 1}, 'MainboardID': 'mb1', 'Topic': 'sdcp/status/mb1'}
        nested = {'Data': {'Status': {'a': 2}, 'MainboardID': 'mb2'}, 'Topic': 'sdcp/status/mb2'}
        self.assertEqual(extract_status(flat), ({'a': 1}, 'mb1'))
        self.assertEqual(extract_status(nested), ({'a': 2}, 'mb2'))
        self.assertEqual(extract_status({'Topic': 'sdcp/attributes/mb3', 'Attributes': {}})[1], 'mb3')


# ============================================================
# FACADE + CONFIG
# ============================================================

class FacadeTests(unittest.TestCase):
    def test_query_selects_objects_including_encoded_names(self):
        n = facade.empty_state()
        n.update(online=True, chamber=40, state='printing', progress=0.5, layer=3, total_layers=9)
        res = facade.query_response(n, 'print_stats&temperature_sensor%20chamber&nope')['result']['status']
        self.assertEqual(set(res), {'print_stats', 'temperature_sensor chamber'})
        self.assertEqual(res['print_stats']['info'], {'current_layer': 3, 'total_layer': 9})
        self.assertEqual(res['temperature_sensor chamber']['temperature'], 40)

    def test_no_file_position_so_toolpath_uses_layers(self):
        objs = facade.moonraker_objects(facade.empty_state())
        self.assertNotIn('file_position', objs['virtual_sdcard'])


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.store = ConfigStore(os.path.join(self.dir, 'printers.json'))

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_bambu_requires_serial_and_code(self):
        _, err = self.store.upsert({'type': 'bambu', 'name': 'P1S', 'ip': '1.2.3.4'})
        self.assertIn('serial', err)
        _, err = self.store.upsert({'type': 'bambu', 'name': 'P1S', 'ip': '1.2.3.4', 'serial': 'abc'})
        self.assertIn('access code', err)

    def test_masked_code_keeps_saved_secret(self):
        # Arrange
        self.store.upsert({'type': 'bambu', 'name': 'P1S', 'ip': '1.2.3.4', 'serial': 'abc', 'accessCode': 'secret12'})

        # Act: the setup page sends back the mask when the code wasn't changed
        p, err = self.store.upsert({'type': 'bambu', 'name': 'P1S', 'ip': '1.2.3.5', 'serial': 'abc', 'accessCode': MASK, 'originalId': 'p1s'})

        # Assert
        self.assertIsNone(err)
        self.assertEqual(len(self.store.printers()), 1, 'edited in place')
        self.assertEqual(self.store.get('p1s')['ip'], '1.2.3.5')
        self.assertEqual(self.store.get('p1s')['accessCode'], 'secret12')
        self.assertEqual(masked(p)['accessCode'], MASK)

    def test_overlay_view_hides_secrets_and_rewrites_ip(self):
        self.store.upsert({'type': 'bambu', 'name': 'Shop X1', 'ip': '1.2.3.4', 'serial': 'abc', 'accessCode': 'secret12', 'camera': 'x'})
        self.store.upsert({'type': 'klipper', 'name': 'Voron', 'ip': 'http://voron.local/', 'direct': True})
        view = overlay_view(self.store.printers(), 'localhost:8000')['printers']
        text = json.dumps(view)
        self.assertNotIn('secret12', text)
        self.assertNotIn('abc', text.lower().replace('"', ''))  # serial not exposed
        self.assertEqual(view[0]['ip'], 'localhost:8000/p/shop-x1')
        self.assertNotIn('camera', view[0])
        self.assertIs(view[0]['websocket'], False)
        self.assertEqual(view[1]['ip'], 'voron.local', 'direct printers keep their address')

    def test_new_printer_with_same_name_gets_its_own_id(self):
        self.store.upsert({'name': 'Voron', 'ip': 'a'})
        p, err = self.store.upsert({'name': 'voron', 'ip': 'b'})
        self.assertIsNone(err)
        self.assertEqual(p['id'], 'voron-2')
        self.assertEqual([x['ip'] for x in self.store.printers()], ['a', 'b'], 'first printer not overwritten')

    def test_renaming_into_existing_id_rejected(self):
        self.store.upsert({'name': 'Voron', 'ip': 'a'})
        self.store.upsert({'name': 'Prusa', 'ip': 'b'})
        _, err = self.store.upsert({'name': 'Voron', 'ip': 'b', 'originalId': 'prusa'})
        self.assertIn('already', err)


# ============================================================
# INTEGRATION (fake printers)
# ============================================================

@unittest.skipUnless(HAVE_OPENSSL, 'needs openssl to create a test certificate')
class BambuIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeBambu(sim=SimPrint(layers=20, duration=30, name='Benchy')).start()

    def tearDown(self):
        self.fake.close()

    def make(self, code='12345678'):
        ad = BambuAdapter({'id': 'x', 'ip': '127.0.0.1', 'serial': self.fake.serial, 'accessCode': code, 'model': 'P1S'})
        ad.MQTT_PORT, ad.CAMERA_PORT = self.fake.mqtt_port, self.fake.camera_port
        return ad

    def test_status_over_mqtt_tls(self):
        ad = self.make()
        ad.start()
        try:
            self.assertTrue(wait_until(lambda: ad.snapshot()['filename'] == 'Benchy.gcode', 8))
            s = ad.snapshot()
            self.assertEqual(s['state'], 'printing')
            self.assertEqual(s['total_layers'], 20)
            self.assertEqual(s['nozzle'], 219.6)
            # deltas keep updating without losing the filename
            layer = s['layer']
            self.assertTrue(wait_until(lambda: (ad.snapshot()['layer'] or 0) > layer, 6))
            self.assertEqual(ad.snapshot()['filename'], 'Benchy.gcode')
        finally:
            ad.stop()

    def test_gcode_download_over_implicit_ftps(self):
        # Arrange: adapter has seen the job via MQTT
        ad = self.make()
        ad.FTP_PORT = self.fake.ftp_port
        ad.start()
        try:
            self.assertTrue(wait_until(lambda: ad.snapshot()['filename'] == 'Benchy.gcode', 8))

            # Act
            data = ad.get_gcode('Benchy.gcode')

            # Assert: plate G-code extracted from /cache/Benchy.gcode.3mf with a thumbnail block added
            self.assertIsNotNone(data)
            self.assertTrue(data.startswith(b'; thumbnail begin 512x512'))
            self.assertTrue(data.endswith(b'G1 X10 E1\n'))
        finally:
            ad.stop()

    def test_wrong_access_code_is_reported(self):
        ad = self.make('wrong')
        ad.start()
        try:
            self.assertTrue(wait_until(lambda: 'access code' in ad.snapshot()['message'], 8), ad.snapshot()['message'])
            self.assertFalse(ad.snapshot()['online'])
        finally:
            ad.stop()

    def test_camera_frames(self):
        ad = self.make()
        hub = ad.camera
        frames = []

        class FakeHandler:
            headers = {}
            command = 'GET'

            def __init__(self):
                self.wfile = self

            def send_response(self, code):
                frames.append(('status', code))

            def send_header(self, *a):
                pass

            def end_headers(self):
                pass

            def write(self, data):
                if data == FAKE_JPEG:
                    frames.append('jpeg')
                    if frames.count('jpeg') >= 3:
                        raise BrokenPipeError()

            def flush(self):
                pass

        hub.serve(FakeHandler())
        self.assertEqual(frames[0], ('status', 200))
        self.assertGreaterEqual(frames.count('jpeg'), 3)
        ad.stop()


class ServerIntegrationTests(unittest.TestCase):
    """server.py end to end with a fake Elegoo printer."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cls.gcode = b';LAYER_CHANGE\nG1 X0 Y0 Z0.2\nG1 X10 E1\n'
        cls.fake = FakeElegoo(gcode=cls.gcode, filename='cube.gcode', sim=SimPrint(layers=10, duration=30)).start()
        for attr, val in (('WS_PORT', cls.fake.ws_port), ('HTTP_PORT', cls.fake.http_port),
                          ('VIDEO_PORT', cls.fake.http_port), ('DISCOVERY_PORT', cls.fake.udp_port)):
            setattr(ElegooAdapter, attr, val)
        store = ConfigStore(os.path.join(cls.dir, 'printers.json'))
        store.upsert({'type': 'elegoo-cc', 'name': 'Centauri', 'ip': '127.0.0.1'})
        server.Handler.store = store
        server.Handler.hub = server.Hub(store)
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.httpd.daemon_threads = True
        cls.httpd.verbose = False
        cls.httpd.lan = False
        cls.base = 'http://127.0.0.1:%d' % cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        for ad in server.Handler.hub.adapters.values():
            ad.stop()
        cls.fake.close()
        for attr, val in (('WS_PORT', 3030), ('HTTP_PORT', 80), ('VIDEO_PORT', 3031), ('DISCOVERY_PORT', 3000)):
            setattr(ElegooAdapter, attr, val)
        shutil.rmtree(cls.dir)

    def get(self, path, headers=None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read(), r.headers

    def test_moonraker_facade_status(self):
        ad = server.Handler.hub.get('centauri')
        self.assertTrue(wait_until(lambda: ad.snapshot()['filename'] == 'cube.gcode', 8))
        self.assertEqual(ad.mainboard, self.fake.mainboard, 'found via UDP discovery')
        _, body, _ = self.get('/p/centauri/printer/objects/query?print_stats&virtual_sdcard&extruder&heater_bed')
        st = json.loads(body)['result']['status']
        self.assertEqual(st['print_stats']['state'], 'printing')
        self.assertEqual(st['print_stats']['filename'], 'cube.gcode')
        self.assertEqual(st['print_stats']['info']['total_layer'], 10)
        self.assertEqual(st['extruder']['temperature'], 219.8)

    def test_gcode_download_with_range(self):
        ad = server.Handler.hub.get('centauri')
        wait_until(lambda: ad.snapshot()['filename'] == 'cube.gcode', 8)
        status, body, _ = self.get('/p/centauri/server/files/gcodes/cube.gcode')
        self.assertEqual((status, body), (200, self.gcode))
        status, body, headers = self.get('/p/centauri/server/files/gcodes/cube.gcode', {'Range': 'bytes=0-9'})
        self.assertEqual((status, body), (206, self.gcode[:10]))
        self.assertEqual(headers['Content-Range'], 'bytes 0-9/%d' % len(self.gcode))

    def test_camera_proxy(self):
        req = urllib.request.Request(self.base + '/p/centauri/webcam/?action=stream')
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertIn('multipart/x-mixed-replace', r.headers['Content-Type'])
            self.assertIn(FAKE_JPEG, r.read(400))

    def test_printers_json_is_sanitized(self):
        _, body, _ = self.get('/printers.json')
        p = json.loads(body)['printers'][0]
        self.assertEqual(p['ip'], '127.0.0.1:%d/p/centauri' % self.httpd.server_address[1])
        self.assertNotIn('mainboardId', p)

    def test_private_files_not_served(self):
        for path in ('/server.py', '/bridge/config.py', '/printers.json.example', '/../etc/passwd'):
            with self.assertRaises(urllib.error.HTTPError, msg=path) as ctx:
                self.get(path)
            self.assertEqual(ctx.exception.code, 404, path)

    def test_cross_origin_writes_blocked(self):
        req = urllib.request.Request(self.base + '/api/printers', data=b'{}', method='POST',
                                     headers={'Origin': 'http://evil.example', 'Content-Type': 'application/json'})
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=5)
        self.assertEqual(ctx.exception.code, 403)

    def test_dns_rebinding_host_blocked(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.get('/api/printers', {'Host': 'evil.example:8000'})
        self.assertEqual(ctx.exception.code, 403)

    def test_overlays_served(self):
        for page in ('/printer.html', '/toolpath.html', '/setup.html', '/print-progress.js'):
            status, _, _ = self.get(page)
            self.assertEqual(status, 200, page)


if __name__ == '__main__':
    unittest.main()
