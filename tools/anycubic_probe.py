#!/usr/bin/env python3
"""Read-only probe for Anycubic printers in LAN mode (e.g. Photon P1).

Runs the LAN-mode handshake, connects to the printer's MQTT broker, asks for
status and records every message the printer sends for a while. The output
file is what's needed to build a proper adapter for printers whose messages
aren't documented yet. Nothing is changed on the printer: only "query"
requests are sent.

    python tools/anycubic_probe.py 192.168.1.95 [--seconds 120] [--out probe.jsonl]

Turn on LAN mode on the printer first (Settings > Network > LAN Mode). The
printer accepts one LAN client at a time, so close Photon Workshop / the
slicer while this runs. Credentials are never written to the output file.

Handshake as documented by the anycubic-lan project:
  GET  http://<ip>:18910/info  -> token, ctrlInfoUrl, modelId, ctrlType
  POST <ctrlInfoUrl>?ts&nonce&sign&did  (sign = md5(md5(token[:16]) + ts + nonce))
  data.info is AES-128-CBC with key token[16:], IV data.token (16 bytes, zero padded)
  -> {"broker": "mqtts://host:port", "username", "password", "deviceId", ...}
"""

import argparse
import base64
import hashlib
import json
import os
import random
import socket
import ssl
import string
import sys
import time
import urllib.request
import warnings

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from bridge import aes, mqtt  # noqa: E402
from bridge.httputil import recv_exact  # noqa: E402

PREFIX = 'anycubic/anycubicCloud/v1'
SECRET_KEYS = {'token', 'username', 'password', 'cn', 'usn', 'fileuploadurl', 'info'}
# Query names seen on FDM (web/...) and listed for resin (pc/...) printers.
QUERIES = ['status', 'print', 'info', 'lanInfo', 'tempature', 'releaseFilm', 'peripherie']


