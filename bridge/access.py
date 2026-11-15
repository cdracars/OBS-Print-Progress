"""Host-local authentication. No passwords or reusable tokens enter URLs."""
import hashlib
import hmac
import secrets
import threading
import time
from http.cookies import SimpleCookie


class Access:
    def __init__(self, password='', required=False, clock=time.time):
        if required and len(password) < 12:
            raise ValueError('LAN access requires DASHBOARD_PASSWORD with at least 12 characters')
        self.required, self.clock = required, clock
        self.salt = secrets.token_bytes(32)
        self.digest = hashlib.pbkdf2_hmac('sha256', password.encode(), self.salt, 200000)
        self.sessions = {}
        self.lock = threading.Lock()
        self.failures = {}

    def login(self, password, client='local'):
        if not isinstance(password, str) or len(password) > 1000:
            raise ValueError('Invalid password')
        with self.lock:
            now = self.clock()
            failures = [at for at in self.failures.get(client, []) if now - at < 60]
            self.failures[client] = failures
            if len(failures) >= 5:
                raise ValueError('Too many attempts. Wait one minute.')
            candidate = hashlib.pbkdf2_hmac('sha256', password.encode(), self.salt, 200000)
            if not hmac.compare_digest(candidate, self.digest):
                failures.append(now)
                raise ValueError('Incorrect workshop password')
            self.failures.pop(client, None)
            self.sessions = {k: v for k, v in self.sessions.items() if v > now}
            token = secrets.token_urlsafe(32)
            self.sessions[token] = now + 12 * 3600
            return token

    def authorized(self, cookies):
        if not self.required:
            return True
        try:
            cookie = SimpleCookie()
            cookie.load(cookies or '')
            token = cookie['printdesk_session'].value
            with self.lock:
                return self.sessions.get(token, 0) > self.clock()
        except (KeyError, ValueError):
            return False
