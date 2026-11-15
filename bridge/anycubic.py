"""Experimental Photon P1 LAN adapter, not Anycubic Kobra/FDM.

Protocol and field mapping reference: modrzew/hass-anycubic-photon-p1,
commit f33ceb5bc47388412a7a378ed58649736a5a6834 (MIT).
See LICENSES/hass-anycubic-photon-p1.txt and docs/spec/protocol-implementation-notes.md.
Monitoring does not activate video, heaters, motion or printing.
"""
import base64
import hashlib
import json
import socket
import ssl
import threading
import time
import urllib.parse
import urllib.request
import uuid

from . import aes, mqtt
from .base import Adapter, deep_merge, wait_until, describe_error
from .httputil import recv_exact

PREFIX = 'anycubic/anycubicCloud/v1'


def num(value):
    try:
        result = float(value)
        return result if result == result and abs(result) != float('inf') else None
    except (TypeError, ValueError):
        return None


class PhotonP1Adapter(Adapter):
    kind = 'anycubic-p1'
    HTTP_PORT, MQTT_PORT = 18910, 8883

    def __init__(self, cfg):
        super().__init__(cfg)
        self.reports = {}
        self.sock = None
        self.send_lock = threading.Lock()
        self.wake = threading.Event()
        self.released = False
        self.model_id = self.device_id = None

    def handoff(self, release):
        self.released = release
        if release:
            self.set_offline('Connection released to Photon Workshop. Reconnect explicitly when it is finished.')
            if self.sock:
                try:
                    self.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        else:
            self.wake.set()

    def stop(self):
        super().stop()
        self.wake.set()
        if self.sock:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def _run_safe(self):
        while not self.stop_event.is_set():
            if self.released:
                self.wake.wait(1)
                self.wake.clear()
                continue
            try:
                self.run()
            except Exception as err:
                self.set_offline('P1 connection lost. Reconnect explicitly after checking Photon Workshop. ' + describe_error(err))
            # This fixed-client broker disconnects competing clients. Do not fight a slicer.
            self.released = True

    def http_json(self, path, method='GET'):
        url = 'http://%s:%d%s' % (self.ip, self.HTTP_PORT, path)
        request = urllib.request.Request(url, data=b'' if method == 'POST' else None, method=method)
        with urllib.request.urlopen(request, timeout=6) as response:
            return json.loads(response.read(1024*1024))

    def handshake(self):
        info = self.http_json('/info')
        if info.get('code', 0) != 0 or info.get('ctrlType') != 'lan':
            raise ConnectionError('Enable LAN mode on the Photon P1 before connecting.')
        token = str(info.get('token') or '')
        if len(token) != 32:
            raise ConnectionError('P1 returned an invalid ephemeral token')
        ts, nonce = str(int(time.time()*1000)), uuid.uuid4().hex[:15]
        inner = hashlib.md5(token[:16].encode()).hexdigest()
        sign = hashlib.md5((inner + ts + nonce).encode()).hexdigest()
        params = urllib.parse.urlencode({'ts': ts, 'nonce': nonce, 'did': 'print-desk', 'sign': sign})
        # Use the known device's local /ctrl path, never a response-supplied arbitrary URL.
        response = self.http_json('/ctrl?' + params, 'POST')
        data = response.get('data') or {}
        if response.get('code') != 200:
            raise ConnectionError('P1 refused the LAN handshake')
        encoded = str(data.get('info') or '')
        ciphertext = base64.b64decode(encoded + '='*((-len(encoded)) % 4), validate=True)
        plain = aes.cbc_decrypt(ciphertext, token[16:].encode(), str(data.get('token') or '').encode(), unpad=False)
        credentials, _ = json.JSONDecoder().raw_decode(plain.decode('utf-8', 'strict').lstrip())
        if not isinstance(credentials, dict) or not all(credentials.get(k) for k in ('clientId', 'deviceId', 'username', 'password')):
            raise ConnectionError('Invalid P1 session credentials')
        self.model_id, self.device_id = str(info['modelId']), str(credentials['deviceId'])
        return credentials

    def send(self, data):
        with self.send_lock:
            if not self.sock:
                raise ConnectionError('P1 session is not connected')
            self.sock.sendall(data)

    def publish(self, topic, action='query', message_type=None):
        payload = {'type': message_type or topic, 'action': action, 'msgid': uuid.uuid4().hex,
                   'timestamp': int(time.time()*1000), 'data': None}
        destination = '%s/pc/printer/%s/%s/%s' % (PREFIX, self.model_id, self.device_id, topic)
        self.send(mqtt.publish_packet(destination, json.dumps(payload)))

    def run(self):
        credentials = self.handshake()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE  # LAN device firmware has a self-signed, weak key.
        context.set_ciphers('DEFAULT:@SECLEVEL=0')
        raw = socket.create_connection((self.ip, self.MQTT_PORT), timeout=6)
        sock = context.wrap_socket(raw, server_hostname=self.ip)
        self.sock = sock
        try:
            rx = lambda size: recv_exact(sock, size)
            self.send(mqtt.connect_packet(credentials['clientId'], credentials['username'], credentials['password']))
            ptype, _, body = mqtt.read_packet(rx)
            if ptype != mqtt.CONNACK or len(body) < 2 or body[1] != 0:
                raise ConnectionError('P1 MQTT authentication rejected')
            topic = '%s/printer/+/%s/%s/+/report' % (PREFIX, self.model_id, self.device_id)
            self.send(mqtt.subscribe_packet(1, topic))
            ptype, _, body = mqtt.read_packet(rx)
            if ptype != mqtt.SUBACK or len(body) < 3 or 128 in body[2:]:
                raise ConnectionError('P1 MQTT subscription rejected')
            sock.settimeout(1)
            last_query = last_ping = 0
            while not self.stop_event.is_set() and not self.released:
                now = time.monotonic()
                if now - last_query >= 10:
                    self.publish('status')
                    self.publish('print')
                    last_query = now
                if now - last_ping >= 20:
                    self.send(mqtt.PINGREQ_PACKET)
                    last_ping = now
                try:
                    ptype, flags, body = mqtt.read_packet(rx)
                except socket.timeout:
                    continue
                if ptype == mqtt.PUBLISH:
                    _, payload = mqtt.parse_publish(flags, body)
                    try:
                        self.on_message(json.loads(payload))
                    except (ValueError, TypeError):
                        continue
        finally:
            self.sock = None
            sock.close()

    def on_message(self, message):
        kind, data = message.get('type'), message.get('data')
        if kind not in ('print', 'status', 'properties', 'tempature', 'releaseFilm'):
            return
        bucket = self.reports.setdefault(kind, {})
        if isinstance(data, dict):
            deep_merge(bucket, data)
        remote_state = str(message.get('state') or '').lower()
        states = {'printing': 'printing', 'paused': 'paused', 'complete': 'complete',
                  'stopping': 'cancelled', 'error': 'error', 'free': 'standby', 'idle': 'standby'}
        fields = {}
        if kind == 'print':
            if remote_state in states:
                fields['state'] = states[remote_state]
            for source, target in (('curr_layer', 'layer'), ('total_layers', 'total_layers'),
                                   ('filename', 'filename'), ('supplies_usage', 'resin_ml')):
                if source in bucket:
                    fields[target] = bucket[source]
            for source, target in (('remain_time', 'remaining'), ('print_time', 'elapsed')):
                if source in bucket:
                    value = num(bucket[source])
                    fields[target] = value*60 if value is not None else None
            if 'progress' in bucket:
                progress = num(bucket['progress'])
                fields['progress'] = min(1, max(0, progress/100)) if progress is not None else None
            fields['_job_observed_at'] = time.time()
        elif kind == 'status' and remote_state in ('free', 'idle'):
            fields['state'] = 'standby'
        if 'resin_temp' in bucket:
            fields['chamber'] = num(bucket['resin_temp'])
        fields.update(online=True, message='', heaters=False, nozzle=None, bed=None)
        self.update(**fields)

    def refresh_for_command(self):
        previous = self.snapshot().get('_job_observed_at') or 0
        self.publish('print')
        if not wait_until(lambda: (self.snapshot().get('_job_observed_at') or 0) > previous, 3):
            raise ValueError('No fresh P1 job observation. Inspect the printer before control.')

    def perform_command(self, action):
        self.publish('print', {'pause': 'pause', 'resume': 'resume', 'cancel': 'stop'}[action])
