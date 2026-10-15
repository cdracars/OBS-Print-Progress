"""Minimal WebSocket client (RFC 6455) for talking to printers.

Text frames only, client-side masking, handles ping/pong, close and
fragmented messages. Enough for JSON protocols like Elegoo SDCP.
"""

import base64
import os
import socket
import struct

from .httputil import recv_exact


class WebSocketClosed(ConnectionError):
    pass


def encode_frame(payload, opcode=0x1, mask_key=None):
    if isinstance(payload, str):
        payload = payload.encode('utf-8')
    mask_key = mask_key if mask_key is not None else os.urandom(4)
    n = len(payload)
    head = bytearray([0x80 | opcode])
    if n < 126:
        head.append(0x80 | n)
    elif n < 65536:
        head.append(0x80 | 126)
        head += struct.pack('!H', n)
    else:
        head.append(0x80 | 127)
        head += struct.pack('!Q', n)
    masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    return bytes(head) + mask_key + masked


def read_frame(rx):
    """Read one frame with `rx(n)`. Returns (fin, opcode, payload)."""
    b0, b1 = rx(2)
    fin, opcode = bool(b0 & 0x80), b0 & 0x0F
    n = b1 & 0x7F
    if n == 126:
        n = struct.unpack('!H', rx(2))[0]
    elif n == 127:
        n = struct.unpack('!Q', rx(8))[0]
    mask = rx(4) if b1 & 0x80 else None
    data = rx(n) if n else b''
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return fin, opcode, data


class WebSocket:
    def __init__(self, host, port, path='/', timeout=8):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode('ascii')
        req = ('GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
               'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n') % (path, host, port, key)
        self.sock.sendall(req.encode('ascii'))
        resp = b''
        while b'\r\n\r\n' not in resp:
            chunk = self.sock.recv(1024)
            if not chunk:
                raise WebSocketClosed('closed during handshake')
            resp += chunk
            if len(resp) > 16384:
                raise WebSocketClosed('bad handshake')
        head, self._buffer = resp.split(b'\r\n\r\n', 1)
        status = head.split(b'\r\n', 1)[0]
        if b' 101' not in status:
            raise WebSocketClosed('handshake rejected: %s' % status.decode('latin-1'))

    def _rx(self, n):
        if self._buffer:
            take, self._buffer = self._buffer[:n], self._buffer[n:]
            if len(take) == n:
                return take
            return take + recv_exact(self.sock, n - len(take))
        return recv_exact(self.sock, n)

    def settimeout(self, t):
        self.sock.settimeout(t)

    def send(self, text):
        self.sock.sendall(encode_frame(text))

    def recv(self):
        """Next complete text/binary message (as str). Raises socket.timeout."""
        parts = []
        while True:
            fin, opcode, data = read_frame(self._rx)
            if opcode == 0x8:
                raise WebSocketClosed('closed by printer')
            if opcode == 0x9:
                self.sock.sendall(encode_frame(data, opcode=0xA))
                continue
            if opcode == 0xA:
                continue
            parts.append(data)
            if fin:
                return b''.join(parts).decode('utf-8', 'replace')

    def close(self):
        try:
            self.sock.sendall(encode_frame(b'', opcode=0x8))
        except OSError:
            pass
        self.sock.close()
