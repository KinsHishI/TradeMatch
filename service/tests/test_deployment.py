"""Portable deployment boundary tests: no real keys, PDFs, or Studio calls."""
import json
from pathlib import Path
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from service.access import DeploymentAccess, LoginSessions, SESSION_COOKIE, SESSION_SECONDS, login_target
from service.deployment import configuration, create_deployment_app
from service.server import Application
from service.api_client import APIError
from service.web import create_app


def environment(state):
    return {'TRADEMATCH_PUBLIC_URL': 'https://tradematch.example',
            'TRADEMATCH_ACCESS_USER': 'demo', 'TRADEMATCH_ACCESS_PASSWORD': 'test-only-access-password',
            'TRADEMATCH_STATE_DIR': str(state), 'UPSTAGE_API_KEY': 'test-only-api-token',
            'UPSTAGE_AGENT_ID': 'agt_test', 'UPSTAGE_PROJECT_ID': 'proj_test', 'UPSTAGE_CONFIG_ID': '20'}


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.state = Path(self.folder.name) / 'data'
        self.env = environment(self.state)
        self.access, _, _ = configuration(self.env)
        self.app = Application(self.state, api_key='test-only-api-token')
        self.client = TestClient(create_app(self.app, deployment_access=self.access),
                                 base_url='https://tradematch.example')
        self.headers = {'Origin': 'https://tradematch.example'}
        login = self.client.post('/api/login', json={'username': 'DEMO', 'password': 'test-only-access-password'}, headers=self.headers)
        self.assertEqual(login.status_code, 200)

    def tearDown(self):
        self.client.close()
        self.app.close()
        self.folder.cleanup()

    def test_fail_closed_configuration(self):
        for name in self.env:
            with self.subTest(name=name):
                incomplete = self.env.copy(); incomplete.pop(name)
                with self.assertRaises(ValueError): configuration(incomplete)
        with self.assertRaises(ValueError): configuration(self.env | {'TRADEMATCH_PUBLIC_URL': 'http://tradematch.example'})
        with self.assertRaises(ValueError): configuration(self.env | {'TRADEMATCH_ACCESS_PASSWORD': 'short'})
        with self.assertRaises(ValueError): configuration(self.env | {'TRADEMATCH_STATE_DIR': 'relative'})
        with self.assertRaises(ValueError): configuration(self.env | {'RAILWAY_ENVIRONMENT_ID': 'test'})
        with self.assertRaises(ValueError): configuration(self.env | {'RAILWAY_VOLUME_MOUNT_PATH': '/elsewhere'})
        self.assertEqual(configuration(self.env | {'RAILWAY_VOLUME_MOUNT_PATH': self.folder.name})[1], self.state)
        self.assertNotIn(self.env['TRADEMATCH_ACCESS_PASSWORD'], repr(self.access))

    def test_every_data_and_execution_route_requires_authentication(self):
        paths = ['/', '/product.js', '/product.css', '/api/connection', '/api/runs',
                 '/api/runs/' + 'a' * 32 + '/raw', '/api/runs/' + 'a' * 32 + '/document.pdf']
        with TestClient(self.client.app, base_url='https://tradematch.example') as visitor:
            for path in paths:
                with self.subTest(path=path):
                    response = visitor.get(path, follow_redirects=False)
                    self.assertEqual(response.status_code, 303 if path in {'/', '/api/runs/' + 'a' * 32 + '/document.pdf'} else 401)
                    self.assertNotIn('WWW-Authenticate', response.headers)
                    self.assertNotIn(self.env['UPSTAGE_API_KEY'], response.text)
            with patch.object(self.app, 'start_upload') as upload:
                self.assertEqual(visitor.post('/api/upload', content=b'%PDF-test', headers=self.headers).status_code, 401)
                upload.assert_not_called()
            self.assertEqual(visitor.get('/api/runs', auth=('demo', 'test-only-access-password')).status_code, 401)
        self.assertEqual(self.client.get('/api/health').status_code, 200)

    def test_retry_requires_session_and_same_origin_before_starting_work(self):
        row = self.app.new_record('failed.pdf', 'test', self.app.settings())
        path = '/api/runs/' + row['id'] + '/retry'
        with patch.object(self.app, 'retry_failed', return_value={'id': 'b' * 32, 'phase': 'queued'}) as retry:
            with TestClient(self.client.app, base_url='https://tradematch.example') as visitor:
                self.assertEqual(visitor.post(path, json={}, headers=self.headers).status_code, 401)
            for origin in ['', 'null', 'https://unrelated.example']:
                self.assertEqual(self.client.post(path, json={}, headers={'Origin': origin}).status_code, 403)
            retry.assert_not_called()
            accepted = self.client.post(path, json={}, headers=self.headers)
            self.assertEqual(accepted.status_code, 202)
            self.assertEqual(accepted.json()['id'], 'b' * 32)
            retry.assert_called_once_with(row['id'])

    def test_valid_viewer_can_read_but_cannot_change_workflow_or_import_jobs(self):
        connection = self.client.get('/api/connection', headers=self.headers)
        self.assertEqual(connection.status_code, 200)
        self.assertTrue(connection.json()['settings_locked'])
        self.assertEqual(self.client.get('/api/runs', headers=self.headers).json(), {'runs': []})
        for path in ['/api/settings', '/api/retrieve', '/api/demo/load']:
            self.assertEqual(self.client.post(path, json={}, headers=self.headers).status_code, 403)
        self.assertFalse((self.state / 'settings.json').exists())
        self.assertEqual(self.client.get('/workspace', headers=self.headers).status_code, 403)

    def test_host_and_origin_are_checked_before_upload(self):
        with patch.object(self.app, 'start_upload', return_value={'id': 'a' * 32, 'phase': 'queued'}) as upload:
            for origin in ['', 'https://unrelated.example', 'null']:
                headers = self.headers | {'Origin': origin}
                self.assertEqual(self.client.post('/api/upload', content=b'%PDF-test', headers=headers).status_code, 403)
            self.assertEqual(self.client.post('/api/upload', content=b'%PDF-test', headers=self.headers | {'Host': 'unrelated.example'}).status_code, 403)
            upload.assert_not_called()
            accepted = self.client.post('/api/upload?filename=test.pdf', content=b'%PDF-test', headers=self.headers)
            self.assertEqual(accepted.status_code, 202)
            upload.assert_called_once_with('test.pdf', b'%PDF-test')

    def test_downloaded_report_keeps_business_result_without_developer_metadata(self):
        row = self.app.new_record('shipment.pdf', 'studio_api', {'config_version': 24}, job_id='job_internal')
        self.app.update(row['id'], phase='completed', analysis={
            'studio_status': 'FAIL', 'decision_value': 'FAIL', 'executed_branch': 'internal_branch',
            'result': {'report': '포장 개수가 다릅니다.', 'checks': [], 'issues': []}})
        response = self.client.get('/api/runs/' + row['id'] + '/report.html', headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertIn('포장 개수가 다릅니다.', response.text)
        self.assertIn('불일치', response.text)
        for internal in ['Job ID', 'job_internal', 'internal_branch', 'Config', 'Python']:
            self.assertNotIn(internal, response.text)

    def test_existing_local_mode_remains_local_and_settings_editable(self):
        with TestClient(create_app(self.app), base_url='http://127.0.0.1:8765') as local:
            response = local.get('/api/connection')
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('settings_locked', response.json())
            self.assertEqual(local.get('/api/connection', headers={'Host': 'tradematch.example'}).status_code, 403)

    def test_persistence_and_original_state_survive_restart(self):
        row = self.app.new_record('test.pdf', 'studio_api', {}, job_id='job_preserved')
        before = (self.app.directory(row['id']) / 'record.json').read_text()
        self.app.close()
        self.app = Application(self.state, api_key='test-only-api-token')
        restored = self.app.get(row['id'])
        self.assertEqual(restored['job_id'], 'job_preserved')
        self.assertEqual(json.loads(before)['id'], restored['id'])
        self.assertEqual(len(self.app.listing()), 1)

    def test_factory_accepts_empty_volume_and_rejects_local_settings(self):
        self.state.mkdir(exist_ok=True)
        with patch.dict('os.environ', self.env, clear=True):
            deployed = create_deployment_app()
            deployed.state.application.close()
            (self.state / 'settings.json').write_text('{}')
            with self.assertRaises(ValueError): create_deployment_app()

    def test_login_cookie_and_logout_revoke_access_without_browser_popup(self):
        with TestClient(self.client.app, base_url='https://tradematch.example') as visitor:
            page = visitor.get('/?run=' + 'a' * 32, follow_redirects=False)
            self.assertEqual(page.status_code, 303)
            self.assertIn('/login?next=', page.headers['location'])
            for path in ['/login', '/login.css', '/login.js']:
                self.assertEqual(visitor.get(path).status_code, 200)
            password = self.env['TRADEMATCH_ACCESS_PASSWORD']
            self.assertNotIn(password, visitor.get('/login').text)
            self.assertNotIn(self.env['UPSTAGE_API_KEY'], visitor.get('/login').text)
            invalid = visitor.post('/api/login', json={'username': 'demo', 'password': 'wrong'}, headers=self.headers)
            self.assertEqual(invalid.status_code, 401)
            self.assertNotIn('WWW-Authenticate', invalid.headers)
            self.assertNotIn('wrong', invalid.text)
            login = visitor.post('/api/login', json={'username': 'Demo', 'password': password, 'next': '/?view=history'}, headers=self.headers)
            self.assertEqual(login.json(), {'redirect': '/?view=history'})
            cookie = login.headers['set-cookie']
            for attribute in ['__Host-tradematch_session=', 'HttpOnly', 'Secure', 'SameSite=lax', 'Path=/']:
                self.assertIn(attribute, cookie)
            self.assertNotIn(password, cookie)
            token = visitor.cookies.get(SESSION_COOKIE)
            self.assertEqual(visitor.get('/api/runs').status_code, 200)
            self.assertEqual(visitor.post('/api/logout', headers=self.headers).status_code, 200)
            self.assertEqual(visitor.get('/api/runs').status_code, 401)
            self.assertFalse(self.client.app.state.login_sessions.valid(token))

    def test_login_rejects_foreign_origin_open_redirect_and_oversized_input(self):
        data = {'username': 'demo', 'password': self.env['TRADEMATCH_ACCESS_PASSWORD']}
        for origin in ['', 'null', 'https://unrelated.example']:
            self.assertEqual(self.client.post('/api/login', json=data, headers={'Origin': origin}).status_code, 403)
            self.assertEqual(self.client.post('/api/logout', headers={'Origin': origin}).status_code, 403)
        for target in ['https://unrelated.example', '//unrelated.example', '/\\unrelated.example', '/login', '/\r\nunrelated']:
            response = self.client.post('/api/login', json=data | {'next': target}, headers=self.headers)
            self.assertEqual(response.json()['redirect'], '/')
        response = self.client.post('/api/login', json=data | {'password': 'x' * 5000}, headers=self.headers)
        self.assertEqual(response.status_code, 400)
        self.assertNotIn('x' * 5000, response.text)

    def test_login_attempts_are_limited_and_password_is_exact(self):
        with TestClient(self.client.app, base_url='https://tradematch.example') as visitor:
            for _ in range(10):
                response = visitor.post('/api/login', json={'username': 'demo', 'password': self.env['TRADEMATCH_ACCESS_PASSWORD'] + ' '}, headers=self.headers)
                self.assertEqual(response.status_code, 401)
            limited = visitor.post('/api/login', json={'username': 'demo', 'password': 'wrong'}, headers=self.headers)
            self.assertEqual(limited.status_code, 429)
            self.assertEqual(limited.headers['retry-after'], '60')

    def test_sessions_expire_and_remain_bounded_without_persisted_tokens(self):
        clock = [0]
        sessions = LoginSessions(clock=lambda: clock[0])
        token = sessions.issue('client')
        self.assertTrue(sessions.valid(token))
        self.assertFalse(sessions.valid(token[:-1] + ('a' if token[-1] != 'a' else 'b')))
        self.assertNotIn(token, sessions.sessions)
        clock[0] = SESSION_SECONDS
        self.assertFalse(sessions.valid(token))
        for _ in range(260): sessions.issue('client')
        self.assertEqual(len(sessions.sessions), 256)
        for i in range(1030): self.assertTrue(sessions.allow_login(str(i)))
        self.assertEqual(len(sessions.attempts), 1024)
        self.assertEqual(login_target('/?view=history'), '/?view=history')
        self.assertEqual(list(self.state.glob('*session*')), [])


if __name__ == '__main__':
    unittest.main()


class RetryTests(unittest.TestCase):
    """All Studio operations are fakes, including the new Job creation."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.calls = []
        self.ambiguous = False
        owner = self
        class Client:
            def upload(self, *args):
                raise AssertionError('Retry must reuse the existing Project file')
            def create_job(self, file_id):
                owner.calls.append(('create', file_id))
                if owner.ambiguous:
                    raise APIError('Unknown response', ambiguous=True)
                return 'job_new'
            def retrieve(self, job_id):
                owner.calls.append(('retrieve', job_id))
                return {'id': job_id, 'status': 'failed', 'error': {'code': 'server_error'}, 'output': []}
        self.factory = lambda snapshot, key: Client()
        self.app = Application(self.temp.name, api_key='test-only-token', client_factory=self.factory, poll_interval=0)
        self.app.save_settings({'agent_id': 'agt_test', 'project_id': 'proj_test', 'config_version': 4})

    def tearDown(self):
        self.app.close()
        self.temp.cleanup()

    def parent(self):
        row = self.app.new_record('failed.pdf', 'studio_api', self.app.settings(), job_id='job_old', file_id='file_old')
        (self.app.directory(row['id']) / 'source.pdf').write_bytes(b'%PDF-test')
        self.app.save_result(row['id'], {'id': 'job_old', 'status': 'failed', 'output': [], 'error': {'code': 'server_error'}})
        return self.app.get(row['id'])

    def finish(self):
        deadline = time.monotonic() + 4
        while self.app.busy and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertFalse(self.app.busy)

    def test_retry_preserves_parent_pdf_and_original_config_with_one_new_job(self):
        parent = self.parent()
        old_raw = (self.app.directory(parent['id']) / parent['raw_file']).read_bytes()
        self.app.save_settings({'config_version': 5})
        child = self.app.retry_failed(parent['id'])
        self.finish()
        child = self.app.get(child['id'])
        self.assertNotEqual(parent['id'], child['id'])
        self.assertEqual(child['retry_of'], parent['id'])
        self.assertEqual(child['settings_snapshot']['config_version'], 4)
        self.assertEqual(child['job_id'], 'job_new')
        self.assertEqual(self.app.pdf_path(child['id']).read_bytes(), b'%PDF-test')
        self.assertEqual(self.app.get(parent['id']), parent)
        self.assertEqual((self.app.directory(parent['id']) / parent['raw_file']).read_bytes(), old_raw)
        self.assertEqual(self.calls, [('create', 'file_old'), ('retrieve', 'job_new')])
        self.assertEqual(self.app.retry_failed(parent['id'])['id'], child['id'])
        self.app.save_settings({'config_version': 4})
        self.assertEqual(self.app.start_upload('renamed.pdf', b'%PDF-test')['id'], child['id'])
        # A subsequent attempt requires an explicit retry of the failed child.
        grandchild = self.app.retry_failed(child['id'])
        self.finish()
        self.assertEqual(grandchild['retry_of'], child['id'])
        self.assertEqual(sum(c[0] == 'create' for c in self.calls), 2)

    def test_concurrent_servers_create_only_one_child(self):
        parent = self.parent()
        peer = Application(self.temp.name, api_key='test-only-token', client_factory=self.factory, poll_interval=0)
        barrier = threading.Barrier(2)
        def retry(app):
            barrier.wait(timeout=3)
            return app.retry_failed(parent['id'])
        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                children = list(pool.map(retry, [self.app, peer]))
            self.assertEqual(children[0]['id'], children[1]['id'])
            self.finish()
        finally:
            peer.close()
        self.assertEqual(sum(c[0] == 'create' for c in self.calls), 1)

    def test_unconfirmed_or_business_results_never_create_a_job(self):
        for phase in ['completed', 'queued', 'in_progress', 'paused', 'creation_unknown', 'upload_unknown', 'error']:
            parent = self.parent()
            self.app.update(parent['id'], phase=phase)
            with self.subTest(phase=phase), self.assertRaises(ValueError):
                self.app.retry_failed(parent['id'])
        parent = self.parent()
        self.app.save_result(parent['id'], {'id': 'job_other', 'status': 'failed', 'output': []})
        with self.assertRaises(ValueError): self.app.retry_failed(parent['id'])
        parent = self.parent()
        self.app.save_result(parent['id'], {'id': 'job_old', 'status': 'queued', 'output': []})
        self.app.update(parent['id'], phase='failed')
        with self.assertRaises(ValueError): self.app.retry_failed(parent['id'])
        parent = self.parent()
        self.app.update(parent['id'], file_id='')
        with self.assertRaises(ValueError): self.app.retry_failed(parent['id'])
        parent = self.parent()
        self.app.pdf_path(parent['id']).unlink()
        with self.assertRaises(FileNotFoundError): self.app.retry_failed(parent['id'])
        parent = self.parent()
        self.app.save_settings({'project_id': 'proj_other'})
        with self.assertRaises(ValueError): self.app.retry_failed(parent['id'])
        self.assertEqual(self.calls, [])

    def test_ambiguous_creation_and_restart_never_repeat_the_post(self):
        parent = self.parent()
        self.ambiguous = True
        child = self.app.retry_failed(parent['id'])
        self.finish()
        self.assertEqual(self.app.get(child['id'])['phase'], 'creation_unknown')
        peer = Application(self.temp.name, api_key='test-only-token', client_factory=self.factory)
        try:
            self.assertEqual(peer.retry_failed(parent['id'])['id'], child['id'])
            with self.assertRaises(ValueError): peer.retry_failed(child['id'])
        finally:
            peer.close()
        self.assertEqual(self.calls, [('create', 'file_old')])
