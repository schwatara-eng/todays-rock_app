# TODAY’S ROCK — 로컬 관리자 편집기

## 설치
기존 `todays-rock_app` 프로젝트 루트에 압축파일의 `admin/` 및 `scripts/admin-local.mjs`를 복사합니다. 기존 `api/`, `facts/`, `articles/`는 유지합니다. Node.js 20 이상이 필요합니다.

## 실행
1. 터미널 A: `npx vercel dev` (예: `http://localhost:3001`)
2. 터미널 B (프로젝트 루트): `node --env-file=.env scripts/admin-local.mjs`
3. 브라우저: `http://127.0.0.1:4177`

Vercel 개발 서버 포트가 **3000**이라면 터미널 B 실행 전 PowerShell에서 `$env:VERCEL_DEV_URL='http://127.0.0.1:3000'` 설정 후 실행하세요. 기본값은 **3001**입니다.

## 기능
- 검증된 Fact Sheet 확인 및 출처 링크 열기
- GPT-5 mini 기사 생성 후 AI 검수 (로컬 초안·검수 파일 덮어쓰기)
- 제목·본문 수정 후 초안 저장
- 수정된 본문 AI 재검수 (검수 결과만 저장)
- **게시/승인 기능 없음**. 공개 TODAY’S ROCK 사이트와 별개입니다.

## 주의
- AI 생성과 재검수는 OpenAI API 요금이 발생합니다.
- `ADMIN_SECRET`은 로컬 Node 서버의 환경변수에서 읽으며 HTML/JS에 노출하지 않습니다.
- 로컬 서버는 `127.0.0.1`에만 바인딩됩니다. 이 도구를 Vercel에 배포하거나 공용 네트워크에 노출하지 마세요.
- Fact Sheet는 현재 `jack-white.json` 하나로 고정되어 있습니다.
- AI 검수는 사실 원문을 인터넷에서 재검증하지 않고 등록된 `claim`과 비교합니다.
- 초안 저장 시 이전 검수 결과가 남아 있을 수 있으므로 수정 후 재검수하세요.
- 실제 게시를 위한 승인, 인증 세션, 변경 이력, 데이터 영구 저장은 추후 별도 구현이 필요합니다.
