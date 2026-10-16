/**
 * TODAY'S ROCK — 로컬 관리자 편집기 서버
 *
 * 역할
 * 1. admin 폴더의 편집 화면을 로컬 브라우저에 제공한다.
 * 2. 비밀키를 브라우저에 노출하지 않고 Vercel API에 요청한다.
 * 3. 생성·검수된 기사 파일을 프로젝트 폴더에 저장한다.
 *
 * 실행: node --env-file=.env scripts/admin-local.mjs
 * 주의: 이 서버는 로컬 개발 전용이며 공개 배포용 인증 시스템이 아니다.
 */

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ────────────────────────────────────────────────────────────
// 1. 서버 주소와 프로젝트 파일 경로
// ────────────────────────────────────────────────────────────
const root = process.cwd();
const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../admin');
const host = '127.0.0.1';
const port = Number(process.env.ADMIN_PORT || 4177);
const secret = process.env.ADMIN_SECRET;

// .env에 VERCEL_DEV_URL이 있으면 그 주소를 우선 사용한다.
// 없으면 브라우저에서 확인한 localhost:3001을 먼저 시도한다.
// localhost 연결이 거절될 경우에만 127.0.0.1:3001로 재시도한다.
const configuredUpstream = process.env.VERCEL_DEV_URL?.trim();
const upstreams = configuredUpstream
  ? [configuredUpstream.replace(/\/$/, '')]
  : ['http://localhost:3001', 'http://127.0.0.1:3001'];

const draftPath = path.join(root, 'articles/drafts/jack-white.json');
const reviewPath = path.join(root, 'articles/reviews/jack-white.json');
const factPath = path.join(root, 'facts/jack-white.json');

