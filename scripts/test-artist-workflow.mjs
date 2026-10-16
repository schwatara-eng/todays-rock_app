// 실행: node --env-file=.env scripts/test-artist-workflow.mjs
import { writeFile, mkdir } from 'node:fs/promises';
const secret = process.env.ADMIN_SECRET;
if (!secret) throw new Error('ADMIN_SECRET 환경변수가 필요합니다.');
const response = await fetch('http://localhost:3000/api/artist-workflow', {
  method: 'POST', headers: { 'x-admin-secret': secret, 'content-type': 'application/json' },
  body: '{}'
});
const data = await response.json();
if (!response.ok) throw new Error(`HTTP ${response.status}: ${data.error || '요청 실패'}`);
await mkdir('articles/drafts', { recursive: true });
await mkdir('articles/reviews', { recursive: true });
await writeFile('articles/drafts/jack-white.json', JSON.stringify(data.article, null, 2) + '\n', 'utf8');
await writeFile('articles/reviews/jack-white.json', JSON.stringify(data.review, null, 2) + '\n', 'utf8');
console.log('초안 저장: articles/drafts/jack-white.json');
console.log('검수 저장: articles/reviews/jack-white.json');
console.log(`검수 지적: ${data.review.issues.length}개 (게시되지 않음)`);