def redact(obj):
    if isinstance(obj, dict):
        return {k: ('**REDACTED**' if k.lower() in SECRET_KEYS else redact(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    return obj


def http_json(url, method='GET', timeout=10):
    req = urllib.request.Request(url, method=method, data=b'' if method == 'POST' else None)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def sign(token, ts, nonce):
    keyed = hashlib.md5(token[:16].encode()).hexdigest()
    return hashlib.md5((keyed + str(ts) + nonce).encode()).hexdigest()


def handshake(ip, log):
    info = http_json('http://%s:18910/info' % ip)
    log('info', redact(info))
    if info.get('ctrlType') == 'cloud':
        raise SystemExit('LAN mode is off (ctrlType "cloud"). Turn it on at the printer: Settings > Network > LAN Mode.')
    if info.get('ctrlType') not in (None, 'lan'):
        print('Note: ctrlType is %r, not "lan". Trying anyway.' % info.get('ctrlType'))
    token = info.get('token') or ''
    if len(token) != 32:
        raise SystemExit('The /info answer has no usable token; saved what it sent to the output file.')
    ts = int(time.time() * 1000)
    nonce = ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(6))
    did = ''.join(random.choice(string.ascii_uppercase + string.digits) for _ in range(32))
    url = info['ctrlInfoUrl']
    url += ('&' if '?' in url else '?') + 'ts=%d&nonce=%s&sign=%s&did=%s' % (ts, nonce, sign(token, ts, nonce), did)
    ctrl = http_json(url, method='POST')
    log('ctrl', redact(ctrl))
    data = ctrl.get('data') or {}
    if ctrl.get('code') != 200 or not data.get('info'):
        raise SystemExit('The printer rejected the control request: %s' % ctrl.get('message'))
    iv = str(data.get('token') or '').encode()[:16].ljust(16, b'\0')
    plain = aes.cbc_decrypt(base64.b64decode(data['info']), token[16:32].encode(), iv)
    creds = json.loads(plain.decode('utf-8'))
    log('credentials', redact(creds))
    return info, creds


def tls_context():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        ctx.set_ciphers('DEFAULT:@SECLEVEL=0')  # P1 certificates are RSA-1024 / SHA-1
    except ssl.SSLError:
        pass
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', DeprecationWarning)
        try:
            ctx.minimum_version = ssl.TLSVersion.TLSv1   # old printer firmware
        except (AttributeError, ValueError):
            pass
    return ctx


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('ip')
    ap.add_argument('--seconds', type=int, default=120)
    ap.add_argument('--out', default='anycubic-probe-%d.jsonl' % int(time.time()))
    a = ap.parse_args()

    out = open(a.out, 'w', encoding='utf-8')

    def log(kind, data):
        out.write(json.dumps({'t': round(time.time(), 3), 'kind': kind, 'data': data}) + '\n')
        out.flush()
        print('[%s] %s' % (kind, json.dumps(data)[:200]))

    info, creds = handshake(a.ip, log)
    model, device = info.get('modelId'), creds.get('deviceId')
    broker = str(creds.get('broker') or '')
    port = int(broker.rsplit(':', 1)[1]) if broker.count(':') >= 2 else 9883
    ports = [port] + [p for p in (8883, 9883) if p != port]
    client_id = creds.get('clientId') or 'obs-print-progress-%d' % int(time.time())

    sock = None
    for p in ports:
        try:
            raw = socket.create_connection((a.ip, p), timeout=10)
            sock = tls_context().wrap_socket(raw)
            log('tls', {'port': p, 'version': sock.version(), 'cipher': sock.cipher()[0]})
            break
        except (OSError, ssl.SSLError) as err:
            log('tls-failed', {'port': p, 'error': str(err)})
    if not sock:
        raise SystemExit('Could not open a TLS connection to the broker. Output saved to %s' % a.out)

    rx = lambda n: recv_exact(sock, n)  # noqa: E731
    sock.sendall(mqtt.connect_packet(client_id, creds.get('username'), creds.get('password'), keepalive=60))
    ptype, _, body = mqtt.read_packet(rx)
    log('connack', {'type': ptype, 'code': body[1] if len(body) > 1 else None})
    if ptype != mqtt.CONNACK or len(body) < 2 or body[1] != 0:
        raise SystemExit('Broker refused the MQTT connection. Output saved to %s' % a.out)

    topics = ['%s/printer/public/%s/%s/#' % (PREFIX, model, device), '%s/#' % PREFIX]
    for i, t in enumerate(topics, 1):
        sock.sendall(mqtt.subscribe_packet(i, t))

    def query_all():
        for side in ('pc', 'web'):
            for q in QUERIES:
                topic = '%s/%s/printer/%s/%s/%s' % (PREFIX, side, model, device, q)
                payload = {'type': q, 'action': 'query', 'timestamp': int(time.time() * 1000),
                           'msgid': '%032x' % random.getrandbits(128), 'data': None}
                sock.sendall(mqtt.publish_packet(topic, json.dumps(payload)))

    query_all()
    sock.settimeout(1.0)
    end, last_query, last_ping = time.time() + a.seconds, time.time(), time.time()
    count = 0
    while time.time() < end:
        if time.time() - last_ping > 30:
            sock.sendall(mqtt.PINGREQ_PACKET)
            last_ping = time.time()
        if time.time() - last_query > 30:
            query_all()
            last_query = time.time()
        try:
            ptype, flags, body = mqtt.read_packet(rx)
        except socket.timeout:
            continue
        if ptype == mqtt.SUBACK:
            log('suback', {'codes': list(body[2:])})
        elif ptype == mqtt.PUBLISH:
            topic, payload = mqtt.parse_publish(flags, body)
            try:
                data = redact(json.loads(payload.decode('utf-8')))
            except ValueError:
                data = {'raw': payload[:2000].decode('utf-8', 'replace')}
            log('message', {'topic': topic.replace(str(device), '<device>'), 'payload': data})
            count += 1
    sock.sendall(mqtt.DISCONNECT_PACKET)
    sock.close()
    print('Recorded %d messages in %s' % (count, a.out))


if __name__ == '__main__':
    main()
