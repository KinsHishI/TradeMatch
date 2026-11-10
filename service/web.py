"""FastAPI routes for the local PDF → Studio → original-result service."""
from contextlib import asynccontextmanager
import hashlib
import json
from pathlib import Path
import re

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from .api_client import APIError
from .evaluate import ROOT
from .report import report_html, style_hash
from .server import MAX_UPLOAD, SETTINGS_KEYS

STATIC = Path(__file__).parent / 'static'
CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
VERSION = 3


class ConnectionSettings(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    agent_id: str = Field(default='', pattern=r'^(agt_[A-Za-z0-9]+)?$')
    project_id: str = Field(default='', pattern=r'^(proj_[A-Za-z0-9]+)?$')
    config_version: int | None = Field(default=None, ge=1)
    decision_node: str = Field(default='', max_length=100)


class ExistingJob(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    job_id: str = Field(pattern=r'^job_[A-Za-z0-9]+$')


async def bounded_body(request, limit):
    length = request.headers.get('content-length')
    if length is not None and (not length.isdigit() or int(length) > limit):
        raise ValueError('요청 크기를 확인하세요. PDF는 50 MB 이하여야 합니다.')
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > limit:
            raise ValueError('요청 크기를 확인하세요. PDF는 50 MB 이하여야 합니다.')
        data.extend(chunk)
    if length is not None and len(data) != int(length):
        raise ValueError('파일 전송이 완료되지 않았습니다.')
    return bytes(data)


def create_app(application, *, close_on_shutdown=False, deployment_access=None):
    @asynccontextmanager
    async def lifespan(_):
        try:
            yield
        finally:
            if close_on_shutdown:
                await run_in_threadpool(application.close)

    app = FastAPI(title='TradeMatch Local', docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.application = application

    def result(value, status=200, download=None):
        headers = {'Content-Disposition': f'attachment; filename="{download}"'} if download else None
        return Response(application._redact(json.dumps(value, ensure_ascii=False)), status,
                        media_type='application/json', headers=headers)

    @app.middleware('http')
    async def access_boundary(request, call_next):
        port = request.url.port or 80
        hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        origin = request.headers.get('origin')
        if deployment_access is not None:
            # Railway healthchecks see no data and must work before browser authentication.
            if request.url.path == '/api/health' and request.method == 'GET':
                response = await call_next(request)
            elif not deployment_access.accepts_host(request.headers.get('host', '')):
                response = result({'error': '배포된 서비스 주소에서 접속하세요.'}, 403)
            elif not deployment_access.authenticated(request.headers.get('authorization', '')):
                response = result({'error': '시연용 접속 암호가 필요합니다.'}, 401)
                response.headers['WWW-Authenticate'] = 'Basic realm="TradeMatch", charset="UTF-8"'
            elif deployment_access.restricted(request.url.path):
                response = result({'error': '배포 환경의 설정과 관리 기능은 서버에서 관리합니다.'}, 403)
            elif request.method not in {'GET', 'HEAD'} and origin != deployment_access.origin:
                response = result({'error': '서비스 화면에서 요청을 진행하세요.'}, 403)
            else:
                response = await call_next(request)
        elif request.headers.get('host', '') not in hosts or (request.method not in {'GET', 'HEAD'} and origin and origin not in {'http://' + h for h in hosts}):
            response = result({'error': '로컬 서비스 주소에서 요청하세요.'}, 403)
        else:
            response = await call_next(request)
        response.headers.setdefault('Content-Security-Policy', CSP)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.exception_handler(ValueError)
    @app.exception_handler(APIError)
    async def user_error(_, exc):
        return result({'error': str(exc)}, 400)

    @app.exception_handler(FileNotFoundError)
    @app.exception_handler(KeyError)
    async def missing(_, exc):
        return result({'error': '결과 또는 원본 파일을 찾을 수 없습니다.'}, 404)

    @app.exception_handler(RequestValidationError)
    @app.exception_handler(ValidationError)
    async def invalid(_, exc):
        # Pydantic error details include submitted input: never echo them.
        return result({'error': '입력 형식과 필수 항목을 확인하세요.'}, 400)

    for route, name, mime in [('/', 'product.html', 'text/html'), ('/workspace', 'index.html', 'text/html'),
                              ('/product.js', 'product.js', 'text/javascript'), ('/product.css', 'product.css', 'text/css'),
                              ('/app.js', 'app.js', 'text/javascript'), ('/style.css', 'style.css', 'text/css'),
                              ('/report.css', 'report.css', 'text/css')]:
        # Do not expose captured asset paths as editable query parameters.
        def bind_asset(filename, content_type):
            def serve():
                return FileResponse(STATIC / filename, media_type=content_type)
            return serve
        app.add_api_route(route, bind_asset(name, mime), methods=['GET'], include_in_schema=False)

    @app.get('/api/health')
    def health():
        return {'service': 'tradematch-local', 'version': VERSION}

    @app.get('/api/connection')
    def connection():
        value = application.connection()
        if deployment_access is not None:
            value['settings_locked'] = True
        return result(value)

    @app.get('/api/demo')
    def demo():
        return result(application.demo_cases())

    @app.get('/api/samples/{case}.pdf')
    def sample_pdf(case: str):
        if case not in {'001', '015', '017'}:
            raise FileNotFoundError()
        return FileResponse(ROOT / 'tests/TradeMatch_1to1_Test_Pack/upload_pdfs' / f'TM11_{case}.pdf',
                            media_type='application/pdf', filename=f'TM11_{case}.pdf')

    @app.get('/api/runs')
    def runs():
        return result({'runs': application.listing()})

    @app.get('/api/report')
    def evaluation():
        return result(application.report(), download='TradeMatch_evaluation.json')

    def run(run_id):
        if not re.fullmatch(r'[a-f0-9]{32}', run_id):
            raise FileNotFoundError()
        return application.get(run_id)

    @app.get('/api/runs/{run_id}')
    def record(run_id: str):
        return result(run(run_id))

    @app.get('/api/runs/{run_id}/source')
    def source(run_id: str):
        run(run_id)
        return result(application.source_view(run_id))

    @app.get('/api/runs/{run_id}/raw')
    def raw(run_id: str):
        row = run(run_id)
        return FileResponse(application.directory(run_id) / row['raw_file'], media_type='application/json', filename='Studio_original.json')

    @app.get('/api/runs/{run_id}/document.pdf')
    def pdf(run_id: str):
        run(run_id)
        path = application.pdf_path(run_id)
        name = 'TradeMatch_' + hashlib.sha256(str(path).encode()).hexdigest()[:12] + '.pdf'
        return FileResponse(path, media_type='application/pdf', filename=name, content_disposition_type='inline',
                            headers={'Content-Security-Policy': "frame-ancestors 'self'"})

    @app.get('/api/runs/{run_id}/preview.png')
    def preview(run_id: str, page: int = 1):
        run(run_id)
        return FileResponse(application.preview(run_id, page), media_type='image/png')

    @app.get('/api/runs/{run_id}/report.html')
    def report(run_id: str, view: str = ''):
        row = run(run_id)
        headers = {'Content-Security-Policy': "default-src 'none'; style-src '" + style_hash() + "'; frame-ancestors 'none'; base-uri 'none'"}
        if view != '1':
            headers['Content-Disposition'] = 'attachment; filename="TradeMatch_report.html"'
        return Response(report_html(row, include_technical=deployment_access is None), media_type='text/html', headers=headers)

    @app.post('/api/upload')
    async def upload(request: Request, filename: str = 'document.pdf'):
        body = await bounded_body(request, MAX_UPLOAD)
        row = await run_in_threadpool(application.start_upload, filename, body)
        return result(row, 202)

    @app.post('/api/{operation}')
    async def operation(operation: str, request: Request):
        if operation not in {'settings', 'retrieve'}:
            return result({'error': '요청을 찾을 수 없습니다.'}, 404)
        body = await bounded_body(request, 64 * 1024)
        value = json.loads(body or '{}')
        if operation == 'settings':
            if not isinstance(value, dict) or set(value) - SETTINGS_KEYS:
                raise ValueError('API 키는 저장할 수 없습니다. Agent·Project·Config·판정 노드만 설정하세요.')
            ConnectionSettings.model_validate(value)
            return result(await run_in_threadpool(application.save_settings, value))
        job = ExistingJob.model_validate(value)
        return result(await run_in_threadpool(application.retrieve_existing, job.job_id), 202)

    @app.post('/api/runs/{run_id}/resume')
    async def resume(run_id: str, request: Request):
        await bounded_body(request, 64 * 1024)
        run(run_id)
        return result(await run_in_threadpool(application.resume, run_id), 202)

    @app.post('/api/demo/load')
    async def load_demo(request: Request):
        await bounded_body(request, 64 * 1024)
        await run_in_threadpool(application.seed_demo)
        return result(application.demo_cases())

    return app
