# TODAY’S ROCK — 오늘의 록

현재 위치의 날씨와 사용자의 기분을 바탕으로 록 음악 3곡을 추천하는 웹앱입니다. 음악 뉴스와 '오늘의 뮤지션' 기사를 제공하고, 회원 계정으로 좋아요를 저장하며, 편집실에서 기사 원고를 작성·검수·승인·게시합니다.

기준일: 2026-10-19. 수업 과제용 로컬 개발 상태이며, 기존 Vercel 배포는 철회했습니다.

## 주요 기능

**홈페이지**
- PostgreSQL(Supabase)에 저장한 500곡 가운데 날씨·기분에 맞는 3곡 추천, YouTube·가사 링크 제공
- Open-Meteo 날씨와 BigDataCloud 지역명 조회
- NME 음악 뉴스 RSS 수집과 Google Cloud Translation API 한국어 번역
- 오늘의 뮤지션 기사와 지난 뮤지션 아카이브

**회원**
- 이메일·비밀번호 회원가입/로그인/로그아웃, 닉네임·비밀번호 변경
- 사용자/기자/관리자 권한 분리, 관리자의 회원 검색·권한 변경·정지/복구
- 추천곡 좋아요 저장, 마이페이지에서 계정별 좋아요 목록 열람·취소

**편집실**
- 원고 작성·저장, 주장별 팩트시트와 웹 출처 검증, AI 사실 검수
- AI 편집 검토와 에디터의 원고 수정·패스 처리 기록
- 검증 완료·처리·승인 항목 도장 표시, 승인 후 JSON 내보내기와 홈 게시

## 구성

| 구성 | 역할 |
| --- | --- |
| HTML / CSS / JavaScript | 홈페이지, 회원 화면, 편집실 화면 |
| FastAPI / Uvicorn | 곡·뉴스·회원·편집실 API와 모든 화면을 제공하는 단일 서버, 포트 8000 |
| PostgreSQL (Supabase) / psycopg | 500곡과 기분·날씨 태그, 회원·세션·좋아요·권한 변경 기록 |
| Python / httpx | OpenAI Responses API 호출과 출처 본문 대조 |
| PostgreSQL (Supabase) | 기사 원고·팩트시트·검수·승인 기록, 게시된 기사, 편집실에서 올린 뮤지션 사진 (`editor_python/storage.py`) |

서버는 하나만 실행합니다. Node.js, Live Server, `vercel dev`는 필요하지 않습니다.

## 주요 파일

```text
todays-rock_app/
├── main.py                 # 곡·뉴스 API, 화면 제공, 회원·편집실 라우터 연결
├── editor_bridge.py        # 편집실 라우터 연결 (main.py에서 사용)
├── account_system/         # 회원 API·권한 검사·DB·관리자 명령(manage.py)
├── accounts/               # 로그인·회원가입·마이페이지·관리자 화면
├── editor_python/          # 편집실 서버 로직
│   ├── routes.py           # 화면·저장·검토·승인·내보내기
│   ├── ai.py               # OpenAI 호출·검색·본문 수집·인용 대조
│   ├── fact_edit.py        # 팩트시트 항목 수정·분류·제외
│   ├── editorial_edit.py   # 편집 의견 원고 수정·패스·다시 검토
│   ├── publish.py          # 홈 게시·아카이브·백업 (DB에 저장)
│   ├── storage.py          # 편집실 저장소 — Supabase DB 읽기·쓰기, 기존 파일 옮기기
│   └── prompts.json        # AI 프롬프트·JSON 스키마
├── admin/                  # 편집실 HTML·CSS·JavaScript
├── articles/               # 예전 파일 기록 (DB로 옮기기 전 원본, 옮긴 뒤에는 읽기 전용 참고용)
├── db/
│   ├── todays_rock.sql     # 곡 테이블과 초기 500곡
│   └── accounts.sql        # 회원 테이블 (기존 데이터 유지, 서버가 자동 실행)
├── tests/                  # 회원·편집 검토 자동 테스트
├── index.html · script.js · style.css
├── artist-*.html           # 지난 뮤지션 아카이브 페이지
├── artist-archive.json     # 현재·지난 뮤지션 목록
├── images/ · fonts/
└── requirements.txt
```

## 처음 설치할 때

