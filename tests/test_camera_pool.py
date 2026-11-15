import pathlib
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from bridge.cameras import CameraPool


class CameraSharing(unittest.TestCase):
    def test_two_viewers_share_upstream_and_one_can_release(self):
        connections = []
        jpeg = b'\xff\xd8frame-fixture\xff\xd9'
        class Camera(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                connections.append(self.path)
                self.send_response(200)
                self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
                self.end_headers()
                try:
                    for _ in range(80):
                        self.wfile.write(b'--frame\r\nContent-Type: image/jpeg\r\n\r\n' + jpeg + b'\r\n')
                        self.wfile.flush()
                        time.sleep(.02)
                except OSError:
                    pass
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), Camera)
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        pool = CameraPool()
        try:
            url = 'http://127.0.0.1:%d/video' % httpd.server_port
            first = pool.subscribe('fixture', url)
            second = pool.subscribe('fixture', url)
            self.assertEqual(first.frame(timeout=2)[1], jpeg)
            first.close()
            self.assertEqual(second.frame(timeout=2)[1], jpeg)
            self.assertEqual(len(connections), 1)
            second.close()
        finally:
            pool.close()
            httpd.shutdown()
            worker.join()
            httpd.server_close()
