/**
 * TODAY'S ROCK - 로컬 관리자 편집기 서버
 *
 * 역할
 * 1. admin 폴더의 정적 화면 제공
 * 2. 비밀키를 브라우저에 노출하지 않고 로컬 AI 모듈 직접 호출
 * 3. 초안·사실 검수·편집 검토·편집자 승인 상태를 로컬 JSON에 저장
 *
 * 실행: node --env-file=.env scripts/admin-local-fastapi.mjs
 * 주의: 로컬 개발 전용이며, 공개 배포용 로그인 시스템이 아닙니다.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────
// 1. 실행 환경과 파일 경로
// ─────────────────────────────────────────────────────────────
const root = process.cwd();
const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../admin');
const host = '127.0.0.1';
const port = Number(process.env.ADMIN_PORT || 4177);
const secret = process.env.ADMIN_SECRET;

const paths = {
  draft: path.join(root, 'articles/drafts/jack-white.json'),
  facts: path.join(root, 'facts/jack-white.json'), // 기존 수동 팩트시트는 보존
  researchedFacts: path.join(root, 'articles/research/jack-white.json'),
  factReview: path.join(root, 'articles/reviews/jack-white.json'),
  editorial: path.join(root, 'articles/reviews/jack-white-editorial.json'),
  approval: path.join(root, 'articles/approvals/jack-white.json')
};

if (!secret) {
  console.error('ADMIN_SECRET가 필요합니다. node --env-file=.env scripts/admin-local-fastapi.mjs');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// 2. 공통 유틸리티: 응답, 입력 검사, 버전 식별
// ─────────────────────────────────────────────────────────────
function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function saveJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 50000) throw Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 });
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw Object.assign(new Error('올바른 JSON 요청이 아닙니다.'), { status: 400 });
  }
}

function validArticle(article) {
  return article &&
    typeof article.title === 'string' && article.title.trim().length > 0 && article.title.length <= 300 &&
    typeof article.body === 'string' && article.body.trim().length > 0 && article.body.length <= 15000;
}

function normalize(article) {
  return { title: article.title.trim(), body: article.body.trim() };
}

// 기사 내용이 한 글자라도 바뀌면 다른 버전으로 취급한다.
function fingerprint(article) {
  return createHash('sha256').update(JSON.stringify(normalize(article))).digest('hex');
}

// ─────────────────────────────────────────────────────────────
// 3. 로컬 AI API 실행: 관리자 비밀키는 서버 내부에서만 사용
// ─────────────────────────────────────────────────────────────
const localHandlers = {
  'artist-fact-research': '../editor_ai/artist-fact-research.js',
  'artist-review': '../editor_ai/artist-review.js',
  'artist-editorial': '../editor_ai/artist-editorial.js',
  'artist-generate': '../editor_ai/artist-generate.js',
  'artist-workflow': '../editor_ai/artist-workflow.js'
};

// 기존 AI API를 로컬에서 직접 실행한다.
async function proxy(endpoint, payload) {
  const file = localHandlers[endpoint];
  if (!file) throw Object.assign(new Error('지원하지 않는 AI API입니다.'), { status: 404 });
  const { default: handler } = await import(new URL(file, import.meta.url));
  let result;
  const response = {
    statusCode: 200,
    setHeader() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(data) { result = { status: this.statusCode, data }; return this; }
  };
  await handler({ method: 'POST', headers: { 'x-admin-secret': secret }, body: payload }, response);
  if (!result) throw Object.assign(new Error('AI API 응답이 없습니다.'), { status: 502 });
  return result;
}

async function requireApi(endpoint, payload) {
  const result = await proxy(endpoint, payload);
  if (result.status !== 200) {
    throw Object.assign(new Error(result.data?.error || `API 오류 (HTTP ${result.status})`), { status: result.status });
  }
  return result.data;
}

// ─────────────────────────────────────────────────────────────
// 4. 저장 상태 및 검토 유효성 판단
// ─────────────────────────────────────────────────────────────
async function getState() {
  const [article, factSheet, factReview, editorialReview, approval] = await Promise.all([
    readJson(paths.draft),
    readJson(paths.researchedFacts),
    readJson(paths.factReview),
    readJson(paths.editorial),
    readJson(paths.approval)
  ]);

  const hash = article && validArticle(article) ? fingerprint(article) : null;
  const researchCurrent = Boolean(hash && factSheet?.articleHash === hash);
  // 평론적 표현(OPINION)은 사실 검증 대상이 아니므로 승인 조건에서 '해결됨'으로 봅니다.
  const allVerified = Boolean(researchCurrent && !factSheet.truncated && factSheet.facts.length &&
    factSheet.facts.every(f => f.verificationStatus === 'VERIFIED' || f.verificationStatus === 'OPINION'));
  const factCurrent = Boolean(allVerified && factReview?.articleHash === hash && factReview?.researchHash === factSheet.articleHash);
  const editorialCurrent = Boolean(hash && editorialReview?.articleHash === hash);
  const approved = Boolean(factCurrent && editorialCurrent && hash && approval?.articleHash === hash && approval?.status === 'approved');

  return {
    article,
    factSheet: researchCurrent ? factSheet : null,
    review: researchCurrent && factReview?.articleHash === hash ? factReview : null,
    editorialReview: editorialCurrent ? editorialReview : null,
    approval: approved ? approval : null,
    state: {
      approved,
      factCurrent,
      researchCurrent,
      allVerified,
      editorialCurrent,
      status: approved ? 'approved' : 'draft',
      published: false
    }
  };
}

// 이전 형식의 팩트시트에도 type·group·keywords가 없을 수 있으므로 기본값을 채워 API로 보냅니다.
function claimPayload(fact) {
  return {
    claim: fact.claim, field: fact.field, excerpt: fact.excerpt,
    type: fact.type || 'fact', group: fact.group || null,
    keywords: Array.isArray(fact.keywords) ? fact.keywords : []
  };
}

// 검토를 마친 뒤에도 편집자가 글을 바꿀 수 있으므로 승인 상태를 별도 관리한다.
async function invalidateApproval() {
  await saveJson(paths.approval, { status: 'draft', approved: false, invalidatedAt: new Date().toISOString() });
}

// ─────────────────────────────────────────────────────────────
// 5. 로컬 웹서버 및 기능별 요청 처리
// ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${host}:${port}`);

    // DNS 재바인딩 등 외부 페이지에서 로컬 서버를 조작하는 위험을 줄인다.
    if (![`${host}:${port}`, `localhost:${port}`].includes(req.headers.host)) {
      return send(res, 403, { error: '로컬 접근만 허용합니다.' });
    }

    // 공개 템플릿·스타일·이미지만 제공하며 .env 및 기사 기록은 노출하지 않습니다.
    if (req.method === 'GET' && url.pathname.startsWith('/site/')) {
      const asset = decodeURIComponent(url.pathname.slice(6));
      const allowed = ['index.html', 'artist-jack-white.html', 'style.css'].includes(asset) ||
        /^(images|fonts)\/[\w가-힣 .'-]+\.(png|jpe?g|webp|woff2?|otf)$/i.test(asset);
      if (!allowed) return send(res, 404, { error: '허용되지 않은 파일입니다.' });
      const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.otf': 'font/otf' };
      const content = await readFile(path.join(uiDir, '..', asset));
      res.writeHead(200, { 'Content-Type': types[path.extname(asset).toLowerCase()], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(content);
    }

    const staticFiles = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/style.css': ['style.css', 'text/css; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
      '/fonts/Galmuri9.woff2': ['../fonts/Galmuri9.woff2', 'font/woff2']
    };

    if (req.method === 'GET' && staticFiles[url.pathname]) {
      const [file, type] = staticFiles[url.pathname];
      const content = await readFile(path.join(uiDir, file));
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy':
          "default-src 'none'; " +
          "script-src 'self'; " +
          "style-src 'self' https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; " +
          "connect-src 'self'; " +
          "frame-src 'self'; img-src 'self'; " +
          "base-uri 'none'; " +
          "form-action 'none'"
      });
      return res.end(content);
    }

    // 게시 파일 내보내기는 저장된 원고와 승인 버전이 일치할 때만 허용합니다.
    // 실제 사이트에 쓰거나 배포하지 않으며, 승인된 JSON만 반환합니다.
    if (req.method === 'GET' && url.pathname === '/local/publication-export') {
      const state = await getState();
      if (!state.state.approved || !state.article ||
          !state.state.factCurrent || !state.state.editorialCurrent) {
        return send(res, 409, { error: '현재 저장된 원고의 승인과 두 검토가 필요합니다.' });
      }
      if (state.review.issues?.length || state.editorialReview.issues?.length) {
        return send(res, 409, { error: '검토 지적 사항이 남아 있어 내보낼 수 없습니다.' });
      }

      return send(res, 200, {
        id: state.article.id,
        artist: state.article.artist,
        title: state.article.title,
        body: state.article.body,
        factIds: state.article.factIds,
        editorialStatus: 'approved',
        published: false,
        approvedAt: state.approval.approvedAt
      });
    }

    if (req.method === 'GET' && url.pathname === '/local/data') {
      return send(res, 200, await getState());
    }

    if (req.method !== 'POST' || !url.pathname.startsWith('/local/')) {
      return send(res, 404, { error: '경로를 찾지 못했습니다.' });
    }

    const allowedOrigins = [`http://${host}:${port}`, `http://localhost:${port}`];
    if (!req.headers.origin || !allowedOrigins.includes(req.headers.origin)) {
      return send(res, 403, { error: '허용되지 않은 요청 출처입니다.' });
    }

    const data = await readBody(req);

    if (url.pathname === '/local/generate') {
      return send(res, 410, { error: 'AI 기사 자동 생성은 사용하지 않습니다. 에디터가 초안을 직접 작성하세요.' });
    }

    if (url.pathname === '/local/save') {
      if (!validArticle(data.article)) return send(res, 400, { error: '기사 제목 또는 본문을 확인하세요.' });
      const factSheet = await readJson(paths.facts, { artist: { name: '기사 작성자' } });
      const old = await readJson(paths.draft, {});
      const article = {
        ...old,
        id: 'jack-white',
        artist: factSheet.artist,
        ...normalize(data.article),
        factIds: [],
        status: 'draft',
        reviewed: false
      };
      await saveJson(paths.draft, article);
      await invalidateApproval();
      return send(res, 200, await getState());
    }

    // 첫 요청은 주장 추출만 수행해 즉시 저장합니다. 이후 요청마다 주장 1개씩 검증합니다.
    if (url.pathname === '/local/research') {
      if (!validArticle(data.article)) return send(res, 400, { error: '기사 제목과 본문을 확인하세요.' });
      const saved = await readJson(paths.draft);
      if (!saved || fingerprint(saved) !== fingerprint(data.article)) {
        return send(res, 409, { error: '현재 원고를 먼저 저장하세요.' });
      }
      const articleHash = fingerprint(saved);
      let sheet = await readJson(paths.researchedFacts);
      if (!sheet || sheet.articleHash !== articleHash || !Array.isArray(sheet.facts)) {
        const extracted = await requireApi('artist-fact-research', {
          article: normalize(saved), mode: 'extract'
        });
        if (!extracted.claims?.length) return send(res, 422, { error: '검증할 사실 주장을 찾지 못했습니다.' });
        sheet = {
          artist: { name: '기사 기반 자료' }, articleHash,
          facts: extracted.claims.map((claim, i) => {
            const base = {
              id: `F${String(i + 1).padStart(3, '0')}`,
              claim: claim.claim, field: claim.field, excerpt: claim.excerpt,
              type: claim.type || 'fact', group: claim.group || null,
              keywords: Array.isArray(claim.keywords) ? claim.keywords : [],
              source: null, sources: [], evidence: '', suggestion: ''
            };
            // 평론적 표현은 웹 검색 없이 바로 표시합니다. (API 호출 없음)
            return base.type === 'opinion'
              ? { ...base, verificationStatus: 'OPINION', failureType: null, checkedAt: new Date().toISOString(),
                  reason: '평론적 표현입니다. 사실 검증 대상이 아니며, 표현의 적절성은 편집자가 판단합니다.' }
              : { ...base, verificationStatus: 'NOT CHECKED', failureType: 'PENDING', checkedAt: null,
                  reason: '아직 조사하지 않았습니다.' };
          }),
          truncated: Boolean(extracted.truncated),
          generatedAt: new Date().toISOString(),
          note: '단계별 조사 중. 같은 대상을 다루는 주장끼리 묶어 출처 검색 1회로 함께 조사합니다.'
        };
        await saveJson(paths.researchedFacts, sheet);
        await invalidateApproval();
        return send(res, 200, await getState());
      }
      const index = sheet.facts.findIndex(f => f.failureType === 'PENDING');
      if (index < 0) {
        return send(res, 200, await getState());
      }
      // 첫 미조사 항목과 같은 그룹의 미조사 항목을 함께 조사합니다. (그룹 정보가 없으면 1개씩)
      const first = sheet.facts[index];
      const batch = sheet.facts
        .filter(f => f.failureType === 'PENDING' && (f === first || (first.group && f.group === first.group)))
        .slice(0, 8);
      const result = await requireApi('artist-fact-research', {
        article: normalize(saved),
        claims: batch.map(claimPayload),
        factIds: batch.map(f => f.id)
      });
      for (const fact of result.factSheet.facts || []) {
        const at = sheet.facts.findIndex(f => f.id === fact.id);
        if (at >= 0) sheet.facts[at] = fact;
      }
      // 응답에서 빠진 항목이 있으면 무한 반복을 막기 위해 검색 실패로 표시합니다.
      for (const fact of batch) {
        const at = sheet.facts.findIndex(f => f.id === fact.id);
        if (sheet.facts[at].failureType === 'PENDING') {
          sheet.facts[at] = { ...sheet.facts[at], failureType: 'SEARCH_FAILED', checkedAt: new Date().toISOString(),
            reason: '조사 응답에서 이 항목의 결과가 누락되었습니다. 재검색해 주세요.' };
        }
      }
      sheet.generatedAt = new Date().toISOString();
      await saveJson(paths.researchedFacts, sheet);
      await invalidateApproval();
      // 모든 항목을 검증한 뒤에만 전체 사실 검토를 수행합니다.
      if (!sheet.facts.some(f => f.failureType === 'PENDING')) {
        const reviewResult = await requireApi('artist-review', { article: saved, factSheet: sheet });
        await saveJson(paths.factReview, {
          ...reviewResult.review, articleHash, researchHash: articleHash
        });
      }
      return send(res, 200, await getState());
    }

    // 팩트시트의 개별 항목만 다시 검색하고 기존 다른 검증 기록은 유지합니다.
    if (url.pathname === '/local/research-one') {
      const saved = await readJson(paths.draft);
      const sheet = await readJson(paths.researchedFacts);
      if (!saved || !sheet || sheet.articleHash !== fingerprint(saved)) {
        return send(res, 409, { error: '현재 저장된 원고의 팩트시트가 필요합니다.' });
      }
      const index = sheet.facts.findIndex(f => f.id === data.factId);
      if (index < 0) return send(res, 404, { error: '검증 항목을 찾지 못했습니다.' });
      const oldFact = sheet.facts[index];
      const previousSources = Array.isArray(oldFact.sources)
  ? oldFact.sources
  : [];

const previousAttempts = Array.isArray(oldFact.attempts)
  ? oldFact.attempts
  : [];

const excludedUrls = [
  ...new Set([
    ...previousSources.map(source => source.url),
    ...previousAttempts.flatMap(attempt =>
      (attempt.sources || []).map(source => source.url)
    )
  ].filter(Boolean))
];
      if (oldFact.failureType === 'PENDING') return send(res, 409, { error: '미조사 항목은 기본 검증을 먼저 실행하세요.' });
      if (oldFact.verificationStatus === 'OPINION') return send(res, 409, { error: '평론적 표현은 출처 재검색 대상이 아닙니다.' });
      const result = await requireApi('artist-fact-research', {
        article: normalize(saved),
        claim: claimPayload(oldFact),
        factId: oldFact.id,
        excludeUrls: excludedUrls
      });
      const newFact = result.factSheet.facts[0];

const mergedSources = [
  ...previousSources,
  ...(newFact.sources || []).filter(source =>
    !previousSources.some(old => old.url === source.url)
  )
];

const attempts = [
  ...previousAttempts,
  {
    checkedAt: oldFact.checkedAt,
    verificationStatus: oldFact.verificationStatus,
    failureType: oldFact.failureType,
    reason: oldFact.reason,
    sources: previousSources
  }
];

sheet.facts[index] = {
  ...newFact,
  sources: mergedSources,
  attempts,
  ...(oldFact.verificationStatus === 'VERIFIED' &&
      newFact.verificationStatus !== 'VERIFIED'
    ? {
        verificationStatus: oldFact.verificationStatus,
        source: oldFact.source,
        evidence: oldFact.evidence,
        reason: oldFact.reason,
        suggestion: oldFact.suggestion,
        failureType: oldFact.failureType
      }
    : {})
};
      sheet.generatedAt = new Date().toISOString();
      await saveJson(paths.researchedFacts, sheet);
      const reviewResult = await requireApi('artist-review', { article: saved, factSheet: sheet });
      const hash = fingerprint(saved);
      await saveJson(paths.factReview, { ...reviewResult.review, articleHash: hash, researchHash: hash });
      await invalidateApproval();
      return send(res, 200, await getState());
    }

    if (url.pathname === '/local/review' || url.pathname === '/local/editorial' || url.pathname === '/local/recheck') {
      if (!validArticle(data.article)) return send(res, 400, { error: '기사 제목 또는 본문을 확인하세요.' });
      const article = normalize(data.article);
      const saved = await readJson(paths.draft);
      if (!saved || fingerprint(saved) !== fingerprint(article)) {
        return send(res, 409, { error: '먼저 현재 편집 내용을 초안 저장해 주세요. 저장한 버전만 검토할 수 있습니다.' });
      }

      if (url.pathname === '/local/review' || url.pathname === '/local/recheck') {
        const factSheet = await readJson(paths.researchedFacts);
        if (!factSheet || factSheet.articleHash !== fingerprint(article)) {
          return send(res, 409, { error: '먼저 현재 원고로 Fact Sheet 생성 및 웹 검증을 진행하세요.' });
        }
        const result = await requireApi('artist-review', { article, factSheet });
        await saveJson(paths.factReview, { ...result.review, articleHash: fingerprint(article), researchHash: factSheet.articleHash });
      }
      if (url.pathname === '/local/editorial' || url.pathname === '/local/recheck') {
        const result = await requireApi('artist-editorial', { article });
        await saveJson(paths.editorial, { ...result.review, articleHash: fingerprint(article) });
      }
      await invalidateApproval();
      return send(res, 200, await getState());
    }

    if (url.pathname === '/local/approve') {
      if (data.confirmSources !== true) {
        return send(res, 400, { error: '실제 출처 확인 및 최종 검토 확인이 필요합니다.' });
      }
      const state = await getState();
      if (!state.article || !validArticle(data.article) || fingerprint(state.article) !== fingerprint(data.article)) {
        return send(res, 409, { error: '현재 편집 내용과 저장된 초안이 다릅니다. 먼저 저장하고 재검수하세요.' });
      }
      if (!state.state.factCurrent || !state.state.allVerified || !state.state.editorialCurrent) {
        return send(res, 409, { error: '저장된 기사 버전의 사실 검수와 편집 검토를 모두 완료해야 합니다.' });
      }
      if (state.review.issues?.length || state.editorialReview.issues?.length) {
        return send(res, 409, { error: '검토 지적 사항이 남아 있습니다. 수정 후 재검수하세요.' });
      }
      const approval = {
        articleId: 'jack-white',
        articleHash: fingerprint(state.article),
        status: 'approved',
        approved: true,
        confirmedSources: true,
        approvedAt: new Date().toISOString(),
        published: false
      };
      await saveJson(paths.approval, approval);
      return send(res, 200, await getState());
    }

    return send(res, 404, { error: '지원하지 않는 기능입니다.' });
  } catch (error) {
    console.error('[관리자 서버 오류]', error);
    return send(res, error.status || 500, { error: error.message || '서버 오류가 발생했습니다.' });
  }
});

server.listen(port, host, () => {
  console.log(`TODAY’S ROCK 관리자 편집기: http://${host}:${port}`);
  console.log('AI API: editor_ai 모듈 직접 실행 (vercel dev 불필요)');
  console.log('외부 접속은 허용되지 않습니다.');
});

