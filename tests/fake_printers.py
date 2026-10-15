"""Fake Bambu Lab and Elegoo printers for testing server.py without hardware.

They speak just enough of the real protocols:
  - FakeBambu:  MQTT over TLS (CONNECT/SUBSCRIBE/PUBLISH, P1-style delta
                reports) and the port-6000 JPEG camera protocol.
  - FakeElegoo: SDCP over WebSocket, UDP discovery, /downloadFile and an
                MJPEG /video stream.

Both simulate a print that advances through `layers` layers in `duration`
seconds.

Run standalone (for manual / browser testing):
    python tests/fake_printers.py --gcode path/to/file.gcode
"""

import argparse
import base64
import hashlib
import io
import json
import os
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from bridge import mqtt  # noqa: E402
from bridge.httputil import recv_exact  # noqa: E402
from bridge.websocket import read_frame  # noqa: E402

FAKE_JPEG = b'\xff\xd8\xff\xe0' + b'FAKEJPEG' * 8 + b'\xff\xd9'


class SimPrint:
    def __init__(self, layers=40, duration=60.0, name='Benchy'):
        self.layers, self.duration, self.name = layers, duration, name
        self.t0 = time.time()

    def frac(self):
        return min(1.0, (time.time() - self.t0) / self.duration)

    def layer(self):
        return min(self.layers, 1 + int(self.frac() * self.layers))


def make_cert(folder):
    cert, key = os.path.join(folder, 'cert.pem'), os.path.join(folder, 'key.pem')
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
                    '-days', '1', '-subj', '/CN=fake-printer'], check=True, capture_output=True)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    return ctx


def serve_forever(sock, handler, stop):
    sock.settimeout(0.5)
    while not stop.is_set():
        try:
            conn, _ = sock.accept()
        except socket.timeout:
            continue
        except OSError:
            return
        threading.Thread(target=handler, args=(conn,), daemon=True).start()


def listen(port=0):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', port))
    s.listen(8)
    return s


# ============================================================
# BAMBU
# ============================================================

def make_3mf(gcode, plate=1):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('3D/3dmodel.model', '<model/>')
        z.writestr('Metadata/plate_%d.gcode' % plate, gcode)
        z.writestr('Metadata/plate_%d.png' % plate, b'\x89PNG\r\n\x1a\nfake-thumbnail')
    return buf.getvalue()


