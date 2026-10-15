"""Find printers on the local network.

- Bambu Lab printers announce themselves with SSDP-style NOTIFY broadcasts
  on UDP port 2021 every few seconds.
- Elegoo SDCP printers answer a "M99999" UDP broadcast on port 3000.
- Moonraker printers are probed on a short list of common hostnames.
"""

import json
import socket
import threading
import time
import urllib.request

BAMBU_MODELS = {
    'BL-P001': 'X1 Carbon', 'BL-P002': 'X1', 'C13': 'X1E', 'C11': 'P1P', 'C12': 'P1S',
    'N1': 'A1 mini', 'N2S': 'A1', 'O1D': 'H2D', 'O1S': 'H2S', 'N7': 'P2S',
}


def parse_ssdp(text):
    headers = {}
    for line in text.split('\r\n')[1:]:
        if ':' in line:
            k, v = line.split(':', 1)
            headers[k.strip().lower()] = v.strip()
    return headers


def bambu_from_ssdp(text, sender_ip):
    h = parse_ssdp(text)
    if 'bambu' not in text.lower() and 'urn:bambulab-com' not in h.get('nt', '').lower():
        return None
    code = h.get('devmodel.bambu.com', '')
    return {
        'type': 'bambu',
        'ip': h.get('location', sender_ip) or sender_ip,
        'serial': h.get('usn', ''),
        'name': h.get('devname.bambu.com') or 'Bambu Lab printer',
        'model': BAMBU_MODELS.get(code, code),
    }


def listen_bambu(seconds, results):
    for port in (2021, 1990):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(('', port))
        except OSError:
            s.close()
            continue
        s.settimeout(0.5)
        end = _deadline(seconds)
        while _remaining(end) > 0:
            try:
                data, addr = s.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            found = bambu_from_ssdp(data.decode('utf-8', 'replace'), addr[0])
            if found:
                results[('bambu', found['ip'])] = found
        s.close()
        return


def probe_elegoo(seconds, results):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.settimeout(0.5)
    try:
        s.sendto(b'M99999', ('255.255.255.255', 3000))
    except OSError:
        s.close()
        return
    end = _deadline(seconds)
    while _remaining(end) > 0:
        try:
            data, addr = s.recvfrom(65536)
        except socket.timeout:
            continue
        except OSError:
            break
        try:
            d = json.loads(data.decode('utf-8', 'replace')).get('Data') or {}
        except ValueError:
            continue
        results[('elegoo', addr[0])] = {
            'type': 'elegoo-cc', 'ip': d.get('MainboardIP') or addr[0],
            'name': d.get('Name') or d.get('MachineName') or 'Elegoo printer',
            'model': d.get('MachineName') or '', 'mainboardId': d.get('MainboardID') or '',
        }
    s.close()


def probe_moonraker(hosts, results):
    def one(host):
        for base, port in (('http://%s' % host, None), ('http://%s:7125' % host, 7125)):
            try:
                with urllib.request.urlopen(base + '/server/info', timeout=2) as r:
                    info = json.loads(r.read().decode('utf-8'))
                if 'result' in info:
                    try:
                        ip = socket.gethostbyname(host)
                    except OSError:
                        ip = host
                    results[('klipper', ip)] = {'type': 'klipper', 'ip': host if port is None else '%s:7125' % host, 'name': host.split('.')[0]}
                    return
            except Exception:
                continue
    threads = [threading.Thread(target=one, args=(h,), daemon=True) for h in hosts]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)


COMMON_HOSTS = ('mainsailos.local', 'fluiddpi.local', 'voron.local', 'klipper.local', 'printer.local',
                'snapmaker.local', 'u1.local')


def discover(seconds=5.0):
    results = {}
    jobs = [
        threading.Thread(target=listen_bambu, args=(seconds, results), daemon=True),
        threading.Thread(target=probe_elegoo, args=(min(seconds, 3.0), results), daemon=True),
        threading.Thread(target=probe_moonraker, args=(COMMON_HOSTS, results), daemon=True),
    ]
    for j in jobs:
        j.start()
    for j in jobs:
        j.join(timeout=seconds + 3)
    return sorted(results.values(), key=lambda r: (r['type'], r['ip']))


def _deadline(seconds):
    return time.time() + seconds


def _remaining(end):
    return end - time.time()
