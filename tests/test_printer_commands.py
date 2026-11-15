"""Protocol contracts through adapter interfaces; no physical printers."""
import json
import pathlib
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from bridge.moonraker import MoonrakerAdapter
from bridge.prusa import PrusaLinkAdapter


class ProtocolCommands(unittest.TestCase):
    def test_elegoo_command_correlates_board_request_and_ack(self):
        from bridge.elegoo import ElegooAdapter
        ad = ElegooAdapter({'id': 'cc', 'ip': 'unused', 'mainboardId': 'board-fixture'})
        sent = []
        class Socket:
            def send(self, text):
                message = json.loads(text)
                sent.append(message)
                inner = dict(message['Data'], Data={'Ack': 0})
                ad.on_message({'Topic': 'sdcp/response/board-fixture', 'Data': inner})
        ad.ws = Socket()
        ad.perform_command('pause')
        self.assertEqual(sent[0]['Data']['Cmd'], 129)
        self.assertEqual(sent[0]['Data']['MainboardID'], 'board-fixture')
        self.assertLess(sent[0]['Data']['TimeStamp'], 100000000000)

    def test_photon_p1_preserves_resin_units_and_separates_acks(self):
        from bridge.anycubic import PhotonP1Adapter
        ad = PhotonP1Adapter({'id': 'p1', 'ip': 'unused'})
        ad.on_message({'type': 'print', 'state': 'printing', 'data': {'progress': 25, 'curr_layer': 0,
                      'total_layers': 80, 'remain_time': 12, 'print_time': 4, 'filename': 'part.pwmo',
                      'supplies_usage': 8.5}})
        ad.on_message({'type': 'properties', 'data': {'resin_temp': 28.5}})
        ad.on_message({'type': 'light', 'state': 'done', 'data': None})
        state = ad.snapshot()
        self.assertEqual((state['state'], state['progress'], state['layer']), ('printing', .25, 0))
        self.assertEqual((state['elapsed'], state['remaining']), (240, 720))
        self.assertEqual((state['chamber'], state['resin_ml']), (28.5, 8.5))
        self.assertIsNone(state['nozzle'])

    def test_moonraker_and_prusa_use_family_specific_job_endpoints(self):
        requests = []
        class Fake(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                requests.append((self.command, self.path))
                self.send_response(200)
                self.send_header('Content-Length', '2')
                self.end_headers()
                self.wfile.write(b'{}')
            def do_PUT(self):
                requests.append((self.command, self.path))
                self.send_response(204)
                self.end_headers()
            do_DELETE = do_PUT
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), Fake)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        address = '127.0.0.1:%d' % httpd.server_port
        try:
            moon = MoonrakerAdapter({'id': 'm', 'ip': address})
            moon.base = 'http://' + address
            moon.perform_command('pause')
            prusa = PrusaLinkAdapter({'id': 'p', 'ip': address, 'accessCode': 'fixture'})
            prusa.job_id = 42
            prusa.perform_command('resume')
            prusa.perform_command('cancel')
            prusa.update(state='printing', filename='part.gcode', _job_id=42)
            old_token = prusa.snapshot()['_job_token']
            prusa.update(state='printing', filename='other.gcode', _job_id=43)
            with self.assertRaises(ValueError):
                prusa.perform_checked_command('cancel', old_token)
            self.assertEqual(requests, [('POST', '/printer/print/pause'),
                                       ('PUT', '/api/v1/job/42/resume'), ('DELETE', '/api/v1/job/42')])
        finally:
            httpd.shutdown()
            worker.join()
            httpd.server_close()


if __name__ == '__main__':
    unittest.main()
