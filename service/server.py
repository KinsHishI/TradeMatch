"""Local Studio service and persistent API orchestration."""
import argparse
import copy
import fcntl
import hashlib
import json
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .api_client import APIError, UpstageClient
from .evaluate import DEFAULT_EXPECTED, ROOT, expected_for, filename_for
from .results import analyze, decode, metadata, summarize, delivery_failure
from .report import report_html, style_hash
from .previews import render_page, renderer, cached_preview

MAX_UPLOAD = 50 * 1024 * 1024
DEMO = ROOT / 'results/local_api_20261105T121334_826162Z'
SETTINGS_KEYS = {'agent_id', 'project_id', 'config_version', 'decision_node'}
ACTIVE = {'uploading', 'creating_job', 'queued', 'in_progress', 'retrieving'}
RETRYABLE = {'failed', 'cancelled', 'canceled', 'incomplete'}
DEMO_CASES = [
    ('TM11_001.pdf', '정상 선적', '네 서류의 필수 항목이 일치하는 사례', 'PASS'),
    ('TM11_015.pdf', '청구 총액 불일치', 'Studio가 1 USD의 금액 차이를 기록한 사례', 'FAIL'),
    ('TM11_017.pdf', '원문 수량 확인', '수량 공란으로 담당자 확인이 필요한 사례', 'REQUIRES_HUMAN_REVIEW'),
]


def now():
    return datetime.now(timezone.utc).isoformat()


def timestamped_upload_name(filename, created_at):
    received = datetime.fromisoformat(created_at).astimezone(timezone(timedelta(hours=9)))
    return received.strftime('%Y%m%d_%H%M%S_') + f'{received.microsecond // 1000:03d}_' + filename


class StateLock:
    """Reentrant thread lock plus an OS lock shared by all local servers."""
    def __init__(self, path):
        self.path = path
        self.thread_lock = threading.RLock()
        self.local = threading.local()

    def __enter__(self):
        self.thread_lock.acquire()
        try:
            if not getattr(self.local, 'depth', 0):
                self.local.file = self.path.open('a')
                try:
                    fcntl.flock(self.local.file, fcntl.LOCK_EX)
                except BaseException:
                    self.local.file.close()
                    raise
            self.local.depth = getattr(self.local, 'depth', 0) + 1
        except BaseException:
            self.thread_lock.release()
            raise
        return self

    def __exit__(self, *exc):
        try:
            self.local.depth -= 1
            if not self.local.depth:
                self.local.file.close()  # Releases flock, including on process exit.
        finally:
            self.thread_lock.release()


