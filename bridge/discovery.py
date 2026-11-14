"""Find printers on the local network.

- Bambu Lab printers announce themselves with SSDP-style NOTIFY broadcasts
  on UDP port 2021 every few seconds.
- Elegoo SDCP printers answer a "M99999" UDP broadcast on port 3000.
- Moonraker printers are probed on a short list of common hostnames, and
  the local /24 subnet is swept for Moonraker (port 7125) and PrusaLink
  (port 80, answers /api/version with a "Printer API" digest challenge),
  and Anycubic printers are spotted by their port-18910 /info document.
"""

import json
import socket
import threading
import time
import ipaddress
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FuturesTimeout

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
        machine = '%s %s' % (d.get('MachineName') or '', d.get('Name') or '')
        resin = any(w in machine.lower() for w in ('saturn', 'mars', 'jupiter'))
        results[('elegoo', addr[0])] = {
            'type': 'elegoo-resin' if resin else 'elegoo-cc', 'ip': d.get('MainboardIP') or addr[0],
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


def local_ipv4():
    """This computer's LAN address (no packets are sent)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('192.0.2.1', 9))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def port_open(ip, port, timeout=0.6):
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def _hostname(ip):
    try:
        return socket.gethostbyaddr(ip)[0]
    except OSError:
        return ''


def probe_host(ip, ports=None):
    """Identify a Moonraker, Anycubic or PrusaLink printer at `ip`, or None.
    `ports` is the set of ports already known to be open (from the sweep);
    without it each port is tried here."""
    def is_open(port):
        return port in ports if ports is not None else port_open(ip, port)

    if is_open(7125):
        try:
            with urllib.request.urlopen('http://%s:7125/server/info' % ip, timeout=2) as r:
                if 'result' in json.loads(r.read().decode('utf-8')):
                    # Klipper knows its own hostname; DNS names are added
                    # afterwards by name_results() when they come back quickly.
                    name = ip
                    try:
                        with urllib.request.urlopen('http://%s:7125/printer/info' % ip, timeout=2) as r2:
                            name = (json.loads(r2.read().decode('utf-8')).get('result') or {}).get('hostname') or ip
                    except Exception:
                        pass
                    return {'type': 'klipper', 'ip': ip, 'name': name}
        except Exception:
            pass
    if is_open(18910):
        # Anycubic: the LAN-mode discovery document answers even in cloud mode.
        try:
            with urllib.request.urlopen('http://%s:18910/info' % ip, timeout=3) as r:
                info = json.loads(r.read().decode('utf-8'))
            if isinstance(info, dict) and ('modelId' in info or 'ctrlType' in info):
                return {'type': 'anycubic', 'ip': ip, 'name': info.get('modelName') or 'Anycubic printer',
                        'model': info.get('modelName') or '', 'lanMode': info.get('ctrlType') == 'lan',
                        'supported': False}
        except Exception:
            pass
    if is_open(80):
        try:
            urllib.request.urlopen('http://%s/api/version' % ip, timeout=2).close()
        except urllib.error.HTTPError as err:
            if err.code == 401 and 'printer api' in (err.headers.get('WWW-Authenticate') or '').lower():
                return {'type': 'prusalink', 'ip': ip, 'name': 'Prusa printer'}
        except Exception:
            pass
    return None


SWEEP_PORTS = (7125, 18910, 80)
SOCKETS_PER_BATCH = 200   # stays under select()'s 512-socket limit on Windows


def _connect_batch(targets, timeout, opened, refused):
    """Start non-blocking connects to every (ip, port) and wait up to
    `timeout` for them together. Fills `opened` and `refused`."""
    import select
    pending = {}
    for t in targets:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setblocking(False)
        try:
            s.connect_ex(t)
        except OSError:
            s.close()
            continue
        pending[s] = t
    end = _deadline(timeout)
    try:
        while pending and _remaining(end) > 0:
            socks = list(pending)
            try:
                _, writable, failed = select.select([], socks, socks, max(0.0, _remaining(end)))
            except (OSError, ValueError):
                break
            for s in set(writable) | set(failed):
                t = pending.pop(s, None)
                if t is None:
                    continue
                err = s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR)
                (opened if err == 0 and s not in failed else refused).add(t)
                s.close()
    finally:
        for s in pending:
            s.close()


def open_ports(hosts, ports=SWEEP_PORTS, passes=((1.0,), (2.0,))):
    """{ip: {open ports}} for the given hosts.

    All connection attempts run at once (no thread per host). Attempts that
    get no answer at all are retried in a second, longer pass: on a busy
    LAN (Windows especially) the first burst is spent resolving ARP, and a
    printer that is really there can miss a short timeout."""
    opened, refused = set(), set()
    todo = [(ip, p) for ip in hosts for p in ports]
    for (timeout,) in passes:
        if not todo:
            break
        batches = [todo[i:i + SOCKETS_PER_BATCH] for i in range(0, len(todo), SOCKETS_PER_BATCH)]
        threads = [threading.Thread(target=_connect_batch, args=(b, timeout, opened, refused), daemon=True)
                   for b in batches]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout + 1)
        todo = [t for t in todo if t not in opened and t not in refused]
    found = {}
    for ip, p in opened:
        found.setdefault(ip, set()).add(p)
    return found


def scan_subnet(results, timeout=9.0):
    me = local_ipv4()
    if not me or not ipaddress.ip_address(me).is_private:
        return
    net = ipaddress.ip_network(me + '/24', strict=False)
    hosts = [str(h) for h in net.hosts() if str(h) != me]
    end = _deadline(timeout)
    live = open_ports(hosts)
    hits = []
    pool = ThreadPoolExecutor(max_workers=32)
    try:
        futures = {pool.submit(probe_host, ip, ports): ip for ip, ports in live.items()}
        for fut in as_completed(futures, timeout=max(0.1, _remaining(end))):
            found = fut.result()
            if found:
                # Publish right away, keyed by the numeric IP (the key other
                # probes use), so hits survive even if discover() stops waiting.
                results[(found['type'], futures[fut])] = found
                hits.append(found)
    except FuturesTimeout:
        pass
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    name_results(hits)  # renames the published dicts in place


def name_results(hits, timeout=1.5):
    """Give sweep hits their DNS names, in parallel and time-boxed: some
    routers take ~15 s per reverse lookup, and the IP works just as well.
    Klipper printers use the name as their address (stable across DHCP)."""
    names = {}

    def lookup(ip):
        names[ip] = _hostname(ip)

    threads = [threading.Thread(target=lookup, args=(h['ip'],), daemon=True) for h in hits]
    for t in threads:
        t.start()
    end = _deadline(timeout)
    for t in threads:
        t.join(max(0.0, _remaining(end)))
    for h in hits:
        host = names.get(h['ip']) or ''
        if not host:
            continue
        short = host.split('.')[0]
        if h['type'] == 'klipper':
            if h['name'] in ('', h['ip']):
                h['name'] = short
            h['ip'] = host
        elif h['name'] in ('Prusa printer', h['ip']):
            h['name'] = short


COMMON_HOSTS = ('mainsailos.local', 'fluiddpi.local', 'voron.local', 'klipper.local', 'printer.local',
                'snapmaker.local', 'u1.local')


def discover(seconds=5.0):
    results = {}
    jobs = [
        threading.Thread(target=listen_bambu, args=(seconds, results), daemon=True),
        threading.Thread(target=probe_elegoo, args=(min(seconds, 3.0), results), daemon=True),
        threading.Thread(target=probe_moonraker, args=(COMMON_HOSTS, results), daemon=True),
        threading.Thread(target=scan_subnet, args=(results,), daemon=True),
    ]
    for j in jobs:
        j.start()
    end = _deadline(max(seconds, 9.0) + 3)
    for j in jobs:
        j.join(max(0.0, _remaining(end)))
    return sorted(dict(results).values(), key=lambda r: (r['type'], r['ip']))


def _resolve(host):
    host = (host or '').split('://')[-1].split('/')[0]
    host = host.rsplit(':', 1)[0] if host.count(':') == 1 else host
    try:
        return socket.gethostbyname(host) if host else ''
    except OSError:
        return host


def mark_known(found, saved):
    """Flag discovered printers that are already configured (same address,
    by name or by resolved IP), so the setup page only offers new ones."""
    addrs = {str(p.get('ip') or '') for p in saved} | {f['ip'] for f in found}
    resolved = {}

    def lookup(a):
        resolved[a] = _resolve(a)

    # Time-boxed and parallel: DNS on some home networks is very slow.
    threads = [threading.Thread(target=lookup, args=(a,), daemon=True) for a in addrs]
    for t in threads:
        t.start()
    end = _deadline(2.0)
    for t in threads:
        t.join(max(0.0, _remaining(end)))
    known = set()
    for p in saved:
        ip = str(p.get('ip') or '')
        known.add(ip.lower())
        known.add(resolved.get(ip) or ip.lower())
    for f in found:
        f['known'] = f['ip'].lower() in known or (resolved.get(f['ip']) or f['ip']) in known
    return found


def _deadline(seconds):
    return time.time() + seconds


def _remaining(end):
    return end - time.time()
