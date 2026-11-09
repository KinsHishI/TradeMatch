# TradeMatch 초대형 시연 배포

GitHub 코드 저장소 → Railway Docker 서비스 한 개 → Upstage Studio.
화면과 Python API를 함께 제공하고, 파일과 기록은 Volume에 보관한다.

이 폴더에는 실행 코드와 배포 설정만 포함한다. API 키, 접속 암호, 원본 PDF, 로컬 검증 기록, 기대값, Studio 원시 응답, 과거 워크플로우 Export는 포함하지 않는다.

## 공개 범위

공유 ID·암호를 아는 시연 참여자는 같은 문서와 기록을 볼 수 있다. 사용자별 계정·문서 분리가 있는 일반 공개 서비스는 아니다. 관리자 설정, 임의 Job 가져오기, 개발자 화면과 예시 적재는 배포 모드에서 차단한다.

로그인한 참여자가 PDF를 등록하면 실제 Upstage API 비용이 발생한다. 테스트 PDF를 사용하는 제한된 시연으로 시작한다. 키와 암호는 Railway Variables에서만 등록하며 채팅·GitHub·파일에 적지 않는다.

## GitHub에 올릴 위치

이 README, Dockerfile, railway.toml, service 폴더가 있는 **코드 전용 폴더**를 저장소 루트로 사용한다. 원래 TradeMatch_Local_Project 전체를 업로드하지 않는다.

GitHub 저장소에 이 폴더를 연결한다. 저장소 공개 여부와 서비스 접속 암호는 별개이며, 이 패키지는 코드만 포함한다. DEPLOY_MANIFEST.json은 포함 파일과 SHA-256 목록이다. 실제 서비스 상태는 포함하지 않는다.

## Railway 설정 순서

1. GitHub 저장소를 연결해 서비스를 만든다. Dockerfile을 자동 감지한다.
2. Volume을 추가하고 `/data`에 연결한다. 여러 replica를 사용하지 않는다.
3. Variables에 아래 값을 등록한다. 시연 암호와 Upstage 키는 직접 입력하며 저장소에 넣지 않는다.
4. Networking에서 도메인을 만들고 HTTPS 주소를 TRADEMATCH_PUBLIC_URL에 지정한다. 필요한 경우 대상 포트는 8080으로 지정한다.
5. 환경변수·Volume이 준비되면 배포한다. 설정 전 초기 빌드가 실행되더라도 앱은 필수 설정이 없으면 외부 기능을 열지 않고 종료한다.
6. HTTPS 주소로 접속해 브라우저의 ID·암호 창에서 시연용 계정으로 들어간다. 현재 검증 환경은 조회만 가능하다.
7. 동일한 테스트 PDF로 등록 → 대기 → 결과 → 원문 비교 → 보고서 → 기록을 확인한다. 이 단계는 실제 API 비용이 발생하므로 배포 준비 점검과 구분한다.

| 환경변수 | 값 |
|---|---|
| TRADEMATCH_PUBLIC_URL | 생성한 HTTPS 주소. 경로·쿼리 없이 지정 |
| TRADEMATCH_ACCESS_USER | 직접 정한 시연용 사용자 이름 |
| TRADEMATCH_ACCESS_PASSWORD | 직접 정한 16자 이상의 시연용 비밀 암호 |
| TRADEMATCH_STATE_DIR | `/data` |
| UPSTAGE_API_KEY | Upstage API 키를 Variables에서 직접 입력 |
| UPSTAGE_AGENT_ID | 실제 Agent ID |
| UPSTAGE_PROJECT_ID | 해당 Project ID |
| UPSTAGE_CONFIG_ID | Studio에 저장·확인한 Config 번호 |
| UPSTAGE_DECISION_NODE | 선택. 실제 판정 노드 이름 |
| PORT | Railway가 제공하는 값. 지정하지 않으면 8080 |

RAILWAY_VOLUME_MOUNT_PATH는 Volume 연결 시 Railway가 제공한다. Railway에서는 Volume이 없거나 기록 경로가 Volume 밖이면 시작을 중단한다. 새 빈 Volume으로 시작한다. 로컬 settings.json을 복사하지 않는다.

Agent·Project·Config는 서버 환경변수로 고정한다. 화면의 설정 변경 요청은 거절한다. 환경을 바꿀 때에는 Variables를 수정하고 재배포한다. 로컬 JSON 수정은 원격 Studio 워크플로우를 변경하지 않는다.

## 재배포와 기록

파일·기록은 `/data`에 남는다. 진행 중 재배포하면 저장한 Job ID는 보존하고 조회를 일시중지한다. 기록에서 이어서 결과 확인을 누른다. 업로드나 새 Job 생성을 자동 반복하지 않는다.

한 서비스·한 실행 프로세스 구성을 유지한다. 실제 작업 중에는 코드 자동 재배포를 피하고 시연 전 최종 버전을 확정한다. Volume 백업도 별도로 설정한다.

## 확인 명령

설치된 환경에서 접근 경계 테스트:

```sh
python -m unittest service.tests.test_deployment -v
```

컨테이너 빌드:

```sh
docker build -t tradematch-demo .
```

컨테이너 시작에는 위 필수 환경변수와 `/data` 영구 저장 공간이 필요하다. 필수값 없는 컨테이너의 실행 실패는 의도된 동작이다. `/api/health`의 GET만 인증 없이 서비스 이름·버전을 반환한다. 문서·기록·업로드·정적 화면은 모두 인증을 요구한다.

## 공식 참고

- [Railway FastAPI / GitHub / Dockerfile](https://railway.com/guides/fastapi)
- [Volumes](https://docs.railway.com/volumes)
- [Config as Code](https://docs.railway.com/config-as-code/reference)
- [Healthchecks](https://docs.railway.com/deployments/healthchecks)
