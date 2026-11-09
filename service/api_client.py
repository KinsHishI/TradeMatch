"""Project-scoped HTTPX client. Credentials stay in memory; POST is never retried."""
from contextlib import nullcontext
from pathlib import Path
import re
import time

import httpx

API = 'https://api.upstage.ai/v2'


class APIError(Exception):
    def __init__(self, message, *, ambiguous=False):
        super().__init__(message)
        self.ambiguous = ambiguous


class UpstageClient:
    def __init__(self, settings, api_key, *, transport=None, sleep=time.sleep):
        self.settings = settings.copy()
        self._sleep = sleep
        if not api_key or not re.fullmatch(r'proj_[A-Za-z0-9]+', settings.get('project_id', '')):
            raise APIError('서버의 API 키 환경변수와 Project ID를 확인하세요.')
        self._client = httpx.Client(
            headers={'Authorization': 'Bearer ' + api_key, 'x-project-id': settings['project_id']},
            timeout=httpx.Timeout(45, connect=15), follow_redirects=False,
            transport=transport, trust_env=False,
        )

    def close(self):
        self._client.close()

    def _request(self, path, *, method='GET', **kwargs):
        if not path.startswith('/') or path.startswith('//') or any(c in path for c in ['\r', '\n', '#']):
            raise ValueError('잘못된 API 경로입니다.')
        attempts = 3 if method == 'GET' else 1
        for attempt in range(attempts):
            try:
                response = self._client.request(method, API + path, **kwargs)
                if not 200 <= response.status_code < 300:
                    code = response.status_code
                    if (code == 429 or code >= 500) and attempt + 1 < attempts:
                        self._sleep(1 + attempt)
                        continue
                    raise APIError(f'Studio API 응답 오류 ({code}).', ambiguous=method != 'GET' and code >= 500)
                value = response.json()
                if not isinstance(value, dict):
                    raise ValueError('Unexpected response')
                return value
            except (httpx.HTTPError, OSError, ValueError):
                if attempt + 1 < attempts:
                    self._sleep(1 + attempt)
                    continue
                raise APIError('Studio API 연결 또는 응답 오류입니다.', ambiguous=method != 'GET') from None

    def upload(self, filename, data):
        safe_name = re.sub(r'[\r\n"\\]', '_', filename)
        source = data.open('rb') if isinstance(data, Path) else nullcontext(data)
        with source as stream:
            value = self._request('/files', method='POST', data={'purpose': 'user_data'},
                                  files={'file': (safe_name, stream, 'application/pdf')})
        file_id = value.get('id')
        if not isinstance(file_id, str) or not re.fullmatch(r'file[_-][A-Za-z0-9-]+', file_id):
            raise APIError('업로드 응답의 File ID를 확인할 수 없습니다. 업로드를 자동 반복하지 않았습니다.', ambiguous=True)
        return file_id

    def create_job(self, file_id):
        agent = self.settings.get('agent_id', '')
        version = self.settings.get('config_version')
        if not re.fullmatch(r'agt_[A-Za-z0-9]+', agent) or type(version) is not int or version < 1:
            raise APIError('Agent ID와 실행할 Config 번호를 설정하세요.')
        if not re.fullmatch(r'file[_-][A-Za-z0-9-]+', file_id):
            raise ValueError('잘못된 File ID입니다.')
        body = {'model': agent, 'config_id': str(version), 'include': ['all'],
                'input': [{'role': 'user', 'content': [{'type': 'input_file', 'file_id': file_id}]}]}
        value = self._request('/responses', method='POST', json=body)
        job_id = value.get('id')
        if not isinstance(job_id, str) or not re.fullmatch(r'job_[A-Za-z0-9]+', job_id):
            raise APIError('생성 응답의 Job ID를 확인할 수 없습니다. 새 Job을 자동 반복 생성하지 않았습니다.', ambiguous=True)
        return job_id

    def retrieve(self, job_id):
        if not re.fullmatch(r'job_[A-Za-z0-9]+', job_id):
            raise ValueError('잘못된 Job ID입니다.')
        return self._request('/responses/' + job_id, params={'include[]': 'all'})
