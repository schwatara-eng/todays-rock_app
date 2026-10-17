/**
 * 팩트체크 실검증 스크립트 (잭 화이트 원고)
 *
 * 편집실과 같은 API를 같은 순서로 호출해 결과를 표로 출력합니다.
 * 편집실 저장 파일(articles/research/jack-white.json)은 건드리지 않고
 * articles/research/live-test-jack-white.json 에 따로 저장합니다.
 *
 * 실행 (터미널 A에서 npx vercel dev 실행 중일 때, 프로젝트 루트에서):
 *   node --env-file=.env scripts/factcheck-live.mjs
 * API 서버 주소가 다르면 .env 또는 실행 전에 VERCEL_DEV_URL을 지정하세요. (기본 http://127.0.0.1:3000)
 */
import { writeFile, mkdir } from 'node:fs/promises';

const secret = process.env.ADMIN_SECRET;
if (!secret) throw new Error('ADMIN_SECRET 환경변수가 필요합니다. node --env-file=.env 로 실행하세요.');
const base = (process.env.VERCEL_DEV_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

const article = {
  title: '기타 하나, 드럼 하나로 록을 다시 날것으로 돌려놓은 사람',
  body: "디트로이트 출신의 기타리스트이자 싱어송라이터 잭 화이트(Jack White). 1997년 메그 화이트와 결성한 2인조 화이트 스트라이프스(The White Stripes)로 이름을 알렸다. 베이스 없이 기타와 드럼만으로 꽉 찬 소리를 만들어냈고, 빨강·하양·검정 세 가지 색으로 무대와 앨범을 통일했다. 2000년대 초 개러지 록 리바이벌의 상징이 된 이유다. 블루스를 뿌리에 두고 아날로그 녹음과 바이닐을 고집하는 그는 지금도 가장 '손맛' 나는 록을 하는 뮤지션으로 꼽힌다."
};

let calls = 0;
async function api(endpoint, payload) {
  calls++;
  const started = Date.now();
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'x-admin-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300000)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}: ${data.error || '요청 실패'}`);
  console.log(`  · ${endpoint} 완료 (${((Date.now() - started) / 1000).toFixed(1)}초)`);
  return data;
}

const t0 = Date.now();
console.log(`API 서버: ${base}\n1) 사실 추출`);
const extracted = await api('artist-fact-research', { article, mode: 'extract' });
const facts = extracted.claims.map((c, i) => ({ id: `F${String(i + 1).padStart(3, '0')}`, ...c }));
for (const f of facts) console.log(`  ${f.id} [${f.type}] ${f.group} | ${f.claim} | 키워드: ${f.keywords.join(', ')}`);

console.log('\n2) 그룹별 출처 조사');
const results = new Map();
const groups = new Map();
for (const f of facts) {
  if (f.type === 'opinion') {
    results.set(f.id, { ...f, verificationStatus: 'OPINION', reason: '평론적 표현', sources: [] });
    continue;
  }
  const key = f.group || f.id;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(f);
}
for (const [group, members] of groups) {
  for (let i = 0; i < members.length; i += 8) {
    const batch = members.slice(i, i + 8);
    console.log(` ${group}: ${batch.map(f => f.id).join(', ')}`);
    try {
      const data = await api('artist-fact-research', {
        article,
        claims: batch.map(({ claim, field, excerpt, type, group: g, keywords }) => ({ claim, field, excerpt, type, group: g, keywords })),
        factIds: batch.map(f => f.id)
      });
      for (const fact of data.factSheet.facts) results.set(fact.id, fact);
    } catch (error) {
      console.error(`  ! ${group} 조사 실패: ${error.message}`);
      for (const f of batch) results.set(f.id, { ...f, verificationStatus: 'NOT CHECKED', failureType: 'SEARCH_FAILED', reason: error.message, sources: [] });
    }
  }
}
const factSheet = { facts: facts.map(f => results.get(f.id)) };

console.log('\n3) 검수 보고서');
const { review } = await api('artist-review', { article, factSheet });

// ── 출력 ──
const label = { VERIFIED: '확인', CONTRADICTED: '불일치', INSUFFICIENT: '근거 부족', 'NOT CHECKED': '미검증', OPINION: '평론' };
console.log('\n━━ 사실별 결과 ━━');
for (const f of factSheet.facts) {
  console.log(`${f.id} ${label[f.verificationStatus] || f.verificationStatus}${f.failureType ? ` (${f.failureType})` : ''} | ${f.claim}`);
  if (f.evidence) console.log(`     근거: "${f.evidence}" — ${f.source?.publisher} ${f.source?.url}`);
  else if (f.verificationStatus !== 'OPINION') console.log(`     사유: ${String(f.reason || '').slice(0, 220)}`);
  for (const s of f.sources || []) console.log(`     · ${s.verificationStatus}${s.failureType ? '/' + s.failureType : ''} ${s.url}`);
}
if (review.report) {
  console.log('\n━━ 검수 보고서 ━━');
  console.log(review.report.overall);
  for (const r of review.report.rows) console.log(`- ${r.text} | ${r.verdict} | ${r.note}`);
  console.log(`\n수정 제안 ${review.report.corrections.length}건`);
  for (const c of review.report.corrections) console.log(`- "${c.text}" → "${c.suggestion}" (${c.problem})`);
} else {
  console.log('\n(검수 보고서 생성 실패 — vercel dev 터미널의 [검수 보고서 생성 실패] 로그를 확인하세요)');
}
const count = s => factSheet.facts.filter(f => f.verificationStatus === s).length;
console.log(`\n요약: 사실 ${factSheet.facts.length}개 중 확인 ${count('VERIFIED')} · 불일치 ${count('CONTRADICTED')} · 근거 부족 ${count('INSUFFICIENT')} · 미검증 ${count('NOT CHECKED')} · 평론 ${count('OPINION')}`);
console.log(`API 요청 ${calls}회, 총 ${((Date.now() - t0) / 1000).toFixed(0)}초`);

await mkdir('articles/research', { recursive: true });
await writeFile('articles/research/live-test-jack-white.json',
  `${JSON.stringify({ article, factSheet, review, testedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
console.log('저장: articles/research/live-test-jack-white.json (편집실 데이터와 별도)');
