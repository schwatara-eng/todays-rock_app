# TODAY’S ROCK 편집실 FastAPI 연결

기존 main.py의 곡 조회·뉴스 번역 기능을 유지하고 편집실을 연결합니다.
FastAPI가 접속을 받고 기존 JavaScript 검색·검수 로직은 내부 Node.js 작업자가 실행합니다.
전체 Python 이식본이 아닙니다. Vercel 배포나 vercel dev는 필요하지 않습니다.

## 적용

1. ZIP 내부의 editor_bridge.py, editor_ai, scripts, admin을 프로젝트 최상위에 복사합니다.
   main.py와 .env가 있는 위치입니다. 기존 admin/index.html·style.css, articles, facts, images, fonts는 보관합니다.
   admin/app.js는 사용자가 첨부한 최신 파일과 동일합니다. 원고·검수 기록 파일은 포함하거나 덮어쓰지 않습니다.
2. main.py에서 `app = FastAPI(...)` 선언 바로 아래에 다음 두 줄을 추가합니다.

   from editor_bridge import router as editor_router
   app.include_router(editor_router)

   이 코드는 함수 내부가 아닌 파일 최상위에 있어야 합니다.
   기존 load_dotenv(...) 및 곡·뉴스 API 코드는 그대로 둡니다.
3. .env에 ADMIN_SECRET과 OPENAI_API_KEY가 있는지 확인합니다. 기존 값이 있으면 유지합니다.
   비밀값은 채팅이나 GitHub에 올리지 않습니다.
   OPENAI_MODEL 등 기존 AI 설정도 그대로 읽습니다.
4. 기존 FastAPI를 Ctrl+C로 종료한 뒤 다시 실행합니다.

   .\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000

5. 편집실: http://localhost:8000/editor/
   홈페이지: 기존 Live Server 주소. 곡·뉴스는 계속 FastAPI 8000을 사용합니다.

## 내부 작업자

편집실 최초 접속 시 FastAPI가 내부 Node.js 작업자를 127.0.0.1:4178에서 자동 시작합니다.
직접 실행할 명령은 없습니다. 정상 서버 종료 시 작업자도 종료됩니다.
Node.js 및 기존 프로젝트의 openai npm 패키지가 필요합니다.
4178을 다른 프로그램이 사용하면 오류를 표시하며 임의로 해당 프로그램에 연결하지 않습니다.
기존 scripts/admin-local.mjs와 server.js는 삭제하지 않으며, 이 연결을 위해 실행하지 않습니다.

## 유지한 기능

- 기존 원고·팩트시트·검토·승인 JSON 저장 경로와 데이터 형식
- 원고 변경에 따른 승인 무효화 및 기사 버전 해시
- 전체·그룹·개별 주장 조사, 사실 검수, 에디토리얼 리뷰
- 미검증 주장·검토 지적 사항이 남았을 때 승인 차단
- 승인 버전이 일치할 때만 JSON 내보내기 (자동 게시하지 않음)
- 기존 홈페이지 템플릿 미리보기
- 기존 AI 초안 생성 비활성 정책: /local/generate는 410 반환

## 확인한 테스트

실제 키·사용자 원고 대신 임시 테스트 파일을 사용했습니다.
FastAPI 편집실 화면·자산 전달, 내부 작업자 자동 시작, 원고 불러오기·저장,
미검수 원고 승인 차단(409), 미승인 내보내기 차단, 외부 출처 쓰기 차단(403),
.env 접근 차단, AI 모듈 직접 호출 및 키 미설정 오류 전달을 확인했습니다.
실제 OpenAI 유료 호출·외부 웹 검색과 사용자 화면 전체 조합은 아직 검증하지 않았습니다.
실제 검수 버튼은 기존처럼 OpenAI 비용이 발생할 수 있습니다.

## 범위

곡 데이터는 MySQL, 편집실 기록은 기존 JSON입니다.
편집실 기록의 MySQL 전환과 검수 로직 전체 Python 이식은 이번 수정에 포함되지 않습니다.
Node 작업자를 사용하므로 과제가 모든 서버 로직을 Python으로 요구한다면 추가 이식이 필요합니다.
