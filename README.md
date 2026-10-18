# TODAY’S ROCK — 오늘의 록

현재 위치의 날씨와 사용자의 기분을 바탕으로 록 음악 3곡을 추천하는 웹앱입니다. 음악 뉴스와 뮤지션 기사를 제공하며, 로컬 편집실에서 기사 원고를 저장하고 AI 검색·사실 검수·에디토리얼 리뷰를 진행합니다.

기준일: 2026-10-18. 수업 과제용 로컬 개발 상태이며, 기존 Vercel 배포는 철회했습니다.

## 주요 기능

- MySQL에 저장한 500곡을 조회해 날씨·기분에 맞는 음악 추천
- 곡의 주제·분위기·추천 이유와 YouTube·가사 링크 제공
- Open-Meteo 날씨 및 BigDataCloud 지역명 조회
- NME 음악 뉴스 RSS 수집 및 Google Cloud Translation API 한국어 번역
- 오늘의 뮤지션 기사와 기존 홈페이지 형식의 편집실 미리보기
- 수동 원고 작성·저장, 주장별 출처 검색, 사실 검수, 에디토리얼 리뷰
- 검토 조건을 충족한 원고 승인 및 승인 버전 JSON 내보내기

## 현재 개발 구조

| 구성 | 역할 |
| --- | --- |
| HTML / CSS / JavaScript | 홈페이지와 편집실 화면 |
| FastAPI / Uvicorn | 곡·뉴스 API와 편집실 접속을 받는 메인 서버, 포트 8000 |
| MySQL / PyMySQL | 500곡 및 기분·날씨 연결 데이터 저장·조회 |
| Python / httpx | OpenAI Responses API 호출 및 출처 본문 대조 |
| JSON 파일 | 원고·팩트시트·검수·승인 기록 저장 |
| FastAPI 정적 파일 제공 | 홈페이지·기사·이미지·폰트를 같은 8000 서버에서 제공 |

편집실은 `http://localhost:8000/editor/`로 접속합니다. FastAPI가 편집실 화면·원고 저장·검색·검수·승인·내보내기를 모두 처리합니다. 내부 Node.js 작업자와 4178 포트는 사용하지 않습니다. 곡·뉴스·편집실 서버를 실행하는 명령은 하나입니다.

홈페이지와 편집실을 모두 FastAPI에서 제공합니다. Live Server는 필요하지 않습니다. 홈페이지는 `/`, 편집실은 `/editor/`이며 CSS·JavaScript 경로를 분리해 디자인 충돌을 방지합니다.

## 주요 파일

```text
todays-rock_app/
├── main.py                         # 곡 조회·뉴스 수집/번역 및 편집실 라우터 연결
├── editor_bridge.py                # main.py import 호환용, Python 라우터 연결
├── editor_python/                  # Python 편집실 구현
│   ├── routes.py                   # 화면·저장·검토·승인·내보내기
│   ├── ai.py                       # OpenAI 호출·검색·안전한 본문 수집·인용 대조
│   └── prompts.json                # 기존 프롬프트·JSON 스키마
├── requirements.txt                # Python 의존 패키지
├── admin/                          # 편집실 HTML·CSS·JavaScript
├── articles/                       # 초안·조사·검수·승인 JSON
├── db/
│   └── todays_rock.sql             # MySQL 구조와 초기 500곡
├── index.html
├── artist-jack-white.html
├── script.js
├── style.css
├── images/
├── fonts/
└── README.md
```

기존 `editor_ai/`와 `scripts/admin-local-fastapi.mjs`는 `editor_python/`로 대체했습니다. `editor_bridge.py`는 같은 이름의 Python 연결 파일로 교체합니다. 기존 `main.py`의 아래 연결 코드는 유지합니다.

```python
from editor_bridge import router as editor_router
app.include_router(editor_router)
```

`app = FastAPI(...)` 선언 뒤에 있어야 합니다. 원래 곡·뉴스 API와 `.env` 로드는 그대로 유지합니다. `api/`, `server.js`, `scripts/admin-local.mjs`, `vercel dev`는 현재 서버 실행에 필요하지 않습니다.

