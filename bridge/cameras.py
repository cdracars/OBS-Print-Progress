"""Demand-driven JPEG/MJPEG sharing. Looking at a feed never enables device video."""
import threading
import time
import urllib.request
from urllib.parse import urlsplit
from .httputil import start_mjpeg, write_mjpeg_frame, send_error_json, CLIENT_GONE


class CameraSource:
    def __init__(self, url):
        self.url = url
        self.condition = threading.Condition()
        self.stop = threading.Event()
        self.sequence, self.jpeg, self.viewers = 0, None, 0
        self.response = None
        self.thread = threading.Thread(target=self.run, daemon=True, name='shared-camera')

    def run(self):
        try:
            while not self.stop.is_set():
                with urllib.request.urlopen(self.url, timeout=4) as response:
                    self.response = response
                    buffer = b''
                    read = getattr(response, 'read1', response.read)
                    while not self.stop.is_set():
                        chunk = read(65536)
                        if not chunk:
                            break
                        buffer += chunk
                        if len(buffer) > 8*1024*1024:
                            raise ValueError('Camera frame exceeds limit')
                        while True:
                            start = buffer.find(b'\xff\xd8')
                            end = buffer.find(b'\xff\xd9', start+2) if start >= 0 else -1
                            if start < 0 or end < 0:
                                break
                            with self.condition:
                                self.jpeg = buffer[start:end+2]
                                self.sequence += 1
                                self.condition.notify_all()
                            buffer = buffer[end+2:]
                # Snapshot cameras get a bounded refresh rate, not a hot reconnect loop.
                if self.stop.wait(1):
                    break
        except Exception:
            pass  # Consumer receives a bounded timeout; never expose a credential URL.
        finally:
            self.response = None
            self.stop.set()
            with self.condition:
                self.condition.notify_all()


class CameraLease:
    def __init__(self, pool, key, source):
        self.pool, self.key, self.source = pool, key, source
        self.closed = False

    def frame(self, after=0, timeout=5):
        source = self.source
        with source.condition:
            source.condition.wait_for(lambda: source.sequence > after or source.stop.is_set(), timeout)
            if source.sequence <= after or source.jpeg is None:
                raise ValueError('Camera is not delivering a browser-playable JPEG feed. Printer status is independent.')
            return source.sequence, source.jpeg

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.pool.release(self.key, self.source)


class CameraPool:
    def __init__(self, max_sources=4):
        self.sources, self.lock, self.max_sources = {}, threading.Lock(), max_sources

    def subscribe(self, key, url):
        if urlsplit(url).scheme not in ('http', 'https'):
            raise ValueError('This camera needs a browser-stream conversion helper; RTSP/FLV is not enabled here.')
        with self.lock:
            source = self.sources.get(key)
            if source and (source.url != url or source.stop.is_set()):
                self.sources.pop(key)
                source.stop.set()
                source = None
            if not source:
                if len(self.sources) >= self.max_sources:
                    raise ValueError('Camera limit reached. Close another preview first.')
                source = self.sources[key] = CameraSource(url)
                source.thread.start()
            source.viewers += 1
            return CameraLease(self, key, source)

    def release(self, key, source):
        with self.lock:
            source.viewers -= 1
            if source.viewers <= 0:
                source.stop.set()
                if self.sources.get(key) is source:
                    self.sources.pop(key)
                # read timeout bounds worker lifetime; closing a response in another
                # thread can block the caller until its read finishes.

    def close(self):
        with self.lock:
            for source in self.sources.values():
                source.stop.set()
            self.sources.clear()

    def serve(self, handler, adapter):
        cfg = adapter.cfg
        if cfg.get('camera'):
            url = cfg['camera']
        elif adapter.kind == 'elegoo-cc':
            url = 'http://%s:%d/video' % (adapter.ip, adapter.VIDEO_PORT)
        elif adapter.kind in ('klipper', 'snapmaker-u1'):
            url = adapter.camera_url()
        else:
            return send_error_json(handler, 404, 'No passive JPEG camera path is configured for this printer')
        lease = None
        try:
            lease = self.subscribe(adapter.id, url)
            sequence, jpeg = lease.frame()
        except Exception as err:
            if lease:
                lease.close()
            return send_error_json(handler, 502, str(err) if isinstance(err, ValueError) else 'Camera unavailable')
        try:
            start_mjpeg(handler)
            while True:
                write_mjpeg_frame(handler, jpeg)
                sequence, jpeg = lease.frame(after=sequence)
        except (ValueError, *CLIENT_GONE):
            pass
        finally:
            lease.close()
