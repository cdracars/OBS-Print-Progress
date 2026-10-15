"""Minimal MQTT 3.1.1 client (just what the Bambu Lab LAN API needs).

QoS 0 publish/subscribe, keepalive pings, no persistence. Packet helpers are
pure functions so they can be unit tested without a broker.
"""

import struct

CONNECT, CONNACK, PUBLISH, SUBSCRIBE, SUBACK, PINGREQ, PINGRESP, DISCONNECT = 1, 2, 3, 8, 9, 12, 13, 14

CONNACK_ERRORS = {
    1: 'unacceptable protocol version',
    2: 'client id rejected',
    3: 'server unavailable',
    4: 'bad username or password (check the access code)',
    5: 'not authorized (check the access code / LAN mode)',
}


def encode_varint(n):
    out = bytearray()
    while True:
        byte = n % 128
        n //= 128
        if n:
            byte |= 0x80
        out.append(byte)
        if not n:
            return bytes(out)


def encode_str(s):
    b = s.encode('utf-8')
    return struct.pack('!H', len(b)) + b


def packet(first_byte, body):
    return bytes([first_byte]) + encode_varint(len(body)) + body


def connect_packet(client_id, username=None, password=None, keepalive=30):
    flags = 0x02  # clean session
    payload = encode_str(client_id)
    if username is not None:
        flags |= 0x80
        payload += encode_str(username)
    if password is not None:
        flags |= 0x40
        payload += encode_str(password)
    var = encode_str('MQTT') + bytes([4, flags]) + struct.pack('!H', keepalive)
    return packet(CONNECT << 4, var + payload)


def subscribe_packet(packet_id, topic, qos=0):
    return packet((SUBSCRIBE << 4) | 0x02, struct.pack('!H', packet_id) + encode_str(topic) + bytes([qos]))


def publish_packet(topic, payload):
    if isinstance(payload, str):
        payload = payload.encode('utf-8')
    return packet(PUBLISH << 4, encode_str(topic) + payload)


PINGREQ_PACKET = bytes([PINGREQ << 4, 0])
DISCONNECT_PACKET = bytes([DISCONNECT << 4, 0])


def read_packet(recv_exact):
    """Read one packet using `recv_exact(n)`. Returns (type, flags, body)."""
    first = recv_exact(1)[0]
    mult, length = 1, 0
    for _ in range(4):
        b = recv_exact(1)[0]
        length += (b & 0x7F) * mult
        if not b & 0x80:
            break
        mult *= 128
    body = recv_exact(length) if length else b''
    return first >> 4, first & 0x0F, body


def parse_publish(flags, body):
    tlen = struct.unpack('!H', body[:2])[0]
    topic = body[2:2 + tlen].decode('utf-8', 'replace')
    pos = 2 + tlen
    if (flags >> 1) & 0x03:  # QoS > 0 carries a packet id
        pos += 2
    return topic, body[pos:]