## 처음 설치할 때

프로젝트 폴더를 VS Code로 열고 PowerShell 터미널에서 진행합니다. Python 및 MySQL Server가 필요합니다. 기존에 설치했다면 다시 만들 필요가 없습니다.

### 1. MySQL 데이터 준비

MySQL Workbench에서 로컬 서버에 접속하고 `db/todays_rock.sql`을 실행합니다.

**주의: 이 SQL은 기존 관련 뷰·테이블을 삭제한 뒤 다시 만듭니다. 데이터 수정 후에는 백업 없이 재실행하지 마세요.**

정상 확인 수치:

| 대상 | 행 수 |
| --- | ---: |
| songs | 500 |
| song_moods | 1082 |
| song_weathers | 1094 |

`v_songs`는 곡과 연결 태그를 묶어 조회하는 뷰입니다. API는 기분·날씨를 배열로 바꾸고 `lyrics_url`을 화면에서 쓰는 `lyricsUrl`로 변환합니다.

### 2. Python 패키지 설치

이미 정상 실행되는 `.venv`가 있다면 그대로 사용합니다. 새 환경이 필요한 경우:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

이후 명령은 가상환경의 Python을 직접 지정하므로 별도 활성화 없이 실행할 수 있습니다.

### 3. 환경변수 설정

프로젝트 최상위의 로컬 `.env`에 아래 항목을 설정합니다. 아래 값은 예시이며 실제 비밀값은 GitHub에 올리지 않습니다.

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=실제_MySQL_비밀번호
DB_NAME=todays_rock
GOOGLE_TRANSLATE_API_KEY=실제_번역_API_키
OPENAI_API_KEY=실제_OpenAI_API_키
ADMIN_SECRET=로컬_편집실용_비밀값
# OPENAI_MODEL=사용할_모델명
```

기존 설정이 있으면 그대로 유지합니다. `main.py`는 프로젝트의 `.env`를 읽어야 하며, Python 편집실은 같은 프로세스의 설정을 사용합니다. 번역 설정이나 요청에 문제가 있으면 뉴스가 영어 원문으로 표시될 수 있습니다.

## 실행 방법

1. 로컬 MySQL 서비스가 실행 중인지 확인합니다. Workbench 창은 계속 열어둘 필요가 없습니다.
2. 프로젝트 최상위에서 메인 서버를 실행합니다.

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

3. 홈페이지는 `http://localhost:8000/`로 접속합니다.
4. 편집실은 `http://localhost:8000/editor/`로 접속합니다.

| 확인할 곳 | 주소 및 정상 결과 |
| --- | --- |
| 홈페이지 | `http://localhost:8000/` — 추천곡·뉴스 표시 |
| 곡 API | `http://localhost:8000/api/songs` — 곡 목록 JSON |
| 뉴스 API | `http://localhost:8000/api/news` — 뉴스 목록 JSON |
| API 문서 | `http://localhost:8000/docs` |
| 편집실 | `http://localhost:8000/editor/` — 원고와 검수 화면 |

홈페이지 `script.js`는 같은 서버의 `/api/songs`, `/api/news`로 요청합니다. localhost와 127.0.0.1 어느 쪽으로 열어도 같은 출처를 유지합니다. 편집실은 현재 8000 포트를 기준으로 쓰기 요청을 검사합니다.

종료는 메인 서버 터미널에서 `Ctrl+C`를 누릅니다. 추가 서버나 Node.js 실행은 필요하지 않습니다. 로컬 개발에서는 Uvicorn 작업자 하나를 사용합니다.

## 편집실 사용 흐름

1. 상단에서 뮤지션을 고르거나 **새 뮤지션 추가**로 이름과 파일 ID를 입력한 뒤, 제목·본문을 작성하고 저장합니다.
2. 주장별 출처를 조사하고 사실 검수 결과를 확인합니다.
3. 에디토리얼 리뷰를 진행하고 지적 사항을 수정합니다.
4. 원고 수정 후 필요한 조사·검수를 다시 진행합니다.
5. 승인 조건을 충족하면 승인하고 해당 버전의 JSON을 내보냅니다.

