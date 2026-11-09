"""Cloud entry point. Local startup remains in service.server."""
import os
from pathlib import Path
import re

from .access import DeploymentAccess
from .server import Application
from .web import create_app


def configuration(env):
    required = ('TRADEMATCH_PUBLIC_URL', 'TRADEMATCH_ACCESS_USER', 'TRADEMATCH_ACCESS_PASSWORD',
                'TRADEMATCH_STATE_DIR', 'UPSTAGE_API_KEY', 'UPSTAGE_AGENT_ID', 'UPSTAGE_PROJECT_ID', 'UPSTAGE_CONFIG_ID')
    if any(not env.get(name, '').strip() for name in required):
        raise ValueError('배포에 필요한 환경변수가 없습니다. 배포 안내의 필수 항목을 확인하세요.')
    access = DeploymentAccess(env['TRADEMATCH_PUBLIC_URL'], env['TRADEMATCH_ACCESS_USER'], env['TRADEMATCH_ACCESS_PASSWORD'])
    for name, prefix in [('UPSTAGE_AGENT_ID', 'agt_'), ('UPSTAGE_PROJECT_ID', 'proj_')]:
        if not re.fullmatch(prefix + r'[A-Za-z0-9]+', env[name]):
            raise ValueError('배포할 Agent ID·Project ID 형식을 확인하세요.')
    if not env['UPSTAGE_CONFIG_ID'].isdigit() or int(env['UPSTAGE_CONFIG_ID']) < 1:
        raise ValueError('UPSTAGE_CONFIG_ID에는 저장된 Config의 양의 정수 번호가 필요합니다.')
    state = Path(env['TRADEMATCH_STATE_DIR'])
    if not state.is_absolute() or state == Path('/'):
        raise ValueError('TRADEMATCH_STATE_DIR에는 영구 저장 공간의 절대 경로가 필요합니다.')
    mount = env.get('RAILWAY_VOLUME_MOUNT_PATH')
    if env.get('RAILWAY_ENVIRONMENT_ID') and not mount:
        raise ValueError('Railway 서비스에 영구 저장 Volume을 연결하세요.')
    if mount and not state.resolve().is_relative_to(Path(mount).resolve()):
        raise ValueError('기록 저장 경로가 Railway Volume 안에 있어야 합니다.')
    try:
        port = int(env.get('PORT', '8080'))
    except ValueError:
        raise ValueError('PORT는 올바른 포트 번호여야 합니다.') from None
    if not 1 <= port <= 65535:
        raise ValueError('PORT는 올바른 포트 번호여야 합니다.')
    return access, state, port


def create_deployment_app():
    access, state, _ = configuration(os.environ)
    application = Application(state)
    # The deployed workflow is controlled by environment variables, not stale local settings.
    if (state / 'settings.json').exists():
        application.close()
        raise ValueError('배포 저장 공간에 로컬 settings.json이 있습니다. 새 빈 Volume으로 배포하세요.')
    return create_app(application, close_on_shutdown=True, deployment_access=access)


def main():
    import uvicorn
    try:
        _, _, port = configuration(os.environ)
        app = create_deployment_app()
    except ValueError as exc:
        raise SystemExit(str(exc)) from None
    uvicorn.run(app, host='0.0.0.0', port=port, workers=1, access_log=False, log_level='warning')


if __name__ == '__main__':
    main()
