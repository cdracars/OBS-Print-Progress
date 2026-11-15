"""Fleet inventory and observations. Secrets remain in the existing config store.

This module owns stable equipment identity; a cached UI read is not an observation.
"""
import json
import hashlib
import math
import sqlite3
import threading
import time
import uuid
import re
from contextlib import contextmanager
from urllib.parse import urlsplit, urlunsplit
from .base import CommandRejected


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def public_address(value):
    """An endpoint label, never a credential-bearing URL."""
    try:
        p = urlsplit(value if '://' in value else 'http://' + value)
        host = p.hostname or ''
        return host + (':%d' % p.port if p.port else '')
    except (ValueError, TypeError):
        return ''


class Dashboard:
    CLASSES = ('printer', 'host', 'camera', 'deployment', 'application', 'business_service', 'offering', 'technology_service')
    RELATIONS = {'controls': ('host', 'printer'), 'observes': ('camera', 'printer'),
                 'runs_on': ('deployment', 'host'), 'realized_by': ('application', 'deployment'),
                 'has_offering': ('business_service', 'offering'), 'supports': (None, None), 'monitors': ('deployment', 'printer')}
    def __init__(self, path, clock=time.time):
        self.path, self.clock = path, clock
        self.lock = threading.RLock()
        self.last_states = {}
        self.command_locks = {}
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS equipment (
                    ci_id TEXT PRIMARY KEY, alias TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL,
                    ci_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS commands (
                    request_id TEXT PRIMARY KEY, data TEXT NOT NULL);
            ''')
            db.execute("UPDATE commands SET data=json_set(data,'$.outcome','unknown','$.message',?) WHERE json_extract(data,'$.outcome') IN ('pending','accepted')",
                       ('Host restarted; command was not retried. Inspect the printer.',))

    @contextmanager
    def db(self):
        connection = sqlite3.connect(self.path, timeout=10)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def items(self):
        with self.lock, self.db() as db:
            return [json.loads(row[0]) for row in db.execute('SELECT data FROM equipment ORDER BY rowid')]

    def create_item(self, data):
        if data.get('class') not in self.CLASSES:
            raise ValueError('Choose a known equipment or service class')
        name = str(data.get('name') or '').strip()[:120]
        if not name:
            raise ValueError('A record name is required')
        ci_id = str(uuid.uuid4())
        item = {'ci_id': ci_id, 'id': 'record-' + ci_id[:12], 'class': data['class'],
                'type': str(data.get('type') or data['class'])[:50], 'name': name,
                'owner': str(data.get('owner') or '')[:120], 'location': str(data.get('location') or '')[:120],
                'lifecycle': 'planned', 'created_at': self.clock(), 'revision': 1,
                'controls_enabled': False, 'evidence': '', 'relationships': []}
        with self.lock, self.db() as db:
            db.execute('INSERT INTO equipment VALUES (?,?,?)', (ci_id, item['id'], json.dumps(item)))
            self._record(db, ci_id, 'record_created', {'name': name, 'class': data['class']})
        return item

    def validate_relationships(self, source, relationships, items):
        if not isinstance(relationships, list) or len(relationships) > 50:
            raise ValueError('Expected at most 50 relationships')
        by_id = {i['ci_id']: i for i in items}
        clean, seen = [], set()
        for relationship in relationships:
            if not isinstance(relationship, dict):
                raise ValueError('Expected relationship records')
            kind, target = relationship.get('type'), by_id.get(relationship.get('target'))
            if kind not in self.RELATIONS or not target or target['ci_id'] == source['ci_id']:
                raise ValueError('Relationship needs a valid type and a different existing target')
            left, right = self.RELATIONS[kind]
            if left and source['class'] != left or right and target['class'] != right:
                raise ValueError('Relationship does not fit these equipment classes')
            pair = (kind, target['ci_id'])
            if pair in seen:
                raise ValueError('Duplicate relationship')
            seen.add(pair)
            clean.append({'type': kind, 'target': target['ci_id'], 'source': 'operator',
                          'recorded_at': number(relationship.get('recorded_at')) or self.clock()})
        return clean

    def sync(self, configs):
        with self.lock, self.db() as db:
            for cfg in configs:
                # Fingerprint the configured target, without persisting credentials or serial numbers.
                fingerprint = hashlib.sha256(json.dumps([cfg.get(k, '') for k in ('type', 'ip', 'serial')]).encode()).hexdigest()
                row = db.execute('SELECT data FROM equipment WHERE alias=?', (cfg['id'],)).fetchone()
                if row:
                    item = json.loads(row[0])
                    if item.get('connection_fingerprint') != fingerprint:
                        item.update(connection_fingerprint=fingerprint, controls_enabled=False,
                                    type=cfg.get('type', 'klipper'), revision=item['revision'] + 1)
                        db.execute('UPDATE equipment SET data=? WHERE ci_id=?', (json.dumps(item), item['ci_id']))
                        self._record(db, item['ci_id'], 'connection_changed', {'controls_revoked': True})
                    continue
                item = {'ci_id': str(uuid.uuid4()), 'id': cfg['id'], 'name': cfg.get('name') or cfg['id'],
                        'class': 'printer', 'type': cfg.get('type', 'klipper'), 'owner': '', 'location': '',
                        'connection_fingerprint': fingerprint,
                        'lifecycle': 'active', 'created_at': self.clock(), 'revision': 1,
                        'controls_enabled': False, 'evidence': '', 'relationships': []}
                db.execute('INSERT INTO equipment VALUES (?,?,?)', (item['ci_id'], cfg['id'], json.dumps(item)))
                self._record(db, item['ci_id'], 'enrolled', {'name': item['name'], 'source': 'existing configuration'})

    def _record(self, db, ci_id, kind, data):
        db.execute('INSERT INTO records(at,ci_id,kind,data) VALUES (?,?,?,?)',
                   (self.clock(), ci_id, kind, json.dumps(data)))

    def update_item(self, ci_id, changes):
        with self.lock, self.db() as db:
            row = db.execute('SELECT data FROM equipment WHERE ci_id=?', (ci_id,)).fetchone()
            if not row:
                raise ValueError('Equipment not found')
            item = json.loads(row[0])
            if 'lifecycle' in changes and changes['lifecycle'] not in ('planned', 'active', 'maintenance', 'retired'):
                raise ValueError('Invalid lifecycle')
            for key in ('name', 'owner', 'location', 'lifecycle', 'evidence'):
                if key in changes:
                    item[key] = str(changes[key]).strip()[:500]
            if 'relationships' in changes:
                item['relationships'] = self.validate_relationships(item, changes['relationships'], self.items())
            if not item['name']:
                raise ValueError('A display name is required')
            item['revision'] += 1
            db.execute('UPDATE equipment SET data=? WHERE ci_id=?', (json.dumps(item), ci_id))
            self._record(db, ci_id, 'configuration', {'revision': item['revision'], 'fields': sorted(changes)})
            return item

    def events(self, limit=100):
        names = {i['ci_id']: i['name'] for i in self.items()}
        with self.lock, self.db() as db:
            return [{'id': r[0], 'at': r[1], 'ci_id': r[2], 'kind': r[3], 'data': json.loads(r[4]),
                     'name': names.get(r[2], 'Workshop')} for r in db.execute(
                         'SELECT id,at,ci_id,kind,data FROM records ORDER BY id DESC LIMIT ?', (limit,))]

    def export_inventory(self):
        return {'schema': 'printdesk-inventory/1', 'exported_at': self.clock(), 'equipment': self.items(),
                'note': 'No connection credentials. Import restores equipment metadata, not printer connections.'}

    def preview_import(self, doc):
        if not isinstance(doc, dict) or doc.get('schema') != 'printdesk-inventory/1' or not isinstance(doc.get('equipment'), list):
            raise ValueError('Expected a Print Desk inventory export')
        if len(doc['equipment']) > 500:
            raise ValueError('Inventory is too large')
        existing = self.items()
        by_id = {x['ci_id']: x for x in existing}
        by_alias = {x['id']: x for x in existing}
        seen_ids, seen_aliases = set(), set()
        clean = []
        for raw in doc['equipment']:
            if not isinstance(raw, dict):
                raise ValueError('Invalid equipment record')
            ci_id, alias = raw.get('ci_id'), raw.get('id')
            if not isinstance(ci_id, str) or not isinstance(alias, str) or not ci_id or not alias or len(alias) > 120 or len(ci_id) > 100:
                raise ValueError('Every item needs an identity and OBS alias')
            if ci_id in seen_ids or alias in seen_aliases:
                raise ValueError('Duplicate identity or OBS alias')
            if alias in by_alias and by_alias[alias]['ci_id'] != ci_id or ci_id in by_id and by_id[ci_id]['id'] != alias:
                raise ValueError('Identity conflict: reconcile this equipment before import')
            seen_ids.add(ci_id)
            seen_aliases.add(alias)
            item = {k: str(raw.get(k) or '')[:500] for k in ('name', 'owner', 'location', 'evidence')}
            if not item['name'] or raw.get('lifecycle') not in ('planned', 'active', 'maintenance', 'retired'):
                raise ValueError('Invalid equipment name or lifecycle')
            item.update(ci_id=ci_id, id=alias, type=str(raw.get('type') or 'unknown')[:50],
                        lifecycle=raw['lifecycle'], revision=(by_id.get(ci_id) or {}).get('revision', 0) + 1,
                        created_at=number(raw.get('created_at')) or self.clock(),
                        controls_enabled=False, relationships=raw.get('relationships') or [],
                        **{'class': raw.get('class', 'printer')})
            if item['class'] not in self.CLASSES:
                raise ValueError('Unknown equipment class')
            # Imports never grant physical control permission or introduce arbitrary dependency edges.
            clean.append(item)
        for item in clean:
            item['relationships'] = self.validate_relationships(item, item['relationships'], existing + clean)
        return clean

    def import_inventory(self, doc):
        with self.lock:
            clean = self.preview_import(doc)
            with self.db() as db:
                for item in clean:
                    db.execute('INSERT OR REPLACE INTO equipment VALUES (?,?,?)',
                               (item['ci_id'], item['id'], json.dumps(item)))
                    self._record(db, item['ci_id'], 'inventory_import', {'revision': item['revision']})
            return {'imported': len(clean)}

    def enable_controls(self, ci_id, enabled):
        with self.lock, self.db() as db:
            row = db.execute('SELECT data FROM equipment WHERE ci_id=?', (ci_id,)).fetchone()
            if not row:
                raise ValueError('Equipment not found')
            item = json.loads(row[0])
            if enabled and not item.get('evidence'):
                raise ValueError('Record model/firmware and supervised-use evidence in Equipment first')
            item['controls_enabled'] = bool(enabled)
            item['revision'] += 1
            db.execute('UPDATE equipment SET data=? WHERE ci_id=?', (json.dumps(item), ci_id))
            self._record(db, ci_id, 'control_permission', {'enabled': bool(enabled), 'revision': item['revision']})
            return item

    def get_command(self, request_id):
        with self.lock, self.db() as db:
            row = db.execute('SELECT data FROM commands WHERE request_id=?', (request_id,)).fetchone()
            return json.loads(row[0]) if row else None

    def _save_command(self, command):
        with self.lock, self.db() as db:
            db.execute('INSERT OR REPLACE INTO commands VALUES (?,?)', (command['request_id'], json.dumps(command)))
            self._record(db, command['ci_id'], 'command', {k: command[k] for k in ('request_id', 'action', 'outcome')})

    def command(self, request, configs, adapters):
        request_id = request.get('request_id')
        if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', request_id):
            raise ValueError('A bounded unique request ID is required')
        ci_id = request.get('ci_id')
        with self.lock:
            operation_lock = self.command_locks.setdefault('dispatch', threading.Lock())
        with operation_lock:
            previous = self.get_command(request_id)
            if previous:
                if any(previous.get(k) != request.get(k) for k in ('ci_id', 'id', 'action', 'job_token')):
                    raise ValueError('This request ID already belongs to another operation')
                return previous
            cards = self.fleet(configs, adapters)['printers']
            card = next((c for c in cards if c['ci_id'] == ci_id and c['id'] == request.get('id')), None)
            if not card or request.get('action') not in card['capabilities']['actions']:
                raise ValueError('This action is not currently permitted for this printer')
            if not request.get('job_token') or request['job_token'] != card['job']['token']:
                raise ValueError('The job changed. Inspect the printer and confirm the action again.')
            adapter = adapters[card['id']]
            if hasattr(adapter, 'refresh_for_command'):
                adapter.refresh_for_command()
                card = next(c for c in self.fleet(configs, adapters)['printers'] if c['ci_id'] == ci_id)
                if request['job_token'] != card['job']['token'] or request['action'] not in card['capabilities']['actions']:
                    raise ValueError('The printer state changed before dispatch. Review the current job.')
            command = {k: request[k] for k in ('request_id', 'ci_id', 'id', 'action', 'job_token')}
            command.update(at=self.clock(), outcome='pending', message='Recorded before dispatch; never automatically retried.')
            self._save_command(command)
            try:
                if hasattr(adapter, 'perform_checked_command'):
                    adapter.perform_checked_command(command['action'], command['job_token'])
                else:
                    adapter.perform_command(command['action'])
                command.update(outcome='accepted', message='Sent; waiting for a fresh observation of the requested state.')
            except CommandRejected as err:
                command.update(outcome='failed', message=str(err))
            except Exception:
                # A transport failure can happen after the machine accepted the operation.
                command.update(outcome='unknown', message='Delivery or response was uncertain. Inspect the printer; this request will not be retried.')
            self._save_command(command)
            return command

    def reconcile_commands(self, cards):
        by_id = {c['ci_id']: c for c in cards}
        with self.lock, self.db() as db:
            commands = [json.loads(r[0]) for r in db.execute('SELECT data FROM commands')]
            for command in commands:
                card = by_id.get(command['ci_id'])
                if not card:
                    continue
                if command['outcome'] in ('accepted', 'unknown'):
                    expected = {'pause': ('paused',), 'resume': ('printing',), 'cancel': ('cancelled', 'standby')}.get(command['action'], ())
                    newer = (card['connection']['observed_at'] or 0) > command['at']
                    if newer and not card['connection']['stale'] and card['job']['token'] == command['job_token'] and card['job']['state'] in expected:
                        command.update(outcome='confirmed', message='The same observed job reached the requested state; no automatic retry was sent.')
                        db.execute('UPDATE commands SET data=? WHERE request_id=?', (json.dumps(command), command['request_id']))
                        self._record(db, command['ci_id'], 'command', {'action': command['action'], 'outcome': 'confirmed'})
                    elif command['outcome'] == 'accepted' and self.clock() - command['at'] > 15:
                        command.update(outcome='unknown', message='No confirming observation in 15 seconds. Inspect the printer; no retry was sent.')
                        db.execute('UPDATE commands SET data=? WHERE request_id=?', (json.dumps(command), command['request_id']))
                if not card.get('last_command') or card['last_command']['at'] <= command['at']:
                    card['last_command'] = command

    def fleet(self, configs, adapters):
        self.sync(configs)
        by_alias = {c['id']: c for c in configs}
        cards = []
        now = self.clock()
        for item in self.items():
            if item['class'] != 'printer':
                continue
            cfg = by_alias.get(item['id'], {})
            adapter = adapters.get(item['id'])
            state = adapter.snapshot() if adapter else {}
            observed = state.get('_observed_at')
            if state.get('state') in ('printing', 'paused') and state.get('_job_observed_at') is not None:
                observed = min(observed or state['_job_observed_at'], state['_job_observed_at'])
            age = max(0, now - observed) if observed is not None else None
            threshold = max(15, 3 * (number(cfg.get('updateInterval')) or 5000) / 1000)
            stale = age is None or age > threshold
            connection = 'online' if state.get('online') else 'offline'
            if connection == 'online' and stale:
                connection = 'stale'
            if getattr(adapter, 'released', False):
                connection = 'released'
            message = str(state.get('message') or '')
            for secret in (cfg.get('accessCode'), cfg.get('camera')):
                if secret:
                    message = message.replace(str(secret), '[private]')
            available = bool(adapter and hasattr(adapter, 'perform_command') and item.get('controls_enabled') and
                             connection == 'online' and item['lifecycle'] not in ('retired', 'planned'))
            actions = []
            if available:
                if state.get('state') == 'printing':
                    actions = ['pause', 'cancel']
                elif state.get('state') == 'paused':
                    actions = ['resume', 'cancel'] if item['lifecycle'] != 'maintenance' else ['cancel']
            reason = 'Operator enabled for supervised use; physical qualification is not asserted.' if item.get('controls_enabled') else 'Supervised controls are disabled. Enable explicitly after checking the target and recording evidence.'
            if connection != 'online':
                reason = 'Controls unavailable while the printer observation is offline or stale.'
            capable_camera = bool(adapter and (cfg.get('camera') or cfg.get('ip') and item['type'] in ('klipper', 'snapmaker-u1', 'elegoo-cc')))
            status_key = (connection, state.get('state'), item['lifecycle'])
            previous = self.last_states.get(item['ci_id'])
            if previous != status_key:
                with self.lock, self.db() as db:
                    self._record(db, item['ci_id'], 'state_observed', {'connection': connection,
                                 'job_state': state.get('state', 'unknown'), 'previous': previous})
                self.last_states[item['ci_id']] = status_key
            cards.append(dict(item, technology='resin' if item['type'] in ('elegoo-resin', 'anycubic-p1') else 'filament',
                              endpoint=public_address(cfg.get('ip', '')), configured=bool(cfg),
                              connection={'state': connection, 'observed_at': observed, 'stale': stale, 'age': age, 'message': message},
                              job={'state': state.get('state', 'unknown'), 'filename': state.get('filename') or '',
                                   'progress': number(state.get('progress')) if observed is not None else None, 'elapsed': number(state.get('elapsed')),
                                   'remaining': number(state.get('remaining')), 'layer': state.get('layer'),
                                   'total_layers': state.get('total_layers'), 'token': state.get('_job_token')},
                              readings={k: number(state.get(k)) for k in
                                        ('nozzle', 'nozzle_target', 'bed', 'bed_target', 'chamber', 'chamber_target')},
                              capabilities={'monitoring': 'documented / physical qualification not asserted',
                                            'controls': bool(actions), 'actions': actions, 'control_reason': reason,
                                            'controls_enabled': bool(item.get('controls_enabled')),
                                            'can_enable': bool(adapter and hasattr(adapter, 'perform_command') and not item.get('controls_enabled')),
                                            'toolpath': item['type'] in ('klipper', 'snapmaker-u1', 'bambu', 'elegoo-cc')},
                              native_url=('http://' + public_address(cfg.get('ip', '')) + '/') if item['type'] in ('klipper', 'snapmaker-u1', 'elegoo-cc') and cfg.get('ip') else None,
                              camera={'available': capable_camera, 'url': '/api/camera/%s' % item['id']}))
        self.reconcile_commands(cards)
        return {'printers': cards, 'equipment': self.items(), 'generated_at': now, 'mode': 'live', 'version': 1}