프로젝트 폴더를 VS Code로 열고 PowerShell 터미널에서 진행합니다. 데이터베이스는 **Supabase의 PostgreSQL**을 씁니다. 내 PC에 DB를 설치할 필요가 없고, 로컬 서버와 배포된 사이트가 같은 DB를 함께 씁니다.

### 1. Supabase 프로젝트 만들기

1. [supabase.com](https://supabase.com)에 가입하고 **New project**를 만듭니다.
   - Region: 한국과 가까운 **Northeast Asia (Seoul)** 권장
   - Database Password: 직접 정하고 따로 적어 둡니다. 나중에 다시 볼 수 없습니다.
2. 프로젝트가 만들어지면 위쪽 **Connect** 버튼 → **Connection String** 탭에서 **Transaction pooler** 주소를 복사합니다.
   - 모양: `postgresql://postgres.[프로젝트ID]:[YOUR-PASSWORD]@aws-0-[지역].pooler.supabase.com:6543/postgres` (포트 **6543**)
   - `[YOUR-PASSWORD]` 자리에 1번에서 정한 비밀번호를 넣습니다.
   - Transaction pooler를 쓰는 이유: Vercel처럼 요청마다 잠깐 켜졌다 꺼지는 서버에 맞는 방식이고, 일반 가정·학교 인터넷(IPv4)에서도 접속됩니다. 내 PC와 Vercel에서 같은 주소를 씁니다. Direct connection은 IPv6 전용이라 접속이 안 될 수 있습니다.

### 2. 곡 데이터 넣기

Supabase 대시보드 왼쪽 **SQL Editor** → **New query**에 `db/todays_rock.sql` 내용을 전체 붙여넣고 **Run**을 누릅니다.

**정상 결과:** 마지막 표에 `songs` 500 / `moods` 1082 / `weathers` 1094

**주의:** 이 SQL은 곡 관련 뷰·테이블을 지운 뒤 다시 만듭니다. 회원 테이블(`account_`로 시작)과 좋아요 기록은 건드리지 않습니다.

모든 테이블에는 행 수준 보안(RLS)이 켜져 있습니다. Supabase가 제공하는 브라우저용 공개 API로는 곡·회원 정보를 읽거나 쓸 수 없고, DB 비밀번호로 접속하는 이 앱 서버만 사용할 수 있습니다. Table Editor에 'RLS enabled'로 보이는 것이 정상입니다.

### 3. Python 패키지 설치

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

이미 `.venv`가 있으면 두 번째 줄만 실행합니다. MySQL용 `pymysql` 대신 PostgreSQL용 `psycopg`가 설치됩니다. **정상 결과:** 설치 완료 또는 `Requirement already satisfied`.

### 4. 환경변수 설정

프로젝트 최상위 `.env`를 아래처럼 바꿉니다. 예전 `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` 줄은 지워도 됩니다.

```dotenv
DATABASE_URL=postgresql://postgres.[프로젝트ID]:[비밀번호]@aws-0-[지역].pooler.supabase.com:6543/postgres
GOOGLE_TRANSLATE_API_KEY=실제_번역_API_키
OPENAI_API_KEY=실제_OpenAI_API_키
# OPENAI_MODEL=사용할_모델명
# APP_ORIGIN=https://실제_운영_주소     ← 배포한 사이트에서만 설정
```

- 서버는 `.env`만 읽습니다. `.env.local`은 사용하지 않습니다.
- 비밀번호에 `@`, `#`, `/`, `:` 같은 기호가 있으면 주소가 깨집니다. Supabase에서 영문·숫자로만 된 비밀번호로 다시 설정(Project Settings → Database → Reset database password)하는 것이 가장 간단합니다.
- `DATABASE_URL` 대신 `DB_HOST`, `DB_PORT`(기본 5432), `DB_USER`(기본 postgres), `DB_PASSWORD`, `DB_NAME`, `DB_SSLMODE`로 나눠 적어도 됩니다. 내 PC에 PostgreSQL을 직접 설치해 쓸 때 편합니다.
- 편집실은 회원 권한으로 보호하므로 `ADMIN_SECRET`은 사용하지 않습니다.

### 5. 첫 관리자 만들기 — 한 번만

```powershell
.\.venv\Scripts\python.exe -m account_system.manage create-admin
```

회원 테이블이 없으면 함께 만듭니다. 이메일 → 관리자 닉네임 → 비밀번호 → 비밀번호 확인 순서로 입력합니다. 비밀번호는 10~128자이며 입력 중 화면에 보이지 않습니다. 기본 관리자 계정은 없고, 일반 회원가입으로는 관리자가 될 수 없습니다.

**정상 결과:** `관리자 계정 생성 완료. 홈페이지에서 로그인하세요.`

### 6. 기존 기사 기록을 DB로 옮기기 — 한 번만

```powershell
.\.venv\Scripts\python.exe -m editor_python.storage
```

`articles/` 폴더의 원고·팩트시트·검수·승인 기록을 Supabase로 복사합니다. 편집실 기록 테이블도 이때 만들어집니다. 이미 DB에 있는 기록은 건너뛰므로 여러 번 실행해도 안전합니다(파일 내용으로 덮어쓰려면 끝에 `--force`).

**정상 결과:** `DB로 복사: 10개 — draft/jack-white, draft/kim-yuna, …`

옮기기 전에도 편집실과 홈페이지는 파일 내용을 그대로 보여 주지만, 배포 사이트에서 저장·게시하려면 기록이 DB에 있어야 합니다. 이 단계 이후로 `articles/` 폴더의 파일은 고칠 필요가 없습니다.

**MySQL에서 옮겨 오는 경우:** 곡 데이터는 2번으로 그대로 옮겨집니다. 예전 MySQL에 있던 회원·좋아요 기록은 자동으로 옮기지 않으므로, 관리자 계정을 이 단계에서 새로 만들고 회원은 다시 가입합니다. (수업용 테스트 계정이라면 이 방법이 가장 단순합니다.)

## 실행

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

`http://localhost:8000/`에 접속해 우측 상단 **로그인**으로 들어갑니다. 종료는 서버 터미널에서 `Ctrl+C`입니다. `.env`를 고쳤다면 서버를 껐다 켜야 반영됩니다(`--reload`로는 반영되지 않음). DB는 Supabase에 있으므로 내 PC에서 DB 서비스를 켤 필요가 없습니다.

| 주소 | 내용 |
| --- | --- |
| `/` | 홈페이지 — 추천곡·뉴스·오늘의 뮤지션 |
| `/signup` · `/login` | 회원가입 · 로그인 |
| `/mypage` | 마이페이지 — 프로필, 좋아요 목록, 닉네임·비밀번호 변경 |
| `/admin/` | 관리자 페이지 — 회원 검색·권한·정지/복구, 편집실 링크 |
| `/editor/` | 편집실 (기자·관리자) — 내 PC와 배포 사이트 모두 |
| `/api/songs` · `/api/news` | 곡 · 뉴스 JSON |
| `/docs` | API 문서 |

`localhost`와 `127.0.0.1`은 로그인 쿠키가 따로 저장되므로 한 주소만 계속 사용합니다.

## 회원과 권한

| 구분 | 음악 추천 | 마이페이지·좋아요 | 편집실 | 관리자 페이지 |
| --- | --- | --- | --- | --- |
| 비로그인 | 가능 | 로그인 필요 | 로그인 필요 | 로그인 필요 |
| 사용자 | 가능 | 가능 | 접근 불가 | 접근 불가 |
| 기자 | 가능 | 가능 | 가능 | 접근 불가 |
| 관리자 | 가능 | 가능 | 가능 | 가능 |

- 회원가입은 항상 **사용자**로 처리합니다. 관리자가 관리자 페이지에서 **기자**로 승격하거나 권한을 회수합니다. 바뀐 권한은 다음 요청부터 적용됩니다.
- 편집실 링크는 기자·관리자의 마이페이지와 관리자 페이지에 표시됩니다. 일반 사용자가 `/editor/`로 직접 들어가도 차단됩니다.
- 계정을 정지하면 그 계정의 로그인이 즉시 모두 해제되고, 복구 후에는 다시 로그인해야 합니다.
- 관리자는 자기 계정의 관리자 권한을 없애거나 자기 계정을 정지할 수 없습니다. 권한·정지 변경은 관리자 페이지 하단에 기록됩니다.
- 비밀번호를 바꾸면 다른 기기의 로그인은 해제됩니다.

**확인 순서 (시크릿 창 사용 권장)**

1. 시크릿 창에서 일반 사용자로 가입합니다. 마이페이지에 편집실 버튼이 없어야 합니다.
2. 관리자 창의 관리자 페이지에서 그 회원을 **기자**로 바꾸고 저장합니다.
3. 시크릿 창의 마이페이지를 새로고침하면 역할이 '기자'로 바뀌고 **편집실 열기**가 보입니다.
4. 홈에서 **오늘의 음악 찾기** → 추천곡의 **♡ 좋아요** → 마이페이지 좋아요 목록에 표시되는지 확인합니다. 다른 계정에는 보이지 않아야 합니다.

**보안 처리:** 비밀번호는 scrypt 해시로 저장하고 원문과 로그인 토큰 원문은 DB에 남기지 않습니다. 로그인은 DB에 저장한 서버 세션과 HttpOnly 쿠키(7일 유지)로 처리합니다. 변경 요청에는 로그인·권한·요청 출처·CSRF 토큰 검사를 적용하고, 반복 로그인 시도는 제한합니다.

**아직 없는 기능:** 이메일 인증, 이메일로 비밀번호 재설정, SNS 로그인.

### 관리자 명령

| 명령 | 용도 |
| --- | --- |
| `.\.venv\Scripts\python.exe -m account_system.manage create-admin` | 관리자 계정 만들기 |
| `.\.venv\Scripts\python.exe -m account_system.manage reset-password` | 비밀번호를 잊은 회원의 비밀번호 재설정 (기존 로그인 모두 해제) |
| `.\.venv\Scripts\python.exe -m account_system.manage init` | 회원 테이블만 준비 (기존 데이터 유지) |

`이미 가입한 이메일` 오류가 나면 다른 이메일을 쓰거나 기존 관리자에게 권한 변경을 요청합니다. DB 연결 오류가 나면 `.env`의 `DATABASE_URL`(또는 `DB_` 값들)이 Supabase의 접속 정보와 같은지 확인합니다.

## 편집실 사용 흐름

화면의 번호 순서대로 진행합니다.

1. **01 원고 작성** — 상단에서 뮤지션을 고르거나 **새 뮤지션 추가**로 영문·한글 이름과 파일 ID(예: `kim-yuna`)를 입력합니다. 제목·본문을 쓰고 저장하고, 필요하면 뮤지션 사진(PNG·JPG·WEBP, **4MB 이하**)을 등록합니다.
2. **02·03 팩트시트와 사실 검수** — **팩트시트 생성 + 웹 출처 검증**을 누르면 원고의 주장을 항목별로 뽑아 출처를 찾고 대조합니다. 항목은 직접 수정·분류·제외할 수 있고, 실패한 항목은 개별로 재검색합니다.
3. **04 편집 검토** — **AI 편집 검토**를 실행한 뒤, 각 의견을 처리합니다.
   - **원고 수정:** 바꿀 부분, 수정문, 사유를 입력하고 `원고에 반영 · 수정 처리`. 같은 문구가 여러 곳이면 위치를 고릅니다. 수정문을 비우면 그 부분을 삭제합니다.
   - **패스:** 제안을 적용하지 않는 사유를 입력하고 `사유 기록 후 패스`. 원고는 그대로 유지됩니다.
   - **다시 검토:** `처리한 편집 의견`을 펼쳐 처리한 항목을 대기 상태로 돌립니다. 이미 저장한 원고 수정은 자동으로 되돌리지 않습니다.
4. **05 편집자 승인** — 원출처 대조 확인란을 체크하고 **편집자 승인**을 누릅니다. 승인 후 **승인 기사 JSON 내보내기**를 할 수 있습니다.
5. **06 홈 게시** — 05 박스 오른쪽의 독립 버튼입니다. 승인 전에는 잠겨 있고, 승인하면 빨간 **홈에 게시 ↗**로 켜지며, 게시 후에는 초록 **게시 완료**로 바뀝니다. 원고를 고치고 저장하지 않으면 다시 잠깁니다.

**한눈에 보는 상태 도장**

통과한 칸에는 초록 **APPROVED** 도장, 평론 항목에는 같은 모양의 회색 **CRITIQUE** 도장이 바탕에 찍힙니다. 도장 그림은 `admin/stamp-approved.svg`, `admin/stamp-critique.svg`입니다.

| 도장 | 표시되는 곳 |
| --- | --- |
| 초록 APPROVED | 팩트시트의 검증 완료 항목, 편집 검토에서 수정 반영·패스한 의견, 승인(게시)을 마친 05 승인 칸 |
| 회색 CRITIQUE | 검증 대상이 아닌 평론(의견) 항목 |

**승인 규칙**

- 미검증 주장, 오래된 검토 결과, 처리하지 않은 편집 의견이 있으면 승인할 수 없습니다.
- 원고를 수정하면 기존 승인과 사실 검수가 무효가 됩니다. 팩트시트와 사실 검수를 갱신해야 다시 승인할 수 있습니다. 편집창에서 원고를 직접 고쳤다면 저장 후 AI 편집 검토를 다시 실행합니다.
- AI 편집 검토를 새로 실행하면 새 의견은 모두 대기 상태로 시작하고, 이전 처리 기록은 보존됩니다.
- 다른 창에서 같은 검토를 먼저 처리했다면 오래된 화면의 변경은 거절됩니다. 새로고침한 뒤 다시 확인합니다.
- AI 기사 자동 생성은 비활성화되어 있습니다(`/local/generate`는 410 반환). 초안은 에디터가 직접 씁니다.

**홈에 게시**하면 승인된 원고가 **바로** 홈의 오늘의 뮤지션이 됩니다. 파일을 고치거나 `git push`할 필요가 없습니다. 그전 기사는 지난 뮤지션 목록으로 옮겨져 `artist-<ID>.html` 주소로 계속 볼 수 있습니다.

게시된 기사 본문과 목록은 DB에 저장되고, 홈페이지는 요청 때마다 저장소의 **최신 `index.html` 디자인**에 DB의 기사 본문을 끼워 넣어 보여 줍니다. 그래서 홈 디자인(`index.html`, `style.css`)을 고쳐 `git push`해도 게시한 기사는 그대로 유지됩니다. 게시 직전 상태는 DB의 `site_history` 표에 백업됩니다.

**저장 위치** — 모두 Supabase DB에 있어 내 PC와 배포 사이트가 같은 기록을 봅니다. Supabase 대시보드의 Table Editor에서 직접 볼 수 있습니다.

| 기록 | DB 표 |
| --- | --- |
| 원고·팩트시트·사실 검수·편집 검토(처리자·권한·시간·수정 전후 포함)·승인 | `editor_docs` — 뮤지션 ID와 종류(draft·sheet·review·editorial·approval)별 한 줄 |
| 게시된 기사 본문 (현재·지난 뮤지션) | `site_features` |
| 현재 뮤지션과 지난 뮤지션 목록 | `editor_docs`의 `site` / `archive` 줄 (예전 `artist-archive.json`) |
| 편집실에서 올린 뮤지션 사진 | `site_assets` |
| 게시 직전 백업 | `site_history` |

DB에 아직 없는 기록은 저장소의 예전 파일(`articles/`, `images/`, `artist-archive.json`, `index.html`)을 그대로 읽습니다.

AI가 찾은 링크와 검수 결과만으로 사실을 확정하지 않습니다. 수치·날짜·수상 기록·인용문은 에디터가 출처 원문과 직접 대조합니다. 검색 실패는 해당 주장이 거짓이라는 뜻이 아닙니다. 검색과 AI 호출에는 요금이 발생할 수 있습니다.

## 문제가 생겼을 때

| 증상 | 확인할 것 |
| --- | --- |
| 홈에 "곡 데이터를 불러오지 못했어요" | Supabase SQL Editor에서 `SELECT * FROM v_songs LIMIT 3;` 실행. `relation "v_songs" does not exist`면 `db/todays_rock.sql`을 다시 실행 |
| 서버 터미널에 `password authentication failed` | `DATABASE_URL`의 비밀번호 확인. `[YOUR-PASSWORD]` 괄호까지 지우고 넣었는지 확인 |
| 서버 터미널에 `could not translate host name` 또는 `timeout` | Direct connection 주소(`db.….supabase.co`)를 쓰고 있다면 **Transaction pooler** 주소(포트 6543)로 바꿈 |
| 서버 터미널에 `Tenant or user not found` | pooler 주소의 사용자 이름이 `postgres.[프로젝트ID]` 형태인지 확인 |
| Supabase 프로젝트가 'Paused' | 무료 프로젝트는 오래 쓰지 않으면 일시정지됩니다. 대시보드에서 **Restore** |
| 뉴스가 영어로 나옴 | `.env`의 `GOOGLE_TRANSLATE_API_KEY` 확인 후 서버 재시작 |
| 로그인했는데 로그아웃 상태로 보임 | `localhost`와 `127.0.0.1`을 섞어 쓰지 않았는지 확인 |
| 편집실 접근 거절 | 마이페이지에서 역할이 기자 또는 관리자인지 확인 |
| 배포 사이트 편집실에서 AI 조사·검토 실패 | Vercel 환경변수에 `OPENAI_API_KEY`가 있는지 확인 후 Redeploy |
| 사진 등록 실패 | 4MB 이하인지 확인. 크면 가로 1600px 정도로 줄여서 다시 등록 |
| 배포 사이트에서 `Invalid host header` | Vercel 환경변수 `APP_ORIGIN`이 접속한 주소와 정확히 같은지 확인 후 Redeploy. 미리보기(Preview) 주소는 막히는 것이 정상 |
| 배포 사이트에서 곡·로그인 오류 | Vercel 대시보드 → 프로젝트 → **Logs**에서 빨간 오류 확인. 대부분 `DATABASE_URL` 누락·오타 |

## 자동 테스트

외부 AI 호출 없이 편집 검토 처리·승인 로직을 검사합니다.

```powershell
.\.venv\Scripts\python.exe -m pip install pytest
.\.venv\Scripts\python.exe -m pytest tests/test_editorial_human.py -q
```

회원·권한 통합 테스트는 실제 DB를 건드리지 않도록 **이름이 `_test`로 끝나는 별도 PostgreSQL DB**에서만 실행됩니다. 테스트 중에는 `DATABASE_URL`을 무시하므로 Supabase 운영 DB에 접속하지 않습니다. 내 PC에 PostgreSQL을 설치하고 빈 DB `todays_rock_accounts_test`를 만든 뒤 실행합니다.

```powershell
$env:DB_HOST="127.0.0.1"; $env:DB_USER="postgres"; $env:DB_PASSWORD="로컬_비밀번호"
$env:DB_NAME="todays_rock_accounts_test"
.\.venv\Scripts\python.exe -m pytest tests/test_accounts.py -q
```

2026-10-19 기준 별도 테스트 DB와 Chromium 화면 테스트로 다음을 확인했습니다. 실제 사용자 DB와 기사 원고로 한 검증은 아닙니다.

- 비로그인·일반 사용자의 마이페이지·관리자·편집실 접근 차단, 회원가입 시 권한 지정 차단, 중복 이메일 거절
- 로그인 세션 교체·만료, 로그아웃, 요청 출처·CSRF 검사, 반복 로그인 시도 제한
- 기자 승격·강등의 즉시 반영, 계정 정지 시 세션 해제, 자기 권한 제거·자기 정지 방지
- 계정별 좋아요 분리, 중복 방지·취소, 닉네임·비밀번호 변경
- 화면 가입 → 좋아요 → 마이페이지 저장 → 새로고침 유지, 390px 모바일 배치, 화면 JavaScript 오류 없음
- 편집실: 임시 데이터와 모의 AI 응답으로 저장·조사·재검색·검토·승인·내보내기·수정 후 승인 무효화 확인

실제 원고에 대한 외부 검색·유료 AI 호출·승인·게시 전체 흐름은 사용자 환경에서 따로 확인합니다.

## 배포하기 — Supabase(DB) + Vercel(웹 서버)

**Supabase는 데이터베이스만 맡고, Python(FastAPI) 서버는 Vercel이 실행합니다.** Vercel은 저장소 최상위 `main.py`의 `app`을 자동으로 찾아 하나의 서버리스 함수로 실행하므로 `vercel.json` 같은 설정 파일은 필요 없습니다.

| 맡는 곳 | 하는 일 |
| --- | --- |
| Supabase | PostgreSQL DB — 곡, 회원, 좋아요, 편집실 기록, 게시된 기사와 사진 |
| Vercel | 홈페이지·회원·곡·뉴스·편집실을 실행하는 FastAPI 서버 |

### Vercel에 올리기

1. GitHub에 최신 코드를 올립니다(`git push`).
2. [vercel.com](https://vercel.com) → **Add New… → Project** → `today-rock_app` 저장소 **Import**.
   - **예전에 만든 Vercel 프로젝트(today-rockapp)를 다시 쓰는 경우:** Project Settings → **Build and Deployment**에서 Framework Preset을 **FastAPI**로 바꾸고, Build Command·Output Directory·Install Command의 **Override를 모두 끕니다.** 예전 정적 사이트용 설정이 남아 있으면 Python 서버가 실행되지 않습니다.
3. Framework Preset이 **FastAPI**로 잡혔는지 확인합니다. Root Directory는 비워 둡니다(저장소 최상위).
4. **Environment Variables**에 아래 값을 넣습니다. `.env` 파일은 GitHub에 올라가지 않으므로 여기에 직접 적어야 합니다.

| 이름 | 값 |
| --- | --- |
| `DATABASE_URL` | 로컬 `.env`와 같은 Supabase **Transaction pooler** 주소 (포트 6543) |
| `GOOGLE_TRANSLATE_API_KEY` | 번역 API 키 |
| `APP_ORIGIN` | `https://today-rockapp.vercel.app`처럼 실제 접속 주소. 끝에 `/` 없이 |
| `OPENAI_API_KEY` | 편집실의 AI 사실 추출·출처 검증·편집 검토용 키 |
| `OPENAI_MODEL` | (선택) 로컬 `.env`에 지정했다면 같은 값 |

   - 주소를 아직 모르면 `APP_ORIGIN` 없이 먼저 배포하고, 나온 주소를 넣은 뒤 **Deployments → … → Redeploy** 합니다. `APP_ORIGIN`이 없으면 사이트가 `Invalid host header`로 열리지 않습니다.
   - `OPENAI_API_KEY`는 서버에만 저장되고 화면(브라우저)으로는 나가지 않습니다. 편집실은 기자·관리자만 쓸 수 있지만, 사용량에 따라 요금이 나오니 OpenAI 대시보드에서 월 사용 한도를 걸어 두는 것을 권합니다.
5. **Deploy**를 누르고 끝나면 주소로 접속해 추천곡·뉴스·회원가입이 되는지 확인합니다.

### 배포 후 알아둘 점

- **배포 사이트에서 기사 쓰기:** `https://…/editor/`에 기자·관리자로 로그인해 원고 작성 → 조사·검수 → 승인 → **홈에 게시**하면 바로 홈에 반영됩니다. 다시 배포할 필요가 없습니다.
- **요청 한 번은 최대 5분**(Vercel 무료 요금제)입니다. 편집실은 사실 조사를 항목 묶음별로 나눠 요청하므로 보통 문제없지만, 출처 사이트가 매우 느리면 그 항목만 실패할 수 있습니다. 그때는 해당 항목의 **이 항목 출처 재검색**을 누릅니다.
- 사진은 Vercel의 요청 크기 제한(4.5MB) 때문에 **4MB 이하**만 올릴 수 있습니다.
- 내 PC와 배포 사이트가 같은 Supabase DB를 쓰므로, 로컬에서 만든 관리자 계정으로 배포 사이트에도 로그인할 수 있습니다.
- **미리보기(Preview) 배포 주소는 접속이 막힙니다.** 로그인 보안을 위해 `APP_ORIGIN`에 적은 한 주소만 허용하기 때문입니다. 확인은 Production 주소로 합니다.
- 오래 접속이 없다가 처음 열면 서버가 깨어나느라 몇 초 더 걸릴 수 있습니다.
- Supabase 무료 프로젝트는 일정 기간 쓰지 않으면 일시정지됩니다. 사이트가 DB 오류를 내면 Supabase 대시보드에서 상태를 확인합니다.
- `.env.local`(`vercel env pull`이 만드는 파일)은 이 서버가 읽지 않습니다. 로컬 설정은 `.env`에 적습니다.

## GitHub에 올릴 때

소스코드, SQL, 기사 자료, `requirements.txt`를 올립니다. `.env`, `.env.*`, `.venv/`, `node_modules/`, `__pycache__/`, `.vercel/`은 `.gitignore`로 제외되어 있습니다. 이미 Git에 추적된 파일은 `.gitignore`에 추가해도 빠지지 않으니 커밋 목록을 확인합니다. API 키와 DB 비밀번호(`DATABASE_URL` 포함)는 문서·화면 코드·커밋에 넣지 않습니다.

## 남은 범위

- 편집실 기록은 뮤지션별 JSON 한 덩어리로 DB에 저장합니다. 여러 기자가 같은 뮤지션 원고를 동시에 고치면 나중에 저장한 쪽이 남습니다(검수·승인 단계는 버전 확인으로 막혀 있음).
- 예전 MySQL의 회원·좋아요 기록은 자동으로 옮기지 않습니다.
