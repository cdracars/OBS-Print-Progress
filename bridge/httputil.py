"""Small helpers for writing responses from a BaseHTTPRequestHandler."""

import json
import re
import socket

BOUNDARY = 'frame'


def send_json(h, obj, status=200):
    body = json.dumps(obj).encode('utf-8')
    h.send_response(status)
    h.send_header('Content-Type', 'application/json; charset=utf-8')
    h.send_header('Content-Length', str(len(body)))
    h.send_header('Cache-Control', 'no-store')
    h.end_headers()
    if h.command != 'HEAD':
        h.wfile.write(body)


def send_error_json(h, status, message):
    send_json(h, {'error': {'code': status, 'message': message}}, status)


def send_bytes(h, data, content_type='application/octet-stream', status=200):
    """Send a byte buffer, honouring a single `Range: bytes=a-b` request."""
    total = len(data)
    start, end = 0, total - 1
    rng = h.headers.get('Range')
    m = re.match(r'bytes=(\d*)-(\d*)$', rng.strip()) if rng else None
    if m and total:
        if m.group(1):
            start = int(m.group(1))
            if m.group(2):
                end = min(total - 1, int(m.group(2)))
        elif m.group(2):
            start = max(0, total - int(m.group(2)))
        if start > end or start >= total:
            h.send_response(416)
            h.send_header('Content-Range', 'bytes */%d' % total)
            h.end_headers()
            return
        status = 206
    chunk = memoryview(data)[start:end + 1]
    h.send_response(status)
    h.send_header('Content-Type', content_type)
    h.send_header('Content-Length', str(len(chunk)))
    h.send_header('Accept-Ranges', 'bytes')
    if status == 206:
        h.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, total))
    h.end_headers()
    if h.command == 'HEAD':
        return
    for i in range(0, len(chunk), 65536):
        h.wfile.write(chunk[i:i + 65536])


def start_mjpeg(h):
    h.send_response(200)
    h.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=' + BOUNDARY)
    h.send_header('Cache-Control', 'no-store')
    h.send_header('Connection', 'close')
    h.end_headers()


def write_mjpeg_frame(h, jpeg):
    h.wfile.write(('--%s\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n' % (BOUNDARY, len(jpeg))).encode('ascii'))
    h.wfile.write(jpeg)
    h.wfile.write(b'\r\n')
    h.wfile.flush()


def recv_exact(sock, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError('connection closed')
        buf += chunk
    return bytes(buf)


CLIENT_GONE = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socket.timeout)
