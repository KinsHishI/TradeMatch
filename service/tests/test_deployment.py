"""Portable deployment boundary tests: no real keys, PDFs, or Studio calls."""
import base64
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from service.access import DeploymentAccess
from service.deployment import configuration, create_deployment_app
from service.server import Application
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
        token = base64.b64encode(b'demo:test-only-access-password').decode()
        self.headers = {'Authorization': 'Basic ' + token, 'Origin': 'https://tradematch.example'}

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
        for path in paths:
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 401)
                self.assertIn('WWW-Authenticate', response.headers)
                self.assertNotIn(self.env['UPSTAGE_API_KEY'], response.text)
        with patch.object(self.app, 'start_upload') as upload:
            self.assertEqual(self.client.post('/api/upload', content=b'%PDF-test').status_code, 401)
            upload.assert_not_called()
        wrong = self.client.get('/api/runs', auth=('demo', 'wrong'))
        self.assertEqual(wrong.status_code, 401)
        self.assertEqual(self.client.get('/api/health').status_code, 200)

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


if __name__ == '__main__':
    unittest.main()