if (!secret) {
  console.error('ADMIN_SECRET가 필요합니다.');
  console.error('실행: node --env-file=.env scripts/admin-local.mjs');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────
// 2. 공통 함수: 응답·파일·요청 데이터 처리
// ────────────────────────────────────────────────────────────
function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

async function jsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function body(req) {
  let text = '';

  for await (const chunk of req) {
    text += chunk;
    if (text.length > 50000) {
      throw new Error('요청이 너무 큽니다.');
    }
  }

  return JSON.parse(text || '{}');
}

function articleOk(article) {
  return Boolean(
    article &&
    typeof article.title === 'string' &&
    article.title.trim() &&
    article.title.length <= 300 &&
    typeof article.body === 'string' &&
    article.body.trim() &&
    article.body.length <= 15000
  );
}

async function saveJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

// ────────────────────────────────────────────────────────────
// 3. Vercel API 연결
// ────────────────────────────────────────────────────────────
async function proxy(endpoint, payload) {
  let lastNetworkError;

  for (const upstream of upstreams) {
    // AI 생성·검수는 오래 걸릴 수 있어 최대 120초 기다린다.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const url = `${upstream}/api/${endpoint}`;

    try {
      console.log(`[API 요청] ${url}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-secret': secret,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      // API가 반환한 HTTP 오류(401, 500 등)는 연결 실패와 구분한다.
      const raw = await response.text();
      let data;

      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`API 응답이 JSON이 아닙니다. 주소: ${url}, 상태: ${response.status}`);
      }

      return { status: response.status, data };
    } catch (error) {
      // 타임아웃은 주소를 바꿔 다시 생성하면 중복 실행될 수 있으므로 재시도하지 않는다.
      if (controller.signal.aborted) {
        throw new Error(`API 요청 시간 초과(120초): ${url}`);
      }

      // 실제 네트워크 연결 실패일 때만 대체 주소를 시도한다.
      if (error instanceof TypeError && error.message === 'fetch failed') {
        lastNetworkError = error;
        console.error(`[API 연결 실패] ${url}: ${error.cause?.message || error.message}`);
        continue;
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    `Vercel 개발 서버에 연결할 수 없습니다. 확인한 주소: ${upstreams.join(', ')}. ` +
    `마지막 오류: ${lastNetworkError?.cause?.message || lastNetworkError?.message || '알 수 없음'}`
  );
}

// ────────────────────────────────────────────────────────────
// 4. 브라우저 요청 처리
// ────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${host}:${port}`);

    // 로컬 전용 서버: 다른 Host 헤더를 가진 요청은 거절한다.
    const allowedHosts = [`${host}:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host)) {
      return send(res, 403, { error: '로컬 접근만 허용합니다.' });
    }

    // 편집 화면의 정적 파일을 제공한다.
    const staticFiles = {
      '/': ['index.html', 'text/html; charset=utf-8'],
      '/style.css': ['style.css', 'text/css; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    };

    if (req.method === 'GET' && staticFiles[url.pathname]) {
      const [fileName, contentType] = staticFiles[url.pathname];
      const contents = await readFile(path.join(uiDir, fileName));
      const headers = {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };

      if (fileName === 'index.html') {
        headers['Content-Security-Policy'] =
          "default-src 'none'; script-src 'self'; style-src 'self'; " +
          "connect-src 'self'; base-uri 'none'; form-action 'none'";
      }

      res.writeHead(200, headers);
      return res.end(contents);
    }

    // 저장된 기사, 검수 결과, Fact Sheet를 화면에 불러온다.
    if (req.method === 'GET' && url.pathname === '/local/data') {
      const article = await jsonFile(draftPath).catch(() => null);
      const review = await jsonFile(reviewPath).catch(() => null);
      const factSheet = await jsonFile(factPath);
      return send(res, 200, { article, review, factSheet });
    }

    if (req.method !== 'POST' || !url.pathname.startsWith('/local/')) {
      return send(res, 404, { error: '경로를 찾지 못했습니다.' });
    }

    // 다른 웹사이트에서 로컬 편집기로 POST 요청을 보내는 것을 차단한다.
    const origin = req.headers.origin;
    const allowedOrigins = [`http://${host}:${port}`, `http://localhost:${port}`];
    if (origin && !allowedOrigins.includes(origin)) {
      return send(res, 403, { error: '다른 사이트에서의 요청을 허용하지 않습니다.' });
    }

    const data = await body(req);

    // AI 기사 생성 + AI 검수를 순서대로 실행하고 결과를 파일에 저장한다.
    if (url.pathname === '/local/generate') {
      const result = await proxy('artist-workflow', {});

      if (result.status === 200) {
        await saveJson(draftPath, result.data.article);
        await saveJson(reviewPath, result.data.review);
      }

      return send(res, result.status, result.data);
    }

    // 화면에서 수정한 기사에 대해 AI 검수를 다시 실행한다.
    if (url.pathname === '/local/review') {
      if (!articleOk(data.article)) {
        return send(res, 400, { error: '제목 또는 본문을 확인하세요.' });
      }

      const result = await proxy('artist-review', {
        article: {
          title: data.article.title,
          body: data.article.body,
        },
      });

      if (result.status === 200) {
        await saveJson(reviewPath, result.data.review);
      }

      return send(res, result.status, result.data);
    }

    // 편집자가 수정한 기사를 초안으로 저장한다. 저장은 승인을 의미하지 않는다.
    if (url.pathname === '/local/save') {
      if (!articleOk(data.article)) {
        return send(res, 400, { error: '제목 또는 본문을 확인하세요.' });
      }

      const factSheet = await jsonFile(factPath);
      const article = {
        id: 'jack-white',
        artist: factSheet.artist,
        title: data.article.title.trim(),
        body: data.article.body.trim(),
        factIds: factSheet.facts
          .filter((fact) => fact.verificationStatus === 'verified')
          .map((fact) => fact.id),
        status: 'draft',
        reviewed: false,
      };

      await saveJson(draftPath, article);
      return send(res, 200, {
        success: true,
        article,
        message: '로컬 초안 저장 완료. 수정 후 재검수하세요.',
      });
    }

    return send(res, 404, { error: '지원하지 않는 기능입니다.' });
  } catch (error) {
    console.error('Admin local error:', error);
    return send(res, 500, {
      error: '작업 중 오류가 발생했습니다. 로컬 서버 로그를 확인하세요.',
    });
  }
});

// ────────────────────────────────────────────────────────────
// 5. 서버 시작
// ────────────────────────────────────────────────────────────
server.listen(port, host, () => {
  console.log(`TODAY’S ROCK 관리자 편집기: http://${host}:${port}`);
  console.log(`AI API 서버 후보: ${upstreams.join(' → ')}`);
  console.log('외부 접속은 허용되지 않습니다.');
});
