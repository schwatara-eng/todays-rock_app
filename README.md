# TODAY’S ROCK — 오늘의 록

현재 위치의 **날씨**와 사용자가 고른 **기분**에 맞춰 록 음악 3곡을 추천하고, 카드를 누르면 **30초 미리듣기**를 바로 들려주는 웹앱입니다. 번역된 해외 음악 뉴스와 '오늘의 뮤지션' 기사를 함께 보여 주고, 회원은 좋아요한 곡을 마이페이지에 모아 봅니다. 기자는 **편집실**에서 기사 원고를 쓰고, AI로 사실 검수·편집 검토를 받은 뒤 승인해서 홈에 게시합니다.

- 기준일: 2026-10-22
- 공개 사이트: [https://todays-rock-app.vercel.app/](https://todays-rock-app.vercel.app/)
- 배포: Vercel(웹 서버, 서울 리전) + Supabase(PostgreSQL DB)
- 저장소: `schwatara-eng/todays-rock_app`

## 목차

1. [기능정의서](#1-기능정의서)
2. [화면 구성도 · 설계](#2-화면-구성도--설계)
3. [DB 설계](#3-db-설계)
4. [데이터 수집 방법](#4-데이터-수집-방법)
5. [개발 환경](#5-개발-환경)
6. [실행 방법](#6-실행-방법)
7. [부록 — 폴더 구조 · 보안 · 문제 해결 · 남은 범위](#7-부록)
8. [라이선스 · 사진 출처](#8-라이선스--사진-출처)

---

## 1. 기능정의서

### 1-1. 사용자 권한

| 구분 | 음악 추천·뉴스·기사 | 좋아요·마이페이지 | 편집실 | 관리실(관리자 페이지) |
| --- | --- | --- | --- | --- |
| 비로그인 | O | 로그인 필요 | X | X |
| 사용자 (user) | O | O | X | X |
| 기자 (reporter) | O | O | O | X |
| 관리자 (admin) | O | O | O | O |

- 회원가입하면 항상 **사용자**가 됩니다. 관리자만 사용자를 **기자**로 승격하거나 다시 사용자로 되돌릴 수 있습니다.
- 첫 관리자는 화면이 아니라 관리 명령(`create-admin`)으로만 만듭니다.

### 1-2. 기능 목록

| ID | 분류 | 기능 | 설명 | 권한 | 관련 API |
| --- | --- | --- | --- | --- | --- |
| F-01 | 추천 | 현재 위치 날씨 조회 | 브라우저 위치로 Open-Meteo 날씨를 받아 맑음·흐림·비·눈 4가지로 분류합니다. 위치 권한이 없으면 서울 날씨를 씁니다. | 전체 | Open-Meteo |
| F-02 | 추천 | 지역명 표시 | 좌표를 BigDataCloud로 '시·구' 이름으로 바꿉니다. | 전체 | BigDataCloud |
| F-03 | 추천 | 기분 선택 | 지침·평온·울적함·신남·답답함·집중 중 하나를 고릅니다. | 전체 | — |
| F-04 | 추천 | 록 음악 3곡 추천 | ① 기분+날씨 모두 맞는 곡 → ② 기분만 맞는 곡 순서로 무작위 3곡을 고릅니다. 최근 추천곡은 제외합니다(브라우저 저장). | 전체 | `GET /api/songs` |
| F-05 | 추천 | 곡 정보·링크 | 연도·장르·에너지(1~5)·추천 이유를 보여 주고 YouTube 검색·가사 페이지로 연결합니다. | 전체 | — |
| F-22 | 추천 | 30초 미리듣기 | 추천 카드(또는 ♡ 왼쪽 ▶ 버튼)를 누르면 사이트를 떠나지 않고 곡의 30초 미리듣기가 바로 재생됩니다. 다시 누르면 일시정지, 다른 카드를 누르면 곡이 바뀝니다. 원픽 카드는 1번 곡을 재생합니다. 오늘의 뮤지션·지난 뮤지션 페이지의 **대표곡** 카드에도 곡 제목 오른쪽(휴대폰은 제목 아래 오른쪽)에 ▶ 버튼이 붙습니다(▶ 밖을 누르면 예전처럼 YouTube로 이동). 하단 재생바에 곡명·재생 시간·일시정지 버튼이 나옵니다. 미리듣기를 못 찾은 곡은 ▶ 버튼을 숨기고 YouTube 링크만 남깁니다. | 전체 | `GET /api/preview` (iTunes Search API) |
| F-06 | 뉴스 | 음악 뉴스 | NME RSS 최신 3건을 Google 번역으로 한국어로 바꿔 보여 줍니다. 번역에 실패하면 영어 원문을 보여 줍니다. | 전체 | `GET /api/news` |
| F-07 | 기사 | 오늘의 뮤지션 | 편집실에서 마지막으로 게시한 기사를 홈에 보여 줍니다. | 전체 | `GET /` |
| F-08 | 기사 | 지난 뮤지션 아카이브 | 홈의 지난 뮤지션 목록에서 개별 기사를 열고, 기사 하단 **ARCHIVE** 목록으로 다른 지난 뮤지션 기사로 이동합니다. 현재 읽는 뮤지션은 링크 없이 표시합니다. 한국 뮤지션은 `김윤아 (Kim Yuna)`처럼 '한글 (영문)' 순서로 표시합니다. | 전체 | `GET /artist-archive.json`, `GET /artist-{ID}.html` |
| F-09 | 회원 | 회원가입·로그인·로그아웃 | 이메일·닉네임·비밀번호. 반복 가입·로그인 시도는 제한합니다. | 전체 | `POST /api/auth/signup`·`login`·`logout` |
| F-10 | 회원 | 좋아요 | 추천곡의 ♡를 눌러 저장·취소합니다. | 회원 | `PUT`·`DELETE /api/me/likes/{곡ID}` |
| F-11 | 회원 | 마이페이지 | 좋아요 히스토리, 닉네임 변경, 비밀번호 변경. 기자·관리자에게는 편집실 버튼이 보입니다. | 회원 | `GET /api/me/likes`, `PATCH /api/me/profile`, `PUT /api/me/password` |
| F-12 | 관리 | 회원 관리 | 회원 검색, 사용자↔기자 권한 변경, 계정 정지·복구, 회원 현황(전체·기자·관리자·정지). | 관리자 | `GET /api/admin/members`, `PATCH /api/admin/members/{ID}` |
| F-13 | 관리 | 변경 기록 | 권한·정지 변경을 누가 언제 했는지 보여 줍니다. | 관리자 | `GET /api/admin/audit` |
| F-14 | 편집 | 뮤지션 선택·추가 | 영문·한글 이름과 ID(예: `kim-yuna`)로 뮤지션을 추가하고, **한국 뮤지션** 여부를 체크·저장합니다. | 기자 | `/local/artists`, `/local/artist-info` |
| F-15 | 편집 | 01 원고 작성 | 제목·본문 작성과 저장, 뮤지션 사진(4MB 이하) 등록과 사진 출처 입력. | 기자 | `/local/save` |
| F-16 | 편집 | 02 팩트시트 | AI가 원고에서 사실 주장을 항목별로 뽑고 웹 출처를 찾아 대조합니다. 항목 수정·분류·제외·추가, 개별 재검색이 가능합니다. | 기자 | `/local/research`, `/local/research-one`, `/local/fact-edit` |
| F-17 | 편집 | 03 사실 검수 | 팩트시트를 바탕으로 AI가 원고 전체의 사실 오류를 검토합니다. | 기자 | `/local/review`, `/local/recheck` |
| F-18 | 편집 | 04 편집 검토 | AI가 문장·구성 의견을 내고, 에디터가 원고 수정 또는 사유 기록 후 패스로 처리합니다. | 기자 | `/local/editorial`, `/local/editorial-edit` |
| F-19 | 편집 | 05 편집자 승인 | 모든 사실이 검증되고 편집 의견을 모두 처리해야 승인됩니다. 승인 후 JSON으로 내보낼 수 있습니다. | 기자 | `/local/approve` |
| F-20 | 편집 | 06 홈 게시 | 승인된 기사를 즉시 홈의 오늘의 뮤지션으로 올리고, 이전 기사는 아카이브로 옮깁니다. 같은 뮤지션을 다시 게시하면 홈 기사만 갱신하며 아카이브에 중복 추가하지 않습니다. 게시 직전 상태는 백업합니다. | 기자 | `/local/publish` |
| F-21 | 편집 | 상태 도장 | 통과한 칸에 초록 **APPROVED**, 평론(의견) 항목에 회색 **CRITIQUE** 도장을 찍어 한눈에 구분합니다. | 기자 | — |

`/local/…` 편집실 API는 조회(`artists`, `data`, `publication-export`)에 `GET`, 저장·조사·검토·승인·게시 등 처리에 `POST`를 사용합니다. 모든 요청에 로그인·기자 또는 관리자 권한을 검사하며, `POST` 요청에는 요청 출처·CSRF 토큰도 검사합니다. 전체 API 목록은 서버 실행 후 `/docs`에서 볼 수 있습니다.

### 1-3. 편집실 승인 규칙

- 검증되지 않은 주장, 원고보다 오래된 검수 결과, 처리하지 않은 편집 의견이 하나라도 있으면 승인할 수 없습니다. 이유는 오류 메시지로 구체적으로 알려 줍니다.
- 원고를 고치면 기존 승인과 사실 검수가 무효가 됩니다. **사실 검수 갱신**으로 다시 확인해야 합니다.
- AI가 찾은 링크와 판정만으로 사실을 확정하지 않습니다. 수치·날짜·수상 기록·인용문은 에디터가 원문과 직접 대조하고, 05 승인 칸의 확인란을 체크해야 승인됩니다.
- AI가 기사 전체를 대신 쓰는 기능은 없습니다. 초안은 기자가 직접 씁니다.

---

## 2. 화면 구성도 · 설계

### 2-1. 사이트맵

```text
/  홈 ─────────────────────────────────────────────────────────────
│   ├─ 음악 뉴스 (NME → 한국어)
│   ├─ 날씨·기분 선택 → 오늘의 추천 3곡 (♡ 좋아요)
│   └─ 오늘의 뮤지션 기사 ─ 지난 뮤지션 목록 → /artist-{ID}.html
│
├─ /signup · /login           회원가입 · 로그인 (한 화면에서 전환)
├─ /mypage                    마이페이지 (회원)
│     └─ [편집실 열기]          기자·관리자에게만 표시
├─ /admin/                    오늘의 록 관리실 (관리자)
│     └─ [편집실]
└─ /editor/                   오늘의 뮤지션 편집실 (기자·관리자)
      └─ [관리자 페이지 ↗]      관리자에게만 표시 (기자는 [마이페이지 ↗])
```

### 2-2. 화면별 구성

**홈 (`/`)**

```text
┌────────────────────────────────────────────────────────────────┐
│ TODAY'S ROCK       WEATHER · MOOD · MUSIC [회원가입] [로그인]   │  헤더
├────────────────────────────────────────────────────────────────┤
│ 히어로: 오늘의 록 제목          ☀ 현재 날씨·지역  [위치 다시 찾기] │  배경 영상
├──────────────────────┬─────────────────────────────────────────┤
│ 음악 뉴스 3건         │ 기분 선택 6개 → [오늘의 음악 찾기]       │
│ (번역 제목·요약·링크) │ 추천 결과: 3곡 카드 (▶ ♡) + 원픽 카드 (▶) │
│                      │ 카드 클릭 → 30초 미리듣기                │
├──────────────────────┴─────────────────────────────────────────┤
│ 오늘의 뮤지션: 사진·제목·본문            [지난 뮤지션 ▸]         │
│ (지난 뮤지션 목록 → 개별 기사 페이지)                           │
├────────────────────────────────────────────────────────────────┤
│ 푸터                                                            │
└────────────────────────────────────────────────────────────────┘
  재생 중에는 화면 하단에 재생바(곡명 · 0:12 / 0:30 · [일시정지])가 고정됩니다.
```

**편집실 (`/editor/`)** — 번호 순서대로 진행합니다.

```text
┌────────────────────────────────────────────────────────────────┐
│ 로고(홈) 오늘의 뮤지션 편집실   [관리자 페이지 ↗ / 마이페이지 ↗] │
├────────────────────────────────────────────────────────────────┤
│ 뮤지션 선택 ▾  [새 뮤지션 추가]   □ 한국 뮤지션 [저장]           │
├───────────────────────────────┬────────────────────────────────┤
│ 01 / EDITOR'S DRAFT           │ 02 / FACT SHEET  [항목 추가]    │
│  제목·본문·사진, [저장]        │  주장별 판정·출처 (APPROVED /   │
│  [팩트시트 생성 + 웹 출처 검증] │  CRITIQUE 도장), ▶펼치기/접기   │
├───────────────────────────────┼────────────────────────────────┤
│ 03 / SOURCE FACT CHECK        │ 04 / EDITORIAL REVIEW           │
│  사실 검수 보고서              │  편집 의견별 원고 수정 / 패스    │
├───────────────────────────────┴───────────────┬────────────────┤
│ 05 / EDITOR APPROVAL  원출처 대조 확인 [편집자 승인]│ 06 / PUBLISH   │
│                       [승인 기사 JSON 내보내기]   │ [홈에 게시 ↗]  │
├───────────────────────────────────────────────┴────────────────┤
│ 기사 미리보기                                                   │
└────────────────────────────────────────────────────────────────┘
```

06 버튼은 승인 전 회색(잠김) → 승인 후 빨간 **홈에 게시 ↗** → 게시 후 초록 **게시 완료**로 바뀝니다. 게시 완료 후에도 다시 눌러 재게시할 수 있습니다. 원고를 수정했다면 저장·검수·승인을 다시 마쳐야 합니다.

**지난 뮤지션 (`/artist-{ID}.html`)**

기사 하단의 **오늘의 뮤지션으로 돌아가기**로 홈에 돌아가거나, **ARCHIVE** 목록에서 다른 지난 뮤지션 기사를 바로 열 수 있습니다. 목록은 홈과 같은 `/artist-archive.json`을 읽어 갱신하며, 현재 읽는 뮤지션은 이동 링크 없이 표시합니다.

**회원 화면**

| 화면 | 구성 |
| --- | --- |
| 로그인·회원가입 (`/login`, `/signup`) | 이메일·비밀번호(가입 시 닉네임·비밀번호 확인 추가), 아래 링크로 로그인↔회원가입 전환 |
| 마이페이지 (`/mypage`) | 상단 제목과 등급, 좋아요한 곡 목록(개수·취소), 내 프로필(닉네임 변경), 비밀번호 변경, 편집실 버튼(기자·관리자) |
| 관리실 (`/admin/`) | '오늘의 록 관리실' 제목, 회원 현황 4칸(전체·기자·관리자·정지), 회원 관리(검색·권한·정지/복구), 최근 권한·상태 변경 기록, 편집실 링크 |
| 접근 권한 안내 | 권한이 없는 페이지에 들어왔을 때 표시 |

### 2-3. 디자인 규칙

| 요소 | 서체·표시 |
| --- | --- |
| 로고 `TODAY'S ROCK` | 홈·관리실·마이페이지 동일한 자간 |
| 화면 제목 강조어(`편집실`, `관리실`) | 갈무리체 |
| 하위 목록 제목(회원 관리, 좋아요한 곡 등) | 삼립호빵체 |
| 등급명(관리자·기자·사용자) | 기본 고딕 |
| 도장 | 원형 도장 — 초록 APPROVED / 회색 CRITIQUE (`admin/stamp-*.svg`) |
| 반응형 | 390px 모바일 폭에서 한 줄 배치로 전환 |

### 2-4. 시스템 구조

```mermaid
flowchart LR
  B[브라우저<br>HTML·CSS·JS] -->|페이지·API| V[Vercel CDN<br>정적 파일·곡·뉴스 캐시]
  V --> F[FastAPI 서버<br>Vercel 서울 icn1]
  F -->|psycopg| D[(Supabase<br>PostgreSQL)]
  F -->|RSS| N[NME]
  F -->|번역| G[Google Cloud Translation]
  F -->|사실 추출·웹 검색·검토| O[OpenAI Responses API]
  B -->|날씨| M[Open-Meteo]
  B -->|지역명| C[BigDataCloud]
  F -->|미리듣기 검색| I[iTunes Search API]
  B -->|미리듣기 음원 재생| I
```

- FastAPI 서버 하나가 모든 화면과 API를 제공합니다. 날씨·지역명만 브라우저가 직접 조회하고, 미리듣기 음원은 브라우저가 Apple 서버에서 바로 재생합니다.
- 홈 화면은 저장소의 최신 `index.html` 디자인에, DB에 저장된 '오늘의 뮤지션' 기사 본문을 끼워 넣어 만듭니다. 그래서 디자인을 고쳐 배포해도 게시한 기사는 유지됩니다.
- CSS·JS·폰트·영상은 CDN에 하루, 곡 목록은 1시간, 번역된 뉴스는 15분 캐시합니다. 기사·로그인·편집실은 캐시하지 않습니다.

---

## 3. DB 설계

PostgreSQL(Supabase) 한 개의 DB에 **곡 · 회원 · 편집실** 세 영역의 테이블이 있습니다. 모든 테이블에 행 수준 보안(RLS)을 켜서 Supabase의 브라우저용 공개 API로는 접근할 수 없고, DB 비밀번호로 접속하는 FastAPI 서버만 읽고 씁니다. 시간은 모두 UTC로 저장합니다.

### 3-1. ERD

```mermaid
erDiagram
  songs ||--o{ song_moods : "기분 태그"
  songs ||--o{ song_weathers : "날씨 태그"
  account_users ||--o{ account_sessions : "로그인 세션"
  account_users ||--o{ account_likes : "좋아요"
  songs ||..o{ account_likes : "song_id (논리적 참조)"
  account_users ||..o{ account_audit : "actor_id·target_id"

  songs {
    int id PK
    varchar title
    varchar artist
    smallint year
    varchar genre
    smallint energy "1~5"
    varchar theme
    varchar tone
    varchar reason
    varchar lyrics_url
  }
  song_moods {
    int song_id PK,FK
    text mood PK
  }
  song_weathers {
    int song_id PK,FK
    text weather PK
  }
  account_users {
    bigint id PK
    varchar email UK
    varchar display_name
    varchar password_hash
    text role
    boolean is_active
    timestamp created_at
    timestamp updated_at
    timestamp last_login_at
  }
  account_sessions {
    char token_hash PK
    bigint user_id FK
    char csrf_token
    timestamp expires_at
  }
  account_likes {
    bigint user_id PK,FK
    int song_id PK
    timestamp created_at
  }
  account_audit {
    bigint id PK
    bigint actor_id
    bigint target_id
    varchar action
    varchar old_value
    varchar new_value
    timestamp created_at
  }
  account_auth_limits {
    char bucket_hash PK
    int attempts
    timestamp window_start
  }
  editor_docs {
    text kind PK
    text artist_id PK
    jsonb data
    timestamp updated_at
  }
  site_features {
    text artist_id PK
    text block
    timestamp updated_at
  }
  site_assets {
    text path PK
    bytea content
    text content_type
    timestamp updated_at
  }
  site_history {
    bigint id PK
    text stamp
    text kind
    text name
    text content
    timestamp created_at
  }
```

`account_likes.song_id`는 일부러 외래 키로 묶지 않았습니다. 곡 SQL을 다시 실행해 곡 테이블을 새로 만들어도 좋아요 기록이 지워지지 않게 하기 위해서입니다.

### 3-2. 테이블 정의

**곡 — `db/todays_rock.sql`**

| 테이블 | 주요 칸 | 제약·설명 |
| --- | --- | --- |
| `songs` | id, title, artist, year, genre, energy, theme, tone, reason, lyrics_url | 500곡. `(title, artist)` 중복 불가, energy 1~5 |
| `song_moods` | song_id, mood | 한 곡에 여러 기분. mood ∈ `calm`, `excited`, `focused`, `blue`, `tired`, `frustrated` (1,082행) |
| `song_weathers` | song_id, weather | 한 곡에 여러 날씨. weather ∈ `clear`, `cloudy`, `rain`, `snow` (1,094행) |
| `v_songs` (뷰) | 곡 정보 + moods·weathers를 쉼표로 묶은 문자열 | `/api/songs`가 읽는 뷰. `security_invoker=true` |

**회원 — `db/accounts.sql`** (서버·관리 명령이 자동 실행, 기존 데이터 유지)

| 테이블 | 주요 칸 | 제약·설명 |
| --- | --- | --- |
| `account_users` | email, display_name, password_hash, role, is_active, last_login_at | 이메일은 대소문자 구분 없이 유일. role ∈ `user`, `reporter`, `admin`. 비밀번호는 scrypt 해시 |
| `account_sessions` | token_hash, user_id, csrf_token, expires_at | 로그인 토큰은 해시만 저장. 회원 삭제 시 함께 삭제 |
| `account_likes` | user_id, song_id, created_at | `(user_id, song_id)` 중복 불가 |
| `account_audit` | actor_id, target_id, action, old_value, new_value | 권한 변경·정지/복구 기록 |
| `account_auth_limits` | bucket_hash, attempts, window_start | 반복 로그인·가입 시도 제한 |

**편집실 — `editor_python/storage.py`** (처음 저장할 때 자동 생성)

| 테이블 | 주요 칸 | 제약·설명 |
| --- | --- | --- |
| `editor_docs` | kind, artist_id, data(JSONB) | 뮤지션·종류별 한 줄. kind ∈ `draft`(원고), `sheet`(팩트시트), `review`(사실 검수), `editorial`(편집 검토), `approval`(승인), `site`(현재·지난 뮤지션 목록) |
| `site_features` | artist_id, block(HTML) | 게시된 기사 본문. 현재·지난 뮤지션 모두 |
| `site_assets` | path, content(BYTEA), content_type | 편집실에서 올린 뮤지션 사진 |
| `site_history` | stamp, kind, name, content | 게시 직전 상태 백업 |

편집실 기록은 단계마다 원고의 해시(fingerprint)를 함께 저장합니다. 원고가 바뀌면 해시가 달라져 이전 검수·승인이 자동으로 무효가 됩니다.

---

## 4. 데이터 수집 방법

| 데이터 | 방식 | 출처 | 갱신 | 처리 |
| --- | --- | --- | --- | --- |
| 추천 곡 500곡 | **직접 구성한 JSON → SQL** | `data_backup.json` (곡·연도·장르·에너지·주제·분위기·추천 이유·가사 링크·기분·날씨 태그) | 수동 | `db/todays_rock.sql`의 `INSERT`로 옮겨 Supabase에 적재 |
| 현재 날씨 | **Open API** (키 불필요) | [Open-Meteo](https://open-meteo.com/) `/v1/forecast` — 기온·날씨 코드·풍속 | 접속할 때마다 | 날씨 코드(WMO)를 맑음·흐림·비·눈으로 분류 |
| 지역명 | **Open API** (키 불필요) | [BigDataCloud](https://www.bigdatacloud.com/) reverse-geocode-client | 접속할 때마다 | 행정구역 이름에서 '시·구'만 표시 |
| 음악 뉴스 | **RSS (XML)** | NME `https://www.nme.com/news/music/feed` | 15분 캐시 | 최신 3건 제목·요약 추출, HTML 태그 제거 |
| 뉴스 번역 | **Open API** (API 키) | Google Cloud Translation API v2 | 뉴스와 함께 | 제목·요약 6개 문장을 한 번에 영→한 번역 |
| 기사 사실 검증 | **LLM API + 웹 검색** (API 키) | OpenAI Responses API의 `web_search` 도구 | 편집실에서 실행할 때 | 원고에서 주장 추출 → 출처 검색 → 출처 본문을 직접 받아 인용 대조 |
| 30초 미리듣기 | **Open API** (키 불필요) | [iTunes Search API](https://performance-partners.apple.com/search-api) `/search`, `/lookup` — 서버 `GET /api/preview`가 대신 조회 | 찾은 곡 하루, 못 찾은 곡 1시간 캐시 | 곡에 `itunes_track_id`가 있으면 그 ID로 조회, 없으면 '아티스트 + 제목'으로 한국 → 미국 스토어 순서로 검색해 아래 **곡 찾는 순서**대로 고름. 같은 방문 중에는 다시 검색하지 않음 |
| 오늘의 뮤지션 기사 | **기자 직접 작성** | 편집실 | 게시할 때 | DB(`editor_docs`, `site_features`)에 저장 |

- **CSV 다운로드는 사용하지 않습니다.** 곡 데이터는 처음부터 JSON으로 정리해 SQL로 옮겼습니다.
- **PDF는 자동 처리하지 않습니다.** 편집실이 출처 본문을 대조할 때 PDF 링크는 건너뛰고 "PDF 출처는 직접 확인해 주세요"라고 안내하며, 에디터가 원문을 직접 확인합니다.
- **미리듣기 곡 찾는 순서** (각 단계에서 라이브·리마스터·데모 등은 뒤로 미룸)
  1. 가수 이름과 제목(앞부분)이 모두 맞는 곡
  2. 제목이 정확히 같은 곡 — 한국 스토어에서 가수 이름이 영문으로 오는 경우(예: '자우림' → 영문 표기)
  3. 제목이 포함된 곡 — 예: '샤이닝 (Shining)'
  4. 가수의 iTunes 번호가 같은 곡 중 검색 결과 맨 위 — 제목까지 영문으로 오는 경우. 검색어에 제목이 들어 있어 보통 맞지만, 같은 가수의 다른 곡이 나올 수 있음
  - 1~3단계는 한국 → 미국 스토어를 모두 확인한 뒤에도 못 찾았을 때만 4단계로 넘어갑니다. 한국 스토어에 없는 곡이 같은 가수의 다른 곡으로 바뀌어 재생되지 않게 하기 위해서입니다(예: The Voidz 'Human Sadness').
  - 서버(`main.py`의 `preview_best_match`, `preview_pick_by_artist`)와 브라우저(`preview-player.js`의 `pickBestMatch`)가 같은 규칙을 씁니다(4단계는 서버만). 한쪽을 고치면 다른 쪽도 고칩니다.
  - 규칙을 바꾸면 `preview-player.js`의 `/api/preview` 요청에 붙는 `v` 값을 올려, 브라우저·CDN에 남은 예전 결과를 쓰지 않게 합니다.
- 미리듣기는 서버(`/api/preview`)가 iTunes에 대신 묻고 결과를 CDN에 하루 저장합니다. 아이폰 브라우저에서 iTunes에 직접 요청하면 실패하는 경우가 있어서입니다. 서버 조회가 실패할 때만 브라우저가 직접 묻습니다(JSONP).
- 날씨·지역명 API는 키가 없어 브라우저에서 바로 부르고, 번역·OpenAI는 키가 노출되지 않도록 서버에서만 부릅니다.
- Spotify Web API는 쓰지 않습니다. 2026년 개발 모드가 Premium 계정·승인 사용자 5명으로 제한되고 미리듣기 음원 주소도 제공하지 않아, 공개 사이트에서 쓸 수 없습니다.
- 검색 실패는 주장이 거짓이라는 뜻이 아닙니다. 번역·OpenAI 호출에는 사용량에 따라 요금이 나옵니다.

---

## 5. 개발 환경

| 구분 | 사용 기술 |
| --- | --- |
| 언어 | Python 3.13, HTML / CSS / JavaScript (프레임워크 없음) |
| 웹 서버 | FastAPI + Uvicorn (포트 8000, 서버 하나로 화면·API 모두 제공) |
| DB | **PostgreSQL** (Supabase 호스팅), 드라이버 `psycopg` 3 |
| LLM | **OpenAI API** — Responses API + web_search. 기본 모델 `gpt-5-mini`, `OPENAI_MODEL`로 변경 가능. 기사 사실 추출·출처 검증·사실 검수·편집 검토에 사용 |
| 외부 API | Open-Meteo, BigDataCloud, NME RSS, Google Cloud Translation, iTunes Search API(30초 미리듣기) |
| HTTP 클라이언트 | `httpx` (비동기) |
| 편집기 | VS Code, PowerShell 터미널 |
| 배포 | Vercel (FastAPI 서버리스, 서울 `icn1`) + Supabase |
| 버전 관리 | Git / GitHub |
| 테스트 | pytest, Playwright(Chromium) 화면 확인 |

**MySQL에서 PostgreSQL로 바꾼 이유:** 개발 초기에는 내 PC의 MySQL 8.0을 썼습니다. Vercel에 배포하려면 인터넷에서 접속할 수 있는 DB가 필요해 2026년 10월 Supabase의 PostgreSQL로 옮겼습니다. 내 PC와 배포 사이트가 같은 DB를 쓰므로 내 PC에 DB를 설치하지 않아도 됩니다. (예전 MySQL의 회원·좋아요 기록은 옮기지 않았습니다.)

`requirements.txt`

```text
fastapi
pydantic>=2.12,<3
uvicorn
psycopg[binary]>=3.1
python-dotenv
httpx
```

---

## 6. 실행 방법

프로젝트 폴더를 VS Code로 열고 PowerShell 터미널에서 진행합니다. **1~5단계는 처음 한 번만** 합니다.

### 6-1. Supabase 프로젝트 만들기

1. [supabase.com](https://supabase.com)에 가입하고 **New project**를 만듭니다.
   - Region: **Northeast Asia (Seoul)** 권장 (Vercel 서버와 같은 지역)
   - Database Password: 직접 정하고 따로 적어 둡니다. 영문·숫자만 쓰는 것이 편합니다.
2. 위쪽 **Connect** → **Connection String** 탭에서 **Transaction pooler** 주소를 복사합니다.
   - 모양: `postgresql://postgres.[프로젝트ID]:[YOUR-PASSWORD]@aws-0-[지역].pooler.supabase.com:6543/postgres` (포트 **6543**)
   - `[YOUR-PASSWORD]`를 괄호까지 지우고 비밀번호를 넣습니다.
   - Direct connection은 IPv6 전용이라 집·학교 인터넷에서 안 될 수 있습니다. Transaction pooler는 내 PC와 Vercel 모두에서 됩니다.

### 6-2. 곡 데이터 넣기

Supabase 대시보드 **SQL Editor → New query**에 `db/todays_rock.sql` 내용을 전체 붙여넣고 **Run**.

- 정상 결과: 마지막 표에 `songs` 500 / `moods` 1082 / `weathers` 1094
- 이 SQL은 곡 테이블만 지우고 다시 만듭니다. 회원(`account_…`)·편집실 테이블은 그대로입니다.

### 6-3. Python 패키지 설치

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 6-4. 환경변수(`.env`) 설정

프로젝트 최상위에 `.env` 파일을 만듭니다. **이 파일은 GitHub에 올리지 않습니다.**

```dotenv
DATABASE_URL=postgresql://postgres.[프로젝트ID]:[비밀번호]@aws-0-[지역].pooler.supabase.com:6543/postgres
GOOGLE_TRANSLATE_API_KEY=실제_번역_API_키
OPENAI_API_KEY=실제_OpenAI_API_키
# OPENAI_MODEL=사용할_모델명          ← 비우면 gpt-5-mini
# APP_ORIGIN=https://실제_운영_주소     ← 배포한 사이트에서만
```

- 서버는 `.env`만 읽습니다. `.env.local`(Vercel이 만드는 파일)은 쓰지 않습니다.
- `DATABASE_URL` 대신 `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSLMODE`로 나눠 적어도 됩니다(내 PC에 PostgreSQL을 설치해 쓸 때).

### 6-5. 첫 관리자 만들기

```powershell
.\.venv\Scripts\python.exe -m account_system.manage create-admin
```

이메일 → 닉네임 → 비밀번호(10~128자, 입력 중 안 보임) → 확인 순서로 입력합니다. 회원 테이블이 없으면 함께 만듭니다.
정상 결과: `관리자 계정 생성 완료. 홈페이지에서 로그인하세요.`

### 6-6. 기존 기사 기록을 DB로 옮기기

```powershell
.\.venv\Scripts\python.exe -m editor_python.storage
```

`articles/` 폴더의 원고·팩트시트·검수·승인 기록을 Supabase로 복사하고 편집실 테이블을 만듭니다. 이미 있는 기록은 건너뛰므로 여러 번 실행해도 안전합니다(파일 내용으로 덮어쓰려면 끝에 `--force`).

### 6-7. 서버 실행

```powershell
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --port 8000
```

`http://localhost:8000/`에 접속합니다. 종료는 `Ctrl+C`. `.env`를 고쳤다면 서버를 껐다 켜야 반영됩니다. `localhost`와 `127.0.0.1`은 로그인이 따로 저장되니 한 주소만 씁니다.

| 주소 | 화면 |
| --- | --- |
| `/` | 홈 |
| `/signup` · `/login` | 회원가입 · 로그인 |
| `/mypage` | 마이페이지 |
| `/admin/` | 관리실 (관리자) |
| `/editor/` | 편집실 (기자·관리자) |
| `/docs` | API 문서 |

**동작 확인 순서 (시크릿 창 권장)**

1. 시크릿 창에서 일반 사용자로 가입 → 마이페이지에 편집실 버튼이 없어야 합니다.
2. 관리자 창의 관리실에서 그 회원을 **기자**로 바꿉니다.
3. 시크릿 창 마이페이지를 새로고침 → 역할이 '기자', **편집실 열기**가 보입니다.
4. 홈에서 기분 선택 → **오늘의 음악 찾기** → ♡ 좋아요 → 마이페이지 목록에 보이는지 확인합니다.

### 6-8. 관리 명령

| 명령 | 용도 |
| --- | --- |
| `.\.venv\Scripts\python.exe -m account_system.manage create-admin` | 관리자 계정 만들기 |
| `.\.venv\Scripts\python.exe -m account_system.manage reset-password` | 회원 비밀번호 재설정 (기존 로그인 모두 해제) |
| `.\.venv\Scripts\python.exe -m account_system.manage init` | 회원 테이블만 준비 |
| `.\.venv\Scripts\python.exe -m editor_python.storage [--force]` | 기사 파일 기록을 DB로 복사 |

### 6-9. 편집실 사용 순서

1. **뮤지션 선택** — 기존 뮤지션을 고르거나 **새 뮤지션 추가**. 한국 뮤지션은 **한국 뮤지션** 체크 후 옆 **저장**.
2. **01 원고** — 제목·본문 작성 후 저장, 필요하면 사진 등록(PNG·JPG·WEBP, 4MB 이하). 사진의 **출처** 칸에 제작자·제공처·라이선스 등을 입력합니다. Enter 또는 칸 밖 클릭으로 저장되며, 미리보기와 게시 기사에 `PHOTO | 입력한 출처`로 표시됩니다. 이미 게시한 기사의 출처를 바꿨다면 **홈에 게시**를 다시 눌러 반영합니다.
3. **02·03** — **팩트시트 생성 + 웹 출처 검증**. 실패한 항목은 **이 항목 출처 재검색**, 항목을 고쳤다면 **사실 검수 갱신**.
4. **04 편집 검토** — **AI 편집 검토** 실행 후 의견마다 *원고 수정* 또는 *사유 기록 후 패스*.
5. **05 승인** — 원출처 대조 확인란 체크 → **편집자 승인**.
6. **06 게시** — **홈에 게시 ↗**. 바로 홈에 반영되며 다시 배포할 필요가 없습니다. 게시 완료 후 버튼을 다시 누르면 재게시합니다. 같은 뮤지션 재게시는 아카이브를 중복 생성하지 않으며, 원고를 수정한 경우에는 저장·검수·승인을 다시 마쳐야 합니다.

### 6-10. 자동 테스트

```powershell
.\.venv\Scripts\python.exe -m pip install pytest
.\.venv\Scripts\python.exe -m pytest tests/test_editorial_human.py -q
```

회원·권한 테스트(`tests/test_accounts.py`)는 운영 DB를 건드리지 않도록 `DATABASE_URL`을 무시하고, **이름이 `_test`로 끝나는 로컬 PostgreSQL DB**에서만 실행됩니다.

```powershell
$env:DB_HOST="127.0.0.1"; $env:DB_USER="postgres"; $env:DB_PASSWORD="로컬_비밀번호"
$env:DB_NAME="todays_rock_accounts_test"
.\.venv\Scripts\python.exe -m pytest tests/test_accounts.py -q
```

### 6-11. Vercel 배포

1. 최신 코드를 GitHub에 올립니다(`git push`).
2. [vercel.com](https://vercel.com) → **Add New… → Project** → 저장소 **Import**. Framework Preset이 **FastAPI**인지 확인하고, Root Directory는 비워 둡니다. (예전 정적 사이트용 프로젝트를 다시 쓴다면 Build·Output·Install Command의 Override를 모두 끕니다.)
3. **Environment Variables**에 입력합니다.

| 이름 | 값 |
| --- | --- |
| `DATABASE_URL` | `.env`와 같은 Transaction pooler 주소 |
| `GOOGLE_TRANSLATE_API_KEY` | 번역 API 키 |
| `OPENAI_API_KEY` | 편집실 AI용 키 (서버에만 저장, 브라우저로 나가지 않음) |
| `APP_ORIGIN` | 실제 접속 주소, 예: `https://todays-rock-app.vercel.app` (끝에 `/` 없이). **Production** 환경에만 넣습니다 |
| `OPENAI_MODEL` | (선택) |

4. **Deploy**. 주소를 아직 모르면 `APP_ORIGIN` 없이 배포한 뒤 주소를 넣고 **Redeploy** 합니다. `APP_ORIGIN`이 없거나 다르면 `Invalid host header`가 나옵니다.

배포 후 알아둘 점

- `vercel.json`이 서버를 **서울(`icn1`)**에서 실행합니다. Supabase를 다른 지역에 만들었다면 그 근처 코드(도쿄 `hnd1`, 싱가포르 `sin1` 등)로 바꿉니다.
- 무료 요금제는 요청 하나가 최대 5분이고 요청 크기는 4.5MB까지라서 사진은 4MB 이하만 올립니다.
- 한동안 접속이 없으면 서버가 잠들어 첫 접속이 몇 초 더 걸립니다. Supabase 무료 프로젝트도 오래 안 쓰면 일시정지되니 대시보드에서 **Restore** 합니다.
- 미리보기(Preview) 배포는 Vercel이 알려 주는 그 배포 자신의 주소(`VERCEL_BRANCH_URL`, `VERCEL_URL`)를 자동으로 허용합니다. 그래서 PR의 **Preview** 링크로 바로 확인할 수 있고, 미리보기용 `APP_ORIGIN`을 따로 넣을 필요가 없습니다. Production의 `APP_ORIGIN`을 미리보기 주소로 바꾸면 실제 사이트가 `Invalid host header`로 막히니 주의합니다.
- 위 자동 허용은 Vercel **Settings → Environment Variables**의 **Enable access to System Environment Variables**가 켜져 있어야 동작합니다(기본값: 켜짐).
- 새 정적 파일(CSS·JS 등)을 추가하면 `main.py`에 그 파일을 내보내는 경로도 추가해야 합니다. 서버는 정해 둔 파일만 내보냅니다.
- `style.css`·`script.js`·`preview-player.js`를 고치면 `index.html`과 지난 뮤지션 페이지 틀(`artist-jack-white.html`, `artist-kim-yuna.html`)의 `?v=` 뒤 값(예: `?v=20261022b`)도 바꿉니다. 브라우저(특히 휴대폰)가 예전 파일을 저장해 두고 계속 쓰는 것을 막습니다.
- OpenAI 대시보드에서 월 사용 한도를 걸어 두는 것을 권합니다.

---

## 7. 부록

### 7-1. 폴더 구조

```text
todays-rock_app/
├── main.py                 # 곡·뉴스 API, 화면 제공, 캐시 규칙, 회원·편집실 라우터 연결
├── editor_bridge.py        # 편집실 라우터 연결
├── vercel.json             # Vercel 실행 지역(서울)
├── account_system/         # 회원 API·권한·보안·DB 연결·관리 명령
├── accounts/               # 로그인·마이페이지·관리실 화면
├── editor_python/          # 편집실 서버
│   ├── routes.py           # 저장·조사·검토·승인·게시 API
│   ├── ai.py               # OpenAI 호출·웹 검색·출처 본문 대조
│   ├── fact_edit.py        # 팩트시트 항목 수정·분류·제외
│   ├── editorial_edit.py   # 편집 의견 처리
│   ├── publish.py          # 홈 게시·아카이브·사진·백업
│   ├── storage.py          # Supabase 저장소, 파일→DB 복사
│   └── prompts.json        # AI 프롬프트·JSON 스키마
├── admin/                  # 편집실 화면, 도장 SVG
├── articles/               # DB로 옮기기 전 기사 기록 (참고용)
├── db/
│   ├── todays_rock.sql     # 곡 테이블 + 500곡
│   └── accounts.sql        # 회원 테이블
├── data_backup.json        # 곡 원본 데이터(JSON)
├── tests/                  # 자동 테스트
├── index.html · script.js · style.css
├── preview-player.js       # 추천곡·대표곡 30초 미리듣기 (iTunes 검색·재생·하단 재생바)
├── artist-*.html · artist-archive.json   # 지난 뮤지션 (DB에 없을 때 대신 사용)
├── images/ · fonts/
└── requirements.txt
```

### 7-2. 보안

- 비밀번호는 scrypt 해시로, 로그인 토큰은 해시로만 저장합니다. 로그인은 HttpOnly 쿠키(7일)와 서버 세션으로 처리합니다.
- 변경 요청마다 로그인·권한·요청 출처·CSRF 토큰을 검사하고, 반복 로그인 시도를 제한합니다.
- 계정을 정지하거나 비밀번호를 바꾸면 다른 기기의 로그인이 해제됩니다. 관리자는 자기 권한을 없애거나 자기 계정을 정지할 수 없습니다.
- 모든 DB 테이블에 RLS를 켜서 Supabase 공개 API로는 접근할 수 없습니다.
- `.env`, `.env.*`, `.venv/`, `__pycache__/`, `.vercel/`은 `.gitignore`로 제외합니다. API 키와 DB 비밀번호는 코드·문서·커밋에 넣지 않습니다.

### 7-3. 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| "곡 데이터를 불러오지 못했어요" | SQL Editor에서 `SELECT * FROM v_songs LIMIT 3;`. 뷰가 없으면 `db/todays_rock.sql` 다시 실행 |
| `password authentication failed` | `DATABASE_URL` 비밀번호, `[ ]` 괄호를 지웠는지 확인 |
| `could not translate host name` / `timeout` | Direct connection 주소 대신 Transaction pooler(6543) 사용 |
| `Tenant or user not found` | 사용자 이름이 `postgres.[프로젝트ID]` 형태인지 확인 |
| 뉴스가 영어로 나옴 | `GOOGLE_TRANSLATE_API_KEY` 확인 후 서버 재시작(배포 사이트는 Redeploy) |
| 로그인했는데 로그아웃 상태 | `localhost`와 `127.0.0.1`을 섞어 썼는지 확인 |
| 편집실 접근 거절 | 마이페이지에서 역할이 기자·관리자인지 확인 |
| 배포 사이트에서 AI 조사·검토 실패 | Vercel 환경변수 `OPENAI_API_KEY` 확인 후 Redeploy |
| 승인 버튼이 안 넘어감 | 오류 메시지가 알려 주는 단계(사실 검수 갱신, 미처리 편집 의견 등)를 먼저 처리 |
| 사진 등록 실패 | 4MB 이하인지 확인. 가로 1600px 정도로 줄여 다시 등록 |
| `Invalid host header` (실제 사이트) | Production의 `APP_ORIGIN`이 `https://todays-rock-app.vercel.app`과 정확히 같은지 확인 후 Redeploy |
| `Invalid host header` (미리보기) | **Enable access to System Environment Variables**가 켜져 있는지 확인 후 Redeploy |
| 추천 카드에 ▶ 버튼이 없음 | **Ctrl + Shift + R**로 강력 새로고침. 계속 없으면 `/preview-player.js`가 열리는지 확인(`main.py` 경로) |
| ▶ 버튼이 일부 곡에만 없음 | 그 곡을 iTunes에서 못 찾은 것. 국내 곡은 한국 스토어에 가수·제목이 다른 표기(영문 등)로 등록된 경우가 많음. Apple Music 앱에서 검색해 표기를 확인하고, 계속 그러면 `itunes_track_id`로 고정 |
| ▶를 누르면 다른 곡이 나옴 | 곡 찾는 순서 4단계(가수 번호로 맨 위 곡)에서 같은 가수의 다른 곡이 골라진 경우. 한국·미국 스토어 모두에 그 제목이 없다는 뜻이니 Apple Music에서 실제 등록된 가수·제목 표기를 확인하고, 계속 그러면 `itunes_track_id`로 고정 |
| ▶ 버튼이 모든 곡에서 사라짐 | `/api/preview?artist=Oasis&title=Wonderwall`이 `previewUrl`을 돌려주는지 확인. Vercel **Logs**에 `iTunes 미리듣기 조회 실패`가 있는지 확인 |
| ▶ 버튼은 있는데 소리가 안 남 | 다른 탭·기기 음소거 확인. 개발자 도구 **Console**에 `itunes.apple.com` 오류가 있는지 확인 |
| 엉뚱한 버전(라이브·리마스터 등)이 재생됨 | 그 곡에 `itunes_track_id`를 넣어 정확한 버전으로 고정(7-4 참고) |
| 배포 사이트 오류 전반 | Vercel → 프로젝트 → **Logs**의 빨간 오류 확인. 대부분 `DATABASE_URL` 누락·오타 |

### 7-4. 남은 범위

- 이메일 인증, 이메일로 비밀번호 재설정, SNS 로그인은 아직 없습니다.
- 편집실 기록은 뮤지션별 JSON 한 덩어리로 저장합니다. 두 기자가 같은 원고를 동시에 고치면 나중에 저장한 쪽이 남습니다(검수·승인 단계는 버전 확인으로 막혀 있음).
- 예전 MySQL의 회원·좋아요 기록은 옮기지 않았습니다.
- 곡 테이블에 `itunes_track_id` 컬럼은 아직 없습니다. 미리듣기 버전을 고정하고 싶은 곡이 생기면 컬럼을 추가하고 `v_songs` 뷰에 포함시키면, 코드 수정 없이 그 ID로 재생합니다.
- 미리듣기 음원은 iTunes(Apple)가 제공하는 30초 샘플이라, 스토어에 없는 곡은 재생되지 않습니다.

---

## 8. 라이선스 · 사진 출처

### 8-1. 코드 라이선스

이 프로젝트의 자체 작성 소스 코드와 관련 소프트웨어 문서는 [MIT License](LICENSE)를 따릅니다. 저작권 표시는 `Copyright (c) 2026 schwatara-eng`입니다. 이용 조건과 면책 조항의 원문은 LICENSE 파일을 확인하세요.

외부 사진·음악·가사·뉴스·데이터·폰트 등은 각 권리자와 제공처의 이용 조건을 별도로 확인해야 합니다. 이 프로젝트의 MIT 라이선스를 해당 외부 자료에 일괄 적용하지 않습니다.

### 8-2. 공개 기사의 PHOTO 표시

2026-10-22 공개 사이트의 HTML에서 확인한 사진 크레딧입니다. **표시 내용의 확인 기록이며, 원본 사진의 라이선스나 사용 허가까지 검증했다는 뜻은 아닙니다.**

| 기사 | 공개 화면의 사진 크레딧 |
| --- | --- |
| [줄리언 카사블랑카스 — 현재 홈](https://todays-rock-app.vercel.app/) | `PHOTO \| Aurelien Guichard, CC BY-SA 2.0` |
| [라디오헤드 — 지난 기사](https://todays-rock-app.vercel.app/artist-radiohead.html) | `PHOTO \| Raph_PH, CC BY 4.0` |
| [잭 화이트 — 지난 기사](https://todays-rock-app.vercel.app/artist-jack-white.html) | `PHOTO \| Scott Penner, CC BY SA-2.0` |
| [김윤아 — 지난 기사](https://todays-rock-app.vercel.app/artist-kim-yuna.html) | `PHOTO \| www.jaurim.com` |

- 사진 크레딧은 사진 영역에 `PHOTO | …`로 표시하며, 기사 본문의 검증 자료인 `SOURCES | …`와 구분합니다.
- 사진 출처는 편집실의 **01 원고 → 사진 → 출처**에서 수정합니다. 비우면 PHOTO 표시도 사라집니다.
- 공개 기사는 DB에 저장된 게시 내용을 사용하므로, 저장소의 정적 HTML·참고용 원고와 사진 및 출처가 다를 수 있습니다. 저장소의 잭 화이트 정적 기사에는 이전 표기인 `AI-generated (OpenAI)`가 남아 있지만, 위 표는 현재 공개 화면을 기준으로 작성했습니다.
- 게시 전 원본 페이지에서 제작자·원본 URL·라이선스와 링크·변경 여부 및 요구되는 표시 사항을 확인합니다. 김윤아 사진의 사이트명 표기만으로 사용 허가 범위를 확인할 수는 없으므로, 원본 이용 조건 또는 별도 허가를 확인해야 합니다.
