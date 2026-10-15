"""printers.json storage and the sanitized view served to overlays."""

import json
import os
import re
import tempfile

TYPES = ('klipper', 'snapmaker-u1', 'bambu', 'elegoo-cc')
FIELDS = ('id', 'name', 'type', 'ip', 'serial', 'accessCode', 'model', 'mainboardId', 'camera',
          'flipHorizontal', 'flipVertical', 'showChamber', 'updateInterval', 'debug', 'direct')
SECRET_FIELDS = ('accessCode',)
PRIVATE_FIELDS = ('accessCode', 'serial', 'mainboardId', 'type', 'model', 'direct')
MASK = '********'


def slugify(text):
    slug = re.sub(r'[^a-z0-9]+', '-', (text or '').lower()).strip('-')
    return slug or 'printer'


class ConfigStore:
    def __init__(self, path):
        self.path = path

    def load_doc(self):
        try:
            with open(self.path, 'r', encoding='utf-8') as f:
                doc = json.load(f)
        except FileNotFoundError:
            return {'printers': []}
        if isinstance(doc, list):
            doc = {'printers': doc}
        if not isinstance(doc.get('printers'), list):
            doc['printers'] = []
        return doc

    def printers(self):
        out = []
        for p in self.load_doc()['printers']:
            if isinstance(p, dict) and p.get('id'):
                p = dict(p)
                p['type'] = p.get('type') if p.get('type') in TYPES else 'klipper'
                out.append(p)
        return out

    def get(self, pid):
        for p in self.printers():
            if p['id'] == pid:
                return p
        return None

    def save_printers(self, printers):
        doc = self.load_doc()
        doc['printers'] = printers
        folder = os.path.dirname(os.path.abspath(self.path))
        fd, tmp = tempfile.mkstemp(dir=folder, prefix='.printers-', suffix='.json')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(doc, f, indent=2)
            f.write('\n')
        os.replace(tmp, self.path)

    def upsert(self, data, original_id=None):
        """Validate and store a printer. Returns (printer, error)."""
        original_id = original_id or data.get('originalId')
        clean = {k: data[k] for k in FIELDS if k in data and data[k] not in (None, '')}
        clean['type'] = clean.get('type') if clean.get('type') in TYPES else 'klipper'
        clean['name'] = str(clean.get('name') or '').strip() or 'Printer'
        clean['id'] = slugify(clean.get('id') or clean['name'])
        clean['ip'] = re.sub(r'^https?://', '', str(clean.get('ip') or '').strip()).rstrip('/')
        if not clean['ip']:
            return None, 'IP address is required'
        if clean['type'] == 'bambu':
            if not clean.get('serial'):
                return None, 'Bambu printers need the serial number (Settings > Device on the printer)'
            clean['serial'] = str(clean['serial']).strip().upper()

        printers = self.printers()
        existing = next((p for p in printers if p['id'] == original_id), None) if original_id else None
        if not existing:
            # New printer: pick a free id (two "Voron"s become voron, voron-2)
            base, n = clean['id'], 2
            while any(p['id'] == clean['id'] for p in printers):
                clean['id'] = '%s-%d' % (base, n)
                n += 1
        if clean.get('accessCode') in (MASK, None) and existing:
            if existing.get('accessCode'):
                clean['accessCode'] = existing['accessCode']
            else:
                clean.pop('accessCode', None)
        if clean['type'] == 'bambu' and not clean.get('accessCode'):
            return None, 'Bambu printers need the LAN access code (Settings > Network on the printer)'
        if any(p['id'] == clean['id'] for p in printers if p is not existing):
            return None, 'Another printer already uses the id "%s"' % clean['id']

        if existing:
            printers[printers.index(existing)] = clean
        else:
            printers.append(clean)
        self.save_printers(printers)
        return clean, None

    def delete(self, pid):
        printers = self.printers()
        kept = [p for p in printers if p['id'] != pid]
        if len(kept) != len(printers):
            self.save_printers(kept)
            return True
        return False


def masked(printer):
    p = dict(printer)
    for k in SECRET_FIELDS:
        if p.get(k):
            p[k] = MASK
    return p


def overlay_view(printers, host):
    """What overlays get as printers.json: no secrets, and printer addresses
    rewritten to this bridge (same origin, so no CORS setup is needed)."""
    out = []
    for p in printers:
        v = {k: v for k, v in p.items() if k not in PRIVATE_FIELDS}
        if not p.get('direct'):
            v['ip'] = '%s/p/%s' % (host, p['id'])
            if p.get('type') in ('bambu', 'elegoo-cc'):
                v.pop('camera', None)  # always use the bridge's camera stream
                v['websocket'] = False  # translated printers are polled over HTTP
        out.append(v)
    return {'printers': out}
