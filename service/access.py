"""Explicit, fail-closed access policy for the invitation-only demo deployment."""
import base64
from dataclasses import dataclass, field
import hmac
import re
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

    def authenticated(self, authorization):
        scheme, _, token = authorization.partition(' ')
        expected = base64.b64encode((self.username + ':' + self.password).encode()).decode()
        return scheme.lower() == 'basic' and hmac.compare_digest(token.encode(), expected.encode())

    @staticmethod
    def restricted(path):
        return (path in {'/workspace', '/api/settings', '/api/retrieve', '/api/report', '/api/demo', '/api/demo/load'}
                or path.startswith('/api/samples/'))
