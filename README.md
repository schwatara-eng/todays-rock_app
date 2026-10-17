# TODAY’S ROCK — 오늘의 록

현재 위치의 날씨와 사용자의 기분을 바탕으로 록 음악 3곡을 추천하는 웹앱입니다. 음악 뉴스와 뮤지션 기사를 제공하며, 로컬 편집실에서 기사 원고를 저장하고 AI 검색·사실 검수·에디토리얼 리뷰를 진행합니다.

기준일: 2026-10-17. 수업 과제용 로컬 개발 상태이며, 기존 Vercel 배포는 철회했습니다.

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
| Node.js / OpenAI SDK | 편집실 내부 검색·검수 로직 실행 |
| JSON 파일 | 원고·팩트시트·검수·승인 기록 저장 |
| VS Code Live Server | 현재 홈페이지 화면 제공, 보통 포트 5500 |

편집실은 `http://localhost:8000/editor/`로 접속합니다. 별도의 편집실 실행 명령은 필요하지 않습니다. `editor_bridge.py`가 편집실 최초 접속 시 내부 Node.js 작업자를 `127.0.0.1:4178`에서 자동 시작하고 요청을 전달합니다. 정상 종료 시 작업자도 종료합니다.

이는 **접속 주소와 실행 명령을 FastAPI로 통합한 구조**입니다. 내부 Node.js 작업자는 남아 있으므로 Python 단일 프로세스 구조는 아닙니다. 모든 서버 로직을 Python으로 작성해야 하는 과제라면 추가 이식이 필요합니다.

## 주요 파일

```text
todays-rock_app/
├── main.py                         # 곡 조회·뉴스 수집/번역 및 편집실 라우터 연결
├── editor_bridge.py                # 편집실 연결·내부 작업자 실행/종료
├── editor_ai/                      # 기존 JavaScript 검색·검수 모듈
├── scripts/
│   └── admin-local-fastapi.mjs      # 편집실 내부 작업자
├── admin/                          # 편집실 HTML·CSS·JavaScript
├── articles/                       # 초안·조사·검수·승인 JSON
├── facts/                          # 수동 팩트시트
├── db/
│   └── todays_rock.sql             # MySQL 구조와 초기 500곡
├── index.html
├── artist-jack-white.html
├── script.js
├── style.css
├── images/
├── fonts/
├── package.json
├── package-lock.json
└── README.md
```

기존 `api/`의 편집실 모듈은 `editor_ai/`로 옮겼습니다. 뉴스 처리는 `main.py`로 옮겼습니다. 현재 실행에는 예전 `server.js`, `scripts/admin-local.mjs`, `vercel dev`가 필요하지 않습니다. 예전 실행 스크립트가 삭제한 파일을 가리키는 경우 `package.json`의 해당 명령도 정리해야 합니다.

## 처음 설치할 때

프로젝트 폴더를 VS Code로 열고 PowerShell 터미널에서 진행합니다. Python, Node.js 및 MySQL Server가 필요합니다. 기존에 설치했다면 다시 만들 필요가 없습니다.

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
.\.venv\Scripts\python.exe -m pip install fastapi uvicorn pymysql cryptography python-dotenv httpx
```

이후 명령은 가상환경의 Python을 직접 지정하므로 별도 활성화 없이 실행할 수 있습니다.

### 3. Node.js 패키지 설치

```powershell
npm.cmd install
```

편집실에서 OpenAI SDK를 사용하므로 Node.js와 npm 패키지는 계속 필요합니다. 기존 `package.json`과 `package-lock.json`을 유지합니다.

### 4. 환경변수 설정

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

기존 설정이 있으면 그대로 유지합니다. `main.py`는 프로젝트의 `.env`를 읽어야 하며, 편집실 작업자는 해당 설정을 이어받습니다. 번역 설정이나 요청에 문제가 있으면 뉴스가 영어 원문으로 표시될 수 있습니다.

## 실행 방법

1. 로컬 MySQL 서비스가 실행 중인지 확인합니다. Workbench 창은 계속 열어둘 필요가 없습니다.
2. 프로젝트 최상위에서 메인 서버를 실행합니다.

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

3. 홈페이지는 `index.html`을 Live Server로 엽니다.
4. 편집실은 `http://localhost:8000/editor/`로 접속합니다.

| 확인할 곳 | 주소 및 정상 결과 |
| --- | --- |
| 홈페이지 | Live Server 주소, 보통 `http://127.0.0.1:5500/index.html` — 추천곡·뉴스 표시 |
| 곡 API | `http://localhost:8000/api/songs` — 곡 목록 JSON |
| 뉴스 API | `http://localhost:8000/api/news` — 뉴스 목록 JSON |
| API 문서 | `http://localhost:8000/docs` |
| 편집실 | `http://localhost:8000/editor/` — 원고와 검수 화면 |

홈페이지 `script.js`의 곡·뉴스 요청 주소는 FastAPI의 8000 포트를 사용합니다. Live Server 포트가 달라지면 FastAPI의 CORS 허용 주소도 확인합니다. 편집실은 현재 8000 포트를 기준으로 쓰기 요청을 검사합니다.

종료는 메인 서버 터미널에서 `Ctrl+C`를 누릅니다. 내부 4178 작업자를 따로 실행하거나 브라우저로 직접 접속할 필요는 없습니다.

## 편집실 사용 흐름

1. 에디터가 제목·본문을 작성하고 저장합니다.
2. 주장별 출처를 조사하고 사실 검수 결과를 확인합니다.
3. 에디토리얼 리뷰를 진행하고 지적 사항을 수정합니다.
4. 원고 수정 후 필요한 조사·검수를 다시 진행합니다.
5. 승인 조건을 충족하면 승인하고 해당 버전의 JSON을 내보냅니다.

원고가 바뀌면 기존 승인은 유효하지 않습니다. 미검증 주장, 오래된 검토 결과 또는 검토 지적 사항 등이 남아 있으면 승인이 차단됩니다. 내보내기는 홈페이지 자동 게시와 다릅니다. 최종 공개 반영은 별도로 수행합니다.

현재 편집실은 잭 화이트 원고 경로를 기준으로 동작합니다. AI 기사 자동 생성은 비활성화되어 있으며 `/local/generate`는 410을 반환합니다. 초안은 에디터가 직접 작성합니다.

AI가 찾은 링크와 검수 결과만으로 사실을 확정하지 않습니다. 수치·날짜·수상 기록·인용문 등은 에디터가 출처 원문과 대조합니다. 검색 실패는 해당 주장이 거짓이라는 뜻이 아닙니다.

## 확인한 상태와 남은 범위

- 로컬 MySQL의 데이터 수량과 홈페이지 추천곡·뉴스 표시 확인
- FastAPI 편집실 접속 및 데이터 로드 확인
- 임시 테스트 데이터로 원고 저장, 미검수 승인 차단, 미승인 내보내기 차단, 다른 출처의 쓰기 요청 차단 확인
- 실제 사용자 원고에 대한 외부 검색·유료 AI 호출·승인·내보내기 전체 흐름은 별도 실행 확인 필요
- 기사 관련 기록은 JSON 저장이며 MySQL로 이전하지 않음
- 내부 JavaScript 검수 로직의 전체 Python 이식은 미진행
- PostgreSQL·Supabase 전환 및 재배포는 향후 검토 사항

## GitHub에 올릴 때

소스코드, SQL, 필요한 기사 자료, `package.json`, `package-lock.json`을 보관합니다. `.env`, `.venv/`, `node_modules/`, `__pycache__/`, `.vercel/`은 Git 추적 대상에서 제외합니다.

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