원고가 바뀌면 기존 승인은 유효하지 않습니다. 미검증 주장, 오래된 검토 결과 또는 검토 지적 사항 등이 남아 있으면 승인이 차단됩니다. 내보내기는 홈페이지 자동 게시와 다릅니다. 최종 공개 반영은 별도로 수행합니다.

원고·팩트시트·검수·승인 기록은 뮤지션별 파일에 따로 저장됩니다. 파일 ID가 `kim-yuna`라면 다음과 같습니다.

| 기록 | 파일 |
| --- | --- |
| 원고 | `articles/drafts/kim-yuna.json` |
| 팩트시트 | `articles/research/kim-yuna.json` |
| 사실 검수 | `articles/reviews/kim-yuna.json` |
| 편집 검토 | `articles/reviews/kim-yuna-editorial.json` |
| 승인 | `articles/approvals/kim-yuna.json` |

각 파일에는 해당 뮤지션의 현재 원고 기준 최신 결과만 남습니다. 뮤지션 목록은 `articles/drafts/`에 있는 원고 파일로 만들어집니다. AI 기사 자동 생성은 비활성화되어 있으며 `/local/generate`는 410을 반환합니다. 초안은 에디터가 직접 작성합니다.

AI가 찾은 링크와 검수 결과만으로 사실을 확정하지 않습니다. 수치·날짜·수상 기록·인용문 등은 에디터가 출처 원문과 대조합니다. 검색 실패는 해당 주장이 거짓이라는 뜻이 아닙니다.

## 확인한 상태와 남은 범위

- 로컬 MySQL의 데이터 수량과 홈페이지 추천곡·뉴스 표시 확인
- 사용자 환경에서 Python 편집실 화면·데이터 로드·실제 AI 에디토리얼 리뷰·출처 재검색 작동 확인
- 홈페이지 통합판: 홈페이지/편집실 자산 경로 분리와 API 연결은 로컬 모의 테스트로 확인; 실제 화면과 MySQL·뉴스 재확인은 적용 후 진행
- Python 전환판: 임시 데이터와 모의 AI 응답으로 저장·그룹 조사·개별 재검색 이력·검토·승인·내보내기·수정 후 승인 무효화 확인
- 기존 JS/Python 기사 해시 일치, 미검수 승인 차단, 잘못된 출처·호스트·큰 요청 차단, 검색 결과 밖 URL 및 출처에 없는 인용문 배제 확인
- 실제 사용자 원고에 대한 외부 검색·유료 AI 호출·승인·내보내기 전체 흐름은 별도 실행 확인 필요
- 기사 관련 기록은 JSON 저장이며 MySQL로 이전하지 않음
- 편집실 검색·검수·저장·승인 로직의 Python 전환 완료
- PostgreSQL·Supabase 전환 및 재배포는 향후 검토 사항

## GitHub에 올릴 때

소스코드, SQL, 필요한 기사 자료와 `requirements.txt`를 보관합니다. 현재 앱 실행에는 npm 패키지가 필요하지 않습니다. 다른 도구가 npm을 사용한다면 해당 설정은 별도로 보관합니다. `.env`, `.venv/`, `node_modules/`, `__pycache__/`, `.vercel/`은 Git 추적 대상에서 제외합니다.

`.gitignore` 예시:

```gitignore
.env
.env.*
!.env.example
.venv/
node_modules/
__pycache__/
*.pyc
.vercel/
```

이미 Git에 추적된 파일은 `.gitignore`에 추가하는 것만으로 제외되지 않으므로 커밋 목록을 확인합니다. 키 값과 DB 비밀번호는 문서·화면 코드·커밋에 포함하지 않습니다.

이 문서는 기존 `README-관리자편집기.md`와 `README-통합안내.md`의 안내를 현재 구조에 맞춰 통합한 문서입니다. 교체 후 두 안내 파일은 삭제할 수 있습니다. 예전 Vercel 개발 서버 및 기사 자동 생성 안내는 현재 실행 방식에 적용하지 않습니다.

