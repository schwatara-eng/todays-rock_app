# TODAY’S ROCK — AI 기사 생성·검수 통합 (로컬 개발용)

## 설치
기존 프로젝트 루트에 이 압축파일의 `api/`, `scripts/`, `facts/`, `articles/` 폴더를 합칩니다. 기존 `api/news.js` 등 다른 파일은 유지합니다.

**주의:** `articles/drafts/jack-white.json`은 기존 수동 예시이므로 기존 파일을 보존하려면 덮어쓰지 않아도 됩니다. `facts/jack-white.json`은 검증한 원본과 비교 후 유지하세요. `articles/reviews/jack-white.json`은 실행 시 생성됩니다.

기존 `.env`의 `OPENAI_API_KEY`, `OPENAI_MODEL`, `ADMIN_SECRET`을 그대로 사용합니다. 비밀값을 코드나 브라우저에 넣지 마세요. `npm install openai`가 설치되어 있어야 합니다.

## 한 번에 실행
1. VS Code 터미널 A: `npx vercel dev`
2. 별도 터미널 B(프로젝트 루트): `node --env-file=.env scripts/test-artist-workflow.mjs`
3. `articles/drafts/jack-white.json`, `articles/reviews/jack-white.json`을 VS Code에서 엽니다.

위 스크립트는 **AI API를 두 번 호출하므로 비용이 발생**합니다. 검수 결과가 문제가 없다고 해도 `approved: false`이며 자동 게시는 하지 않습니다.

## API
- `POST /api/artist-generate`: Fact Sheet에서 기사 초안 생성. 응답 `{article}`.
- `POST /api/artist-review`: JSON 본문 `{ "article": { "title": "...", "body": "..." } }`을 검수. 응답 `{review}`.
- `POST /api/artist-workflow`: 생성 후 즉시 검수. 응답 `{article, review, published:false}`.

세 API 모두 `x-admin-secret` 헤더가 필요합니다. 현재는 잭 화이트 1인 전용으로 파일 경로가 고정돼 있습니다.

## 운영상 제한
- 검수는 **제공된 Fact Sheet와 기사 사이의 일관성 검사**입니다. AI가 출처 사이트를 직접 열람하거나 외부 사실을 독립 검증하지 않습니다.
- `verificationStatus: verified`는 편집자가 출처를 직접 확인한 상태여야 합니다.
- 로컬 스크립트가 파일을 저장합니다. Vercel 함수는 영구 파일 저장을 수행하지 않습니다.
- 기존 공개 사이트에는 자동 반영되지 않습니다.
- 이 비밀키 방식은 브라우저 관리자 UI에 직접 연결하지 마세요. 공개 배포 전 세션 인증, 요청 제한, 사용량 통제, 접근 로그 및 검토·게시 분리가 필요합니다.
- 로컬 테스트 중 `articles/drafts/jack-white.json` 및 `articles/reviews/jack-white.json`은 재실행 시 덮어씁니다. 수동 수정본은 미리 백업하세요.