class FakeBambu:
    def __init__(self, serial='01P00A000000001', code='12345678', sim=None, gcode=b'G1 X0 Y0 Z0.2\nG1 X10 E1\n',
                 mqtt_port=0, camera_port=0, ftp_port=0):
        self.serial, self.code = serial, code
        self.sim = sim or SimPrint()
        self.stop = threading.Event()
        self.tmp = tempfile.mkdtemp()
        self.ctx = make_cert(self.tmp)
        self.mqtt_sock = listen(mqtt_port)
        self.cam_sock = listen(camera_port)
        self.ftp_sock = listen(ftp_port)
        self.mqtt_port = self.mqtt_sock.getsockname()[1]
        self.camera_port = self.cam_sock.getsockname()[1]
        self.ftp_port = self.ftp_sock.getsockname()[1]
        self.files = {'/cache/%s.gcode.3mf' % self.sim.name: make_3mf(gcode)}
        self.connections = 0

    def start(self):
        threading.Thread(target=serve_forever, args=(self.mqtt_sock, self._mqtt_client, self.stop), daemon=True).start()
        threading.Thread(target=serve_forever, args=(self.cam_sock, self._camera_client, self.stop), daemon=True).start()
        threading.Thread(target=serve_forever, args=(self.ftp_sock, self._ftp_client, self.stop), daemon=True).start()
        return self

    def close(self):
        self.stop.set()
        self.mqtt_sock.close()
        self.cam_sock.close()
        self.ftp_sock.close()

    def _ftp_client(self, raw):
        """Implicit FTPS: TLS from the first byte, PASV data connections in TLS."""
        try:
            sock = self.ctx.wrap_socket(raw, server_side=True)
            f = sock.makefile('rwb')

            def say(line):
                f.write((line + '\r\n').encode())
                f.flush()

            say('220 fake bambu ftp')
            authed, data_listener = False, None
            while True:
                line = f.readline().decode().strip()
                if not line:
                    return
                cmd, _, arg = line.partition(' ')
                cmd = cmd.upper()
                if cmd == 'USER':
                    say('331 password')
                elif cmd == 'PASS':
                    authed = arg == self.code
                    say('230 ok' if authed else '530 login incorrect')
                elif cmd in ('PBSZ', 'PROT', 'TYPE'):
                    say('200 ok')
                elif not authed:
                    say('530 not logged in')
                elif cmd == 'SIZE':
                    say('213 %d' % len(self.files[arg]) if arg in self.files else '550 no such file')
                elif cmd == 'PASV':
                    data_listener = listen(0)
                    port = data_listener.getsockname()[1]
                    say('227 Entering Passive Mode (127,0,0,1,%d,%d)' % (port // 256, port % 256))
                elif cmd == 'NLST':
                    say('550 not implemented')
                elif cmd == 'RETR' and data_listener:
                    if arg not in self.files:
                        say('550 no such file')
                        continue
                    say('150 opening data connection')
                    conn, _ = data_listener.accept()
                    data = self.ctx.wrap_socket(conn, server_side=True)
                    data.sendall(self.files[arg])
                    data.unwrap()
                    data.close()
                    data_listener.close()
                    data_listener = None
                    say('226 transfer complete')
                elif cmd == 'QUIT':
                    say('221 bye')
                    return
                else:
                    say('502 not implemented')
        except (ssl.SSLError, OSError, ConnectionError):
            pass

    def report(self, full):
        f = self.sim.frac()
        state = 'FINISH' if f >= 1 else 'RUNNING'
        rep = {'gcode_state': state, 'mc_percent': int(f * 100), 'mc_remaining_time': int((1 - f) * self.sim.duration / 60) + (0 if f >= 1 else 1),
               'layer_num': self.sim.layer(), 'total_layer_num': self.sim.layers,
               'nozzle_temper': 219.6, 'nozzle_target_temper': 220, 'bed_temper': 54.9, 'bed_target_temper': 55}
        if full:
            rep.update({'subtask_name': self.sim.name, 'gcode_file': self.sim.name + '.gcode.3mf', 'chamber_temper': 5,
                        'command': 'push_status', 'sequence_id': '1'})
        else:
            # P1/A1 behaviour: only changed fields
            rep = {k: rep[k] for k in ('mc_percent', 'layer_num', 'nozzle_temper', 'gcode_state', 'mc_remaining_time')}
        return {'print': rep}

    def _mqtt_client(self, raw):
        try:
            sock = self.ctx.wrap_socket(raw, server_side=True)
        except (ssl.SSLError, OSError):
            return
        rx = lambda n: recv_exact(sock, n)
        topic = 'device/%s/report' % self.serial
        try:
            ptype, _, body = mqtt.read_packet(rx)
            assert ptype == mqtt.CONNECT
            # parse username/password at the end of the payload
            pos = 2 + struct.unpack('!H', body[:2])[0] + 4
            cid_len = struct.unpack('!H', body[pos:pos + 2])[0]
            pos += 2 + cid_len
            ulen = struct.unpack('!H', body[pos:pos + 2])[0]
            user = body[pos + 2:pos + 2 + ulen].decode()
            pos += 2 + ulen
            plen = struct.unpack('!H', body[pos:pos + 2])[0]
            password = body[pos + 2:pos + 2 + plen].decode()
            ok = user == 'bblp' and password == self.code
            sock.sendall(bytes([0x20, 2, 0, 0 if ok else 5]))
            if not ok:
                return
            self.connections += 1
            sock.settimeout(0.3)
            subscribed = False
            while not self.stop.is_set():
                try:
                    ptype, flags, body = mqtt.read_packet(rx)
                    if ptype == mqtt.SUBSCRIBE:
                        sub_topic = body[4:4 + struct.unpack('!H', body[2:4])[0]].decode()
                        subscribed = sub_topic == topic
                        sock.sendall(bytes([0x90, 3]) + body[:2] + b'\x00')
                    elif ptype == mqtt.PUBLISH:
                        _, payload = mqtt.parse_publish(flags, body)
                        if b'pushall' in payload and subscribed:
                            sock.sendall(mqtt.publish_packet(topic, json.dumps(self.report(True))))
                    elif ptype == mqtt.PINGREQ:
                        sock.sendall(bytes([0xD0, 0]))
                    elif ptype == mqtt.DISCONNECT:
                        return
                except socket.timeout:
                    if subscribed:
                        sock.sendall(mqtt.publish_packet(topic, json.dumps(self.report(False))))
        except (ConnectionError, OSError, AssertionError):
            pass
        finally:
            sock.close()

    def _camera_client(self, raw):
        try:
            sock = self.ctx.wrap_socket(raw, server_side=True)
            auth = recv_exact(sock, 80)
            if auth[16:48].rstrip(b'\0') != b'bblp' or auth[48:80].rstrip(b'\0') != self.code.encode():
                sock.close()
                return
            while not self.stop.is_set():
                sock.sendall(struct.pack('<IIII', len(FAKE_JPEG), 0, 1, 0) + FAKE_JPEG)
                time.sleep(0.1)
        except (ssl.SSLError, OSError, ConnectionError):
            pass


# ============================================================
# ELEGOO
# ============================================================

class FakeElegoo:
    def __init__(self, gcode=b'G1 X0 Y0 Z0.2\nG1 X10 E1\n', filename='cube.gcode', sim=None, ws_port=0, http_port=0, udp_port=0):
        self.gcode, self.filename = gcode, filename
        self.sim = sim or SimPrint()
        self.mainboard = 'abc123mainboard'
        self.stop = threading.Event()
        self.ws_sock = listen(ws_port)
        self.ws_port = self.ws_sock.getsockname()[1]
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.bind(('127.0.0.1', udp_port))
        self.udp_port = self.udp.getsockname()[1]
        self.requests = []
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                if self.path == '/downloadFile/local/' + fake.filename:
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(fake.gcode)))
                    self.end_headers()
                    self.wfile.write(fake.gcode)
                elif self.path == '/video':
                    self.send_response(200)
                    self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=foo')
                    self.end_headers()
                    try:
                        for _ in range(50):
                            self.wfile.write(b'--foo\r\nContent-Type: image/jpeg\r\n\r\n' + FAKE_JPEG + b'\r\n')
                            self.wfile.flush()
                            time.sleep(0.1)
                    except OSError:
                        pass
                else:
                    self.send_response(404)
                    self.end_headers()

        self.http = ThreadingHTTPServer(('127.0.0.1', http_port), H)
        self.http.daemon_threads = True
        self.http_port = self.http.server_address[1]

    def start(self):
        threading.Thread(target=serve_forever, args=(self.ws_sock, self._ws_client, self.stop), daemon=True).start()
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        threading.Thread(target=self._udp, daemon=True).start()
        return self

    def close(self):
        self.stop.set()
        self.ws_sock.close()
        self.http.shutdown()
        self.udp.close()

    def _udp(self):
        self.udp.settimeout(0.5)
        while not self.stop.is_set():
            try:
                data, addr = self.udp.recvfrom(1024)
            except socket.timeout:
                continue
            except OSError:
                return
            if data == b'M99999':
                self.udp.sendto(json.dumps({'Id': 'x', 'Data': {'Name': 'Centauri Carbon', 'MachineName': 'Centauri Carbon',
                                                                 'MainboardID': self.mainboard, 'FirmwareVersion': 'V1.1.46'}}).encode(), addr)

    def status(self):
        f = self.sim.frac()
        return {
            'Status': {
                'CurrentStatus': [1],
                'TempOfNozzle': 219.8, 'TempTargetNozzle': 220, 'TempOfHotbed': 60.1, 'TempTargetHotbed': 60,
                'TempOfBox': 31.5, 'TempTargetBox': 0,
                'PrintInfo': {'Status': 9 if f >= 1 else 13, 'CurrentLayer': self.sim.layer(), 'TotalLayer': self.sim.layers,
                              'CurrentTicks': int(f * self.sim.duration), 'TotalTicks': int(self.sim.duration),
                              'Filename': self.filename, 'TaskId': 't1', 'PrintSpeedPct': 100, 'Progress': int(f * 100)},
            },
            'MainboardID': self.mainboard,
            'TimeStamp': int(time.time()),
            'Topic': 'sdcp/status/' + self.mainboard,
        }

    def _ws_client(self, conn):
        try:
            req = b''
            while b'\r\n\r\n' not in req:
                req += conn.recv(1024)
            key = [l.split(b':', 1)[1].strip() for l in req.split(b'\r\n') if l.lower().startswith(b'sec-websocket-key')][0]
            accept = base64.b64encode(hashlib.sha1(key + b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
            conn.sendall(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + b'\r\n\r\n')

            def send(obj):
                data = json.dumps(obj).encode()
                head = bytes([0x81, len(data)]) if len(data) < 126 else bytes([0x81, 126]) + struct.pack('!H', len(data))
                conn.sendall(head + data)

            conn.settimeout(0.5)
            while not self.stop.is_set():
                try:
                    _, op, data = read_frame(lambda n: recv_exact(conn, n))
                except socket.timeout:
                    send(self.status())
                    continue
                if op == 0x8:
                    return
                msg = json.loads(data.decode())
                self.requests.append(msg)
                if msg['Data'].get('MainboardID') == self.mainboard and msg['Data']['Cmd'] == 0:
                    send(self.status())
        except (OSError, ConnectionError, IndexError, ValueError):
            pass
        finally:
            conn.close()


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--gcode', help='G-code file the fake Elegoo serves')
    ap.add_argument('--layers', type=int, default=80)
    ap.add_argument('--duration', type=float, default=120)
    a = ap.parse_args()
    gcode = open(a.gcode, 'rb').read() if a.gcode else b'G1 X0 Y0 Z0.2\nG1 X10 E1\n'
    bambu = FakeBambu(sim=SimPrint(a.layers, a.duration), gcode=gcode).start()
    elegoo = FakeElegoo(gcode=gcode, sim=SimPrint(a.layers, a.duration)).start()
    print(json.dumps({'bambu': {'mqtt': bambu.mqtt_port, 'camera': bambu.camera_port, 'ftp': bambu.ftp_port, 'serial': bambu.serial, 'code': bambu.code},
                      'elegoo': {'ws': elegoo.ws_port, 'http': elegoo.http_port, 'udp': elegoo.udp_port}}), flush=True)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
