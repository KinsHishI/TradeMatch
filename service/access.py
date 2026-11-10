"""Explicit, fail-closed access policy for the invitation-only demo deployment."""
from dataclasses import dataclass, field
import hashlib
import hmac
import re
import secrets
import threading
import time
from urllib.parse import urlsplit


@dataclass(frozen=True)
class DeploymentAccess:
    origin: str
    username: str
    password: str = field(repr=False)

    def __post_init__(self):
        url = urlsplit(self.origin)
        if (url.scheme != 'https' or not url.hostname or url.username or url.password
                or url.path not in {'', '/'} or url.query or url.fragment
                or not re.fullmatch(r'[A-Za-z0-9.-]+', url.hostname)):
            raise ValueError('TRADEMATCH_PUBLIC_URL에는 HTTPS 서비스 주소만 지정하세요.')
        if not self.username or ':' in self.username or len(self.password) < 16:
            raise ValueError('접속 사용자 이름과 16자 이상의 시연용 암호가 필요합니다.')
        port = url.port
        authority = url.hostname.lower() + (f':{port}' if port and port != 443 else '')
        object.__setattr__(self, 'origin', 'https://' + authority)

    def accepts_host(self, host):
        authority = urlsplit(self.origin).netloc
        return host.lower() in {authority, authority + ':443' if ':' not in authority else authority}

    def credentials_valid(self, username, password):
        user_ok = hmac.compare_digest(username.strip().casefold().encode(), self.username.casefold().encode())
        password_ok = hmac.compare_digest(password.encode(), self.password.encode())
        return user_ok & password_ok

    @staticmethod
    def restricted(path):
        return (path in {'/workspace', '/api/settings', '/api/retrieve', '/api/report', '/api/demo', '/api/demo/load'}
                or path.startswith('/api/samples/'))


SESSION_COOKIE = '__Host-tradematch_session'
SESSION_SECONDS = 12 * 60 * 60


class LoginSessions:
    """Bounded, revocable sessions; no password or session token is written to disk."""
    def __init__(self, *, clock=time.monotonic):
        self.clock = clock
        self.lock = threading.Lock()
        self.sessions = {}
        self.attempts = {}

    def _prune(self):
        now = self.clock()
        self.sessions = {key: expiry for key, expiry in self.sessions.items() if expiry > now}
        self.attempts = {key: value for key, value in self.attempts.items() if value[1] > now}

    def allow_login(self, client):
        with self.lock:
            self._prune()
            count, until = self.attempts.get(client, (0, self.clock() + 60))
            if count >= 10:
                return False
            if client not in self.attempts and len(self.attempts) >= 1024:
                self.attempts.pop(next(iter(self.attempts)))
            self.attempts[client] = (count + 1, until)
            return True

    def issue(self, client):
        token = secrets.token_urlsafe(32)
        with self.lock:
            self._prune()
            self.attempts.pop(client, None)
            if len(self.sessions) >= 256:
                self.sessions.pop(next(iter(self.sessions)))
            self.sessions[hashlib.sha256(token.encode()).hexdigest()] = self.clock() + SESSION_SECONDS
        return token

    def valid(self, token):
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
            return False
        with self.lock:
            self._prune()
            return hashlib.sha256(token.encode()).hexdigest() in self.sessions

    def revoke(self, token):
        with self.lock:
            self.sessions.pop(hashlib.sha256(token.encode()).hexdigest(), None)


def login_target(value):
    if (not isinstance(value, str) or len(value) > 2048 or not value.startswith('/')
            or value.startswith('//') or '\\' in value or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        return '/'
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or parsed.path == '/login':
        return '/'
    return value
