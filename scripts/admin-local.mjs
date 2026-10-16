/**
 * TODAY'S ROCK - 로컬 관리자 편집기 서버
 *
 * 역할
 * 1. admin 폴더의 정적 화면 제공
 * 2. 비밀키를 브라우저에 노출하지 않고 Vercel 개발 API 호출
 * 3. 초안·사실 검수·편집 검토·편집자 승인 상태를 로컬 JSON에 저장
 *
 * 실행: node --env-file=.env scripts/admin-local.mjs
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

const upstreamCandidates = process.env.VERCEL_DEV_URL
  ? [process.env.VERCEL_DEV_URL.replace(/\/$/, '')]
  : ['http://localhost:3001', 'http://127.0.0.1:3001'];

const paths = {
  draft: path.join(root, 'articles/drafts/jack-white.json'),
  facts: path.join(root, 'facts/jack-white.json'), // 기존 수동 팩트시트는 보존
  researchedFacts: path.join(root, 'articles/research/jack-white.json'),
  factReview: path.join(root, 'articles/reviews/jack-white.json'),
  editorial: path.join(root, 'articles/reviews/jack-white-editorial.json'),
  approval: path.join(root, 'articles/approvals/jack-white.json')
};

if (!secret) {
  console.error('ADMIN_SECRET가 필요합니다. node --env-file=.env scripts/admin-local.mjs');
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
// 3. Vercel API 프록시: 관리자 비밀키는 서버에서만 전송
// ─────────────────────────────────────────────────────────────
async function proxy(endpoint, payload) {
  let lastError;

  for (const upstream of upstreamCandidates) {
    const address = `${upstream}/api/${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000);

    try {
      console.log(`[API 요청] ${address}`);
      const response = await fetch(address, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-secret': secret
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const result = await response.json();
      console.log(`[API 응답] ${endpoint}: HTTP ${response.status}`);
      return { status: response.status, data: result };
    } catch (error) {
      lastError = error;
      console.error(`[API 연결 실패] ${address}: ${error.cause?.message || error.message}`);
      // 서버에서 HTTP 응답을 받은 경우에는 다른 주소로 재시도하지 않는다.
      // 네트워크 연결 실패에만 후보 주소를 순서대로 사용한다.
    } finally {
      clearTimeout(timer);
    }
  }

  throw Object.assign(new Error(`Vercel 개발 서버 연결 실패: ${lastError?.message || '알 수 없는 오류'}`), { status: 502 });
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
  const allVerified = Boolean(researchCurrent && !factSheet.truncated && factSheet.facts.length && factSheet.facts.every(f => f.verificationStatus === 'VERIFIED'));
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

    const staticFiles = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/style.css': ['style.css', 'text/css; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8']
    };

    if (req.method === 'GET' && staticFiles[url.pathname]) {
      const [file, type] = staticFiles[url.pathname];
      const content = await readFile(path.join(uiDir, file));
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"
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

    // 에디터가 저장한 원고에서 주장 추출 → 웹 검색 → 실제 페이지 확인 → AI 대조.
    if (url.pathname === '/local/research') {
      if (!validArticle(data.article)) return send(res, 400, { error: '기사 제목과 본문을 확인하세요.' });
      const saved = await readJson(paths.draft);
      if (!saved || fingerprint(saved) !== fingerprint(data.article)) {
        return send(res, 409, { error: '현재 원고를 먼저 저장하세요.' });
      }
      const result = await requireApi('artist-fact-research', { article: normalize(data.article) });
      const articleHash = fingerprint(saved);
      const factSheet = { ...result.factSheet, articleHash };
      await saveJson(paths.researchedFacts, factSheet);
      const reviewResult = await requireApi('artist-review', { article: saved, factSheet });
      await saveJson(paths.factReview, { ...reviewResult.review, articleHash, researchHash: articleHash });
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
  console.log(`AI API 서버 후보: ${upstreamCandidates.join(' → ')}`);
  console.log('외부 접속은 허용되지 않습니다.');
});