class Application:
    def __init__(self, state_dir=None, *, api_key=None, client_factory=UpstageClient, poll_interval=2.5, poll_limit=240):
        self.state = Path(state_dir or Path(__file__).parent / '.state')
        self.state.mkdir(parents=True, exist_ok=True)
        self.runs = self.state / 'runs'
        self.runs.mkdir(exist_ok=True)
        self._key = os.environ.get('UPSTAGE_API_KEY', '').strip() if api_key is None else api_key
        self.client_factory = client_factory
        self.poll_interval, self.poll_limit = poll_interval, poll_limit
        self.lock = StateLock(self.state / 'state.lock')
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix='studio-reader')
        self.stop = threading.Event()
        self.busy = set()
        self.worker_leases = {}
        self.preview_locks = {}
        # A restart never repeats file uploads or Job creation.
        with self.lock:
            for row in self.list_full():
                if row.get('phase') in ACTIVE and self._claim_run(row['id']):
                    try:
                        self.update(row['id'], phase='paused', message='서버가 재시작됐습니다. 저장된 Job ID로 결과 조회를 이어갈 수 있습니다.' if row.get('job_id') else '외부 요청 도중 재시작됐습니다. Studio 기록을 확인하세요. 자동 재생성하지 않았습니다.')
                    finally:
                        self._release_run(row['id'])

    def _claim_run(self, run_id):
        # Call while holding state.lock; claim before submitting a queued worker.
        if run_id in self.busy:
            return False
        lease = (self.directory(run_id) / 'worker.lock').open('a')
        try:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lease.close()
            return False
        except BaseException:
            lease.close()
            raise
        self.worker_leases[run_id] = lease
        self.busy.add(run_id)
        return True

    def _release_run(self, run_id):
        lease = self.worker_leases.pop(run_id, None)
        if lease is not None:
            lease.close()
        self.busy.discard(run_id)

    def _submit_run(self, run_id, create):
        try:
            self.pool.submit(self._worker, run_id, create)
        except BaseException:
            self._release_run(run_id)
            raise

    def _redact(self, text):
        return text.replace(self._key, '[REDACTED_API_KEY]') if self._key else text

    def _write(self, path, value):
        encoded = self._redact(json.dumps(value, ensure_ascii=False, indent=2)) + '\n'
        temp = path.with_suffix(path.suffix + '.tmp')
        temp.write_text(encoded, encoding='utf-8')
        temp.chmod(0o600)
        temp.replace(path)

    def settings(self):
        value = {'agent_id': os.environ.get('UPSTAGE_AGENT_ID', ''),
                 'project_id': os.environ.get('UPSTAGE_PROJECT_ID', ''),
                 'config_version': None, 'decision_node': os.environ.get('UPSTAGE_DECISION_NODE', '')}
        version = os.environ.get('UPSTAGE_CONFIG_ID', '')
        if version.isdigit():
            value['config_version'] = int(version)
        path = self.state / 'settings.json'
        if path.exists():
            value.update({k: v for k, v in json.loads(path.read_text()).items() if k in SETTINGS_KEYS})
        return value

    def save_settings(self, value):
        if not isinstance(value, dict) or set(value) - SETTINGS_KEYS:
            raise ValueError('비밀 키는 입력하거나 저장할 수 없습니다. Agent·Project·Config·판정 노드만 설정하세요.')
        result = self.settings()
        result.update(value)
        for key, prefix in [('agent_id', 'agt_'), ('project_id', 'proj_')]:
            item = result[key]
            if not isinstance(item, str) or (item and not re.fullmatch(prefix + r'[A-Za-z0-9]+', item)):
                raise ValueError('Agent ID 또는 Project ID 형식을 확인하세요.')
        version = result['config_version']
        if version is not None and (type(version) is not int or version < 1):
            raise ValueError('Config는 양의 정수 번호여야 합니다.')
        if not isinstance(result['decision_node'], str) or len(result['decision_node']) > 100:
            raise ValueError('판정 노드 이름을 확인하세요.')
        with self.lock:
            self._write(self.state / 'settings.json', result)
        return result

    def connection(self):
        settings = self.settings()
        return {'settings': settings, 'key_available': bool(self._key),
                'can_retrieve': bool(self._key and settings['project_id']),
                'can_execute': bool(self._key and settings['project_id'] and settings['agent_id'] and settings['config_version']),
                'max_upload_mb': MAX_UPLOAD // (1024 * 1024)}

    def directory(self, run_id):
        if not re.fullmatch(r'[a-f0-9]{32}', run_id):
            raise ValueError('잘못된 결과 ID입니다.')
        return self.runs / run_id

    def get(self, run_id):
        with self.lock:
            return json.loads((self.directory(run_id) / 'record.json').read_text())

    def update(self, run_id, **values):
        with self.lock:
            row = self.get(run_id)
            row.update(values, updated_at=now())
            self._write(self.directory(run_id) / 'record.json', row)
            return row

    def list_full(self):
        with self.lock:
            return [json.loads(p.read_text()) for p in self.runs.glob('*/record.json')]

    def listing(self):
        values = []
        for row in self.list_full():
            analysis = row.get('analysis', {})
            values.append({k: row.get(k) for k in ['id', 'filename', 'phase', 'source', 'job_id', 'file_id', 'message', 'created_at', 'updated_at', 'settings_snapshot']}
                          | {k: analysis.get(k) for k in ['studio_status', 'expected_status', 'expected_status_match', 'contract_valid', 'decision_value', 'executed_branch']}
                          | {'delivery_failure': delivery_failure(analysis) if row['phase'] == 'completed' else None,
                             'evidence_findings': len(analysis.get('evidence_audit', {}).get('findings', [])),
                             'technical_count': len(analysis.get('technical_issues', []))})
        return sorted(values, key=lambda r: r['created_at'], reverse=True)

    def new_record(self, filename, source, snapshot, **extra):
        run_id = uuid.uuid4().hex
        folder = self.directory(run_id)
        folder.mkdir()
        row = {'id': run_id, 'filename': filename, 'source': source, 'phase': 'retrieving',
               'created_at': now(), 'updated_at': now(), 'settings_snapshot': snapshot, **extra}
        self._write(folder / 'record.json', row)
        return row

    def save_result(self, run_id, payload):
        row = self.get(run_id)
        # Analyze the same credential-redacted response that is downloadable.
        payload = json.loads(self._redact(json.dumps(payload, ensure_ascii=False)))
        filename = row['filename'] if row['filename'] != '기존 Job' else filename_for(payload)
        raw_name = 'raw.' + str(time.time_ns()) + '.json'
        self._write(self.directory(run_id) / raw_name, payload)
        analysis = analyze(payload, decision_node=row['settings_snapshot'].get('decision_node', ''),
                           expected=expected_for(filename))
        return self.update(run_id, phase=payload.get('status', 'unknown'), filename=filename,
                           raw_file=raw_name, analysis=analysis, message='Studio 원본 판정을 수신했습니다. Python은 판정을 변경하지 않았습니다.' if payload.get('status') == 'completed' else 'Studio 작업이 완료되지 않았습니다. 원본 응답과 실행 상태를 확인하세요.')

    def demo_cases(self):
        rows = self.list_full()
        cases = []
        for filename, title, description, status in DEMO_CASES:
            found = next((r for r in rows if r['filename'] == filename and r.get('source') == 'saved_config20'), None)
            cases.append({'filename': filename, 'title': title, 'description': description,
                          'recorded_status': status, 'run_id': found['id'] if found else None})
        return {'mode': 'saved_record_replay', 'live_api': False, 'config_version': 20, 'cases': cases}

    def pdf_path(self, run_id):
        row = self.get(run_id)
        path = self.directory(run_id) / 'source.pdf'
        if path.is_file():
            return path
        if row.get('source') == 'saved_config20' and re.fullmatch(r'TM11_\d{3}\.pdf', row['filename']):
            path = ROOT / 'tests/TradeMatch_1to1_Test_Pack/upload_pdfs' / row['filename']
            if path.is_file():
                return path
        raise FileNotFoundError('원본 PDF가 로컬에 없습니다.')

    def source_view(self, run_id):
        row = self.get(run_id)
        documents = []
        if row.get('raw_file'):
            payload = json.loads((self.directory(run_id) / row['raw_file']).read_text())
            for step in payload.get('output', []):
                if step.get('step_type') != 'information-extract' and not str(step.get('model', '')).startswith('Information Extract - '):
                    continue
                for block in step.get('content', []):
                    try:
                        value = decode(block.get('text', ''))
                    except (ValueError, TypeError):
                        continue
                    if not isinstance(value, dict):
                        continue
                    kind = next((k for k, field in [('PO', 'po_number'), ('CI', 'invoice_number'), ('PL', 'packing_list_number'), ('BL', 'bl_number')] if field in value), 'OTHER')
                    key = {'PO': 'po_number', 'CI': 'invoice_number', 'PL': 'packing_list_number', 'BL': 'bl_number'}.get(kind)
                    ranges = metadata(block).get('page_ranges', [])
                    page = ranges[0][0] if ranges and isinstance(ranges[0], list) and ranges[0] and type(ranges[0][0]) is int else None
                    documents.append({'kind': kind, 'document_id': value.get(key) if key else None, 'page': page, 'data': value})
        try:
            self.pdf_path(run_id)
            has_pdf = True
        except FileNotFoundError:
            has_pdf = False
        preview_available = has_pdf and bool(renderer() or cached_preview(self.pdf_path(run_id), 1))
        return {'documents': documents, 'has_pdf': has_pdf, 'pdf_url': f'/api/runs/{run_id}/document.pdf' if has_pdf else None,
                'preview_url': f'/api/runs/{run_id}/preview.png' if preview_available else None}

    def preview(self, run_id, page):
        with self.lock:
            lock = self.preview_locks.setdefault((run_id, page), threading.Lock())
        with lock:
            return render_page(self.pdf_path(run_id), page, self.directory(run_id) / 'previews')

    def seed_demo(self):
        existing = {r.get('demo_job_id') for r in self.list_full()}
        for path in sorted(DEMO.glob('job_*.raw.json')):
            payload = decode(json.loads(path.read_text()))
            if payload['id'] in existing:
                continue
            snapshot = {'agent_id': payload.get('model', ''), 'project_id': 'proj_e88CHrANRG3JeEdUgt95vf',
                        'config_version': 20, 'decision_node': ''}
            row = self.new_record(filename_for(payload), 'saved_config20', snapshot,
                                  job_id=payload['id'], demo_job_id=payload['id'])
            self.save_result(row['id'], payload)

    def start_upload(self, filename, data):
        if not self.connection()['can_execute']:
            raise ValueError('서버의 키 환경변수와 연결 설정을 먼저 준비하세요. 새 요청은 만들지 않았습니다.')
        filename = Path(filename.replace('\\', '/')).name[:160]
        if not filename.lower().endswith('.pdf') or b'%PDF-' not in data[:1024]:
            raise ValueError('이 서비스는 PDF 파일을 받습니다.')
        if not data or len(data) > MAX_UPLOAD:
            raise ValueError('PDF는 50 MB 이하여야 합니다.')
        snapshot = self.settings()
        digest = hashlib.sha256(data + json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
        with self.lock:
            for row in sorted(self.list_full(), key=lambda r: r['created_at'], reverse=True):
                if row.get('fingerprint') == digest and (row['phase'] in ACTIVE | {'completed', 'creation_unknown', 'upload_unknown', 'paused'} or row.get('job_id')):
                    return row  # Same bytes/config: reuse; never silently rerun.
            row = self.new_record(filename, 'studio_api', snapshot, fingerprint=digest)
            pdf = self.directory(row['id']) / 'source.pdf'
            pdf.write_bytes(data)
            pdf.chmod(0o600)
            self.update(row['id'], upload_filename=timestamped_upload_name(filename, row['created_at']),
                        phase='uploading', message='Studio에 문서를 전달하고 있습니다.')
            self._claim_run(row['id'])
            self._submit_run(row['id'], True)
            return self.get(row['id'])

    def retrieve_existing(self, job_id):
        if not re.fullmatch(r'job_[A-Za-z0-9]+', job_id):
            raise ValueError('Job ID를 확인하세요.')
        if not self.connection()['can_retrieve']:
            raise ValueError('키 환경변수와 Project ID가 필요합니다. 새 요청은 만들지 않았습니다.')
        with self.lock:
            for row in self.list_full():
                if row.get('job_id') == job_id:
                    self.resume(row['id'])
                    return self.get(row['id'])
            row = self.new_record('기존 Job', 'studio_get', self.settings(), job_id=job_id)
            self.resume(row['id'])
            return self.get(row['id'])

    def retry_reason(self, row):
        phase = row['phase']
        if phase in {'creation_unknown', 'upload_unknown'} or (phase == 'paused' and not row.get('job_id')):
            return 'uncertain_request'
        if phase not in RETRYABLE | {'completed'} or not row.get('raw_file') or not row.get('job_id'):
            return None
        payload = json.loads((self.directory(row['id']) / row['raw_file']).read_text())
        if payload.get('id') != row['job_id']:
            return None
        if phase in RETRYABLE and payload.get('status') in RETRYABLE:
            return 'execution_failed'
        if phase == payload.get('status') == 'completed':
            return delivery_failure(row.get('analysis', {}))
        return None

    def record_view(self, run_id):
        row = self.get(run_id)
        reason = self.retry_reason(row)
        snapshot = row.get('settings_snapshot', {})
        available = bool(reason and self._key and snapshot.get('project_id') == self.settings()['project_id']
                         and (self.directory(run_id) / 'source.pdf').is_file())
        return row | {'has_pdf': (self.directory(run_id) / 'source.pdf').is_file(),
                      'delivery_failure': delivery_failure(row.get('analysis', {})) if row['phase'] == 'completed' else None,
                      'retry': {'available': available, 'reason': reason,
                                'requires_confirmation': reason == 'uncertain_request'}}

    def retry_failed(self, run_id, *, accept_duplicate_risk=False):
        """Explicit new Job; one durable child per failed parent, never a POST retry."""
        with self.lock:
            parent = self.get(run_id)
            child = next((r for r in self.list_full() if r.get('retry_of') == run_id), None)
            if child:
                return child
            if not self._key:
                raise ValueError('서버의 API 키 환경변수가 필요합니다.')
            reason = self.retry_reason(parent)
            if not reason:
                raise ValueError('실행 실패나 결과 생성 오류가 있는 작업만 다시 검증할 수 있습니다.')
            if reason == 'uncertain_request' and accept_duplicate_risk is not True:
                raise ValueError('기존 요청이 접수됐을 수 있습니다. 중복 실행 가능성을 확인한 뒤 다시 검증해 주세요.')
            snapshot = parent['settings_snapshot']
            if (not re.fullmatch(r'agt_[A-Za-z0-9]+', snapshot.get('agent_id', ''))
                    or not re.fullmatch(r'proj_[A-Za-z0-9]+', snapshot.get('project_id', ''))
                    or type(snapshot.get('config_version')) is not int or snapshot['config_version'] < 1
                    or snapshot['project_id'] != self.settings()['project_id']):
                raise ValueError('기존 검증 버전과 Project 연결을 확인해 주세요.')
            data = self.pdf_path(run_id).read_bytes()
            digest = hashlib.sha256(data + json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
            child = self.new_record(parent['filename'], 'studio_retry', snapshot, retry_of=run_id,
                                    fingerprint=digest, retry_reason=reason, phase='uploading',
                                    message='보관된 원본 PDF를 Studio에 다시 보내고 있습니다.')
            pdf = self.directory(child['id']) / 'source.pdf'
            pdf.write_bytes(data)
            pdf.chmod(0o600)
            self.update(child['id'], upload_filename=timestamped_upload_name(parent['filename'], child['created_at']))
            self._claim_run(child['id'])
            self._submit_run(child['id'], True)
            return self.get(child['id'])

    def resume(self, run_id):
        with self.lock:
            row = self.get(run_id)
            if run_id in self.busy:
                return row
            if not row.get('job_id'):
                raise ValueError('저장된 Job ID가 없어 자동 재생성할 수 없습니다. Studio 기록을 확인하세요.')
            if not self._key:
                raise ValueError('서버를 시작한 터미널에 API 키 환경변수가 필요합니다.')
            if not self._claim_run(run_id):
                return row
            self.update(run_id, phase='retrieving', message='저장된 Job ID로 결과만 조회합니다.')
            self._submit_run(run_id, False)
            return self.get(run_id)

    def _worker(self, run_id, create):
        phase = 'retrieving'
        client = None
        pdf = self.directory(run_id) / 'source.pdf'
        try:
            row = self.get(run_id)
            client = self.client_factory(row['settings_snapshot'], self._key)
            if create:
                phase = 'uploading'
                file_id = client.upload(row.get('upload_filename', row['filename']), pdf)
                self.update(run_id, file_id=file_id, phase='creating_job', message='지정한 Studio 설정으로 작업을 생성합니다.')
                phase = 'creating_job'
                job_id = client.create_job(file_id)
                self.update(run_id, job_id=job_id, phase='queued', message='Job ID를 저장했습니다. 결과를 기다립니다.')
            job_id = self.get(run_id)['job_id']
            for _ in range(self.poll_limit):
                if self.stop.is_set():
                    self.update(run_id, phase='paused', message='조회가 중단됐습니다. 저장된 Job ID로 이어갈 수 있습니다.')
                    return
                phase = 'retrieving'
                payload = client.retrieve(job_id)
                status = payload.get('status')
                if status in {'completed', 'failed', 'cancelled', 'canceled', 'incomplete'}:
                    self.save_result(run_id, payload)
                    return
                if status not in {'queued', 'in_progress'}:
                    raise APIError('알 수 없는 Job 상태입니다. 자동 재생성하지 않았습니다.')
                self.update(run_id, phase=status, message='Studio가 처리 중입니다. 마지막 조회: ' + now())
                self.stop.wait(self.poll_interval)
            self.update(run_id, phase='paused', message='조회 대기 시간이 지났습니다. 저장된 Job ID로 결과 조회를 이어가세요.')
        except APIError as exc:
            unknown = {'uploading': 'upload_unknown', 'creating_job': 'creation_unknown'}.get(phase, 'error') if exc.ambiguous else 'error'
            self.update(run_id, phase=unknown, message=str(exc) + (' 요청 성공 여부가 불명확하여 POST를 반복하지 않았습니다.' if exc.ambiguous else ''))
        except Exception:
            # Unknown failure after a POST must not look like a safe retry.
            unknown = {'uploading': 'upload_unknown', 'creating_job': 'creation_unknown'}.get(phase, 'error')
            self.update(run_id, phase=unknown, message='처리를 완료하지 못했습니다. 저장된 ID와 Studio 기록을 확인하세요. 작업을 자동 재생성하지 않았습니다.')
        finally:
            try:
                if client is not None and hasattr(client, "close"):
                    client.close()
            finally:
                with self.lock:
                    self._release_run(run_id)

    def report(self):
        rows = self.list_full()
        analyses = [r['analysis'] for r in rows if 'analysis' in r]
        return {'summary': summarize(analyses), 'cases': [{'filename': r['filename'], 'source': r['source'], 'analysis': r.get('analysis')} for r in rows]}

    def close(self):
        self.stop.set()
        self.pool.shutdown(wait=True)



def main():
    import uvicorn
    from .web import create_app
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--demo', action='store_true', help='Optional saved-record workspace; never creates Jobs.')
    parser.add_argument('--state-dir', type=Path)
    args = parser.parse_args()
    app = Application(args.state_dir)
    if args.demo:
        app.seed_demo()
    print(f'TradeMatch service: http://127.0.0.1:{args.port}', flush=True)
    print('Upload a PDF in the browser to run Studio. Startup creates no Jobs.', flush=True)
    uvicorn.run(create_app(app, close_on_shutdown=True), host='127.0.0.1', port=args.port,
                access_log=False, log_level='warning')


if __name__ == '__main__':
    main()
