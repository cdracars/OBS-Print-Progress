"""Serve the navigation UI with the real handler, without starting printer adapters."""
import pathlib
import sys
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server


class DashboardNavigationTests(unittest.TestCase):
    def test_navigation_assets_are_served_by_existing_routes(self):
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        httpd.verbose = False
        httpd.lan = False
        worker = threading.Thread(target=httpd.serve_forever, daemon=True)
        worker.start()
        base = 'http://127.0.0.1:%d' % httpd.server_port
        try:
            with urllib.request.urlopen(base + '/', timeout=3) as response:
                page = response.read().decode()
                self.assertEqual(response.status, 200)
                self.assertTrue(response.url.endswith('/dashboard.html'))
                self.assertIn('src="dashboard.js"', page)
                self.assertIn('href="setup.html"', page)
            with urllib.request.urlopen(base + '/setup.html', timeout=3) as response:
                self.assertIn('KlipperScreen is the interface on an attached display', response.read().decode())
            for asset in ('dashboard-links.js', 'setup.js', 'setup.css', 'dashboard.js', 'dashboard.css', 'fleet-view.js'):
                with self.subTest(asset=asset):
                    with urllib.request.urlopen(base + '/' + asset, timeout=3) as response:
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.read(), (ROOT / asset).read_bytes())
        finally:
            httpd.shutdown()
            worker.join(timeout=3)
            httpd.server_close()


if __name__ == '__main__':
    unittest.main()
