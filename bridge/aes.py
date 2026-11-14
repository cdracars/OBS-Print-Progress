"""AES-128-CBC decryption in pure Python (standard library only).

Only used to decrypt a few hundred bytes of broker credentials during the
Anycubic LAN-mode handshake, so speed doesn't matter.
"""


def _xtime(a):
    a <<= 1
    return (a ^ 0x11B) if a & 0x100 else a


def _mul(a, b):
    out = 0
    while b:
        if b & 1:
            out ^= a
        a = _xtime(a)
        b >>= 1
    return out


def _build_sbox():
    sbox = [0] * 256
    p = q = 1
    while True:
        # p iterates over the multiplicative group, q is its inverse
        p = p ^ ((p << 1) & 0xFF) ^ (0x1B if p & 0x80 else 0)
        q ^= q << 1
        q ^= q << 2
        q ^= q << 4
        q &= 0xFF
        if q & 0x80:
            q ^= 0x09
        x = q ^ ((q << 1) | (q >> 7)) & 0xFF ^ ((q << 2) | (q >> 6)) & 0xFF ^ ((q << 3) | (q >> 5)) & 0xFF \
            ^ ((q << 4) | (q >> 4)) & 0xFF
        sbox[p] = (x ^ 0x63) & 0xFF
        if p == 1:
            break
    sbox[0] = 0x63
    return sbox


SBOX = _build_sbox()
INV_SBOX = [0] * 256
for _i, _v in enumerate(SBOX):
    INV_SBOX[_v] = _i


def expand_key(key):
    if len(key) != 16:
        raise ValueError('AES-128 needs a 16-byte key')
    words = [list(key[i:i + 4]) for i in range(0, 16, 4)]
    rcon = 1
    for i in range(4, 44):
        w = list(words[i - 1])
        if i % 4 == 0:
            w = w[1:] + w[:1]
            w = [SBOX[b] for b in w]
            w[0] ^= rcon
            rcon = _xtime(rcon) & 0xFF
        words.append([a ^ b for a, b in zip(words[i - 4], w)])
    return [sum(words[r * 4:r * 4 + 4], []) for r in range(11)]


def decrypt_block(block, round_keys):
    s = [b ^ k for b, k in zip(block, round_keys[10])]
    for rnd in range(9, -1, -1):
        # inverse shift rows (state is column-major: s[r + 4c])
        s = [s[(r + 4 * ((c - r) % 4))] for c in range(4) for r in range(4)]
        s = [INV_SBOX[b] for b in s]
        s = [b ^ k for b, k in zip(s, round_keys[rnd])]
        if rnd:
            out = []
            for c in range(4):
                a = s[4 * c:4 * c + 4]
                out += [
                    _mul(a[0], 14) ^ _mul(a[1], 11) ^ _mul(a[2], 13) ^ _mul(a[3], 9),
                    _mul(a[0], 9) ^ _mul(a[1], 14) ^ _mul(a[2], 11) ^ _mul(a[3], 13),
                    _mul(a[0], 13) ^ _mul(a[1], 9) ^ _mul(a[2], 14) ^ _mul(a[3], 11),
                    _mul(a[0], 11) ^ _mul(a[1], 13) ^ _mul(a[2], 9) ^ _mul(a[3], 14),
                ]
            s = out
    return bytes(s)


def cbc_decrypt(ciphertext, key, iv, unpad=True):
    """AES-128-CBC decrypt; strips PKCS#7 padding when `unpad` is set."""
    if len(ciphertext) % 16 or len(iv) != 16:
        raise ValueError('ciphertext must be whole 16-byte blocks and the IV 16 bytes')
    rk = expand_key(bytes(key))
    out, prev = bytearray(), bytes(iv)
    for i in range(0, len(ciphertext), 16):
        block = ciphertext[i:i + 16]
        out += bytes(a ^ b for a, b in zip(decrypt_block(block, rk), prev))
        prev = block
    if unpad:
        n = out[-1] if out else 0
        if not 1 <= n <= 16 or out[-n:] != bytes([n]) * n:
            raise ValueError('bad padding')
        del out[-n:]
    return bytes(out)
