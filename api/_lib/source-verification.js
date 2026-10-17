/**
 * 원고 기반 사실 추출 및 출처 대조.
 *
 * 흐름
 * 1) 사실 추출: 원고를 사실(fact)·해석(interpretation)·평론적 표현(opinion)으로 나누고,
 *    같은 대상을 다루는 사실끼리 검색 그룹(group)으로 묶습니다.
 * 2) 출처 검색: 그룹마다 OpenAI 웹 검색 1회. 후보 URL은 실제 검색 결과에 등장한 것만 씁니다.
 * 3) 본문 확보: HTTPS 페이지 본문을 받아(위키백과는 텍스트 API) 주장과 관련된 단락만 골라냅니다.
 * 4) 판정: 출처 1개당 AI 호출 1회로 그룹 안의 사실 여러 개를 '사실별로' 판정합니다.
 *    AI가 제시한 인용문이 실제 본문에 있는지는 코드가 사실별로 다시 대조합니다.
 *
 * 주의: 자동 검증은 사람의 출처 확인을 대체하지 않습니다.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { structuredResponse } from './artist-common.js';

const model = () => process.env.OPENAI_MODEL || 'gpt-5-mini';
const MAX_CLAIMS = 24;            // 추출할 최대 주장 수 (호출 수는 그룹 수에 비례)
const MAX_CANDIDATES = 5;         // 그룹당 확보할 출처 후보 수 (접근 실패 대비)
const MAX_READ_SOURCES = 3;       // 그룹당 본문을 읽어 판정할 최대 출처 수
const MAX_PAGE_BYTES = 2_000_000; // 이보다 크면 앞부분까지만 읽고 계속 진행 (실패 처리하지 않음)
const MAX_PROMPT_CHARS = 14000;   // 판정 AI에 보낼 본문 발췌 최대 길이
const MAX_REDIRECTS = 3;
const SEARCH_TIMEOUT_MS = 120000;
const fail = (message, status = 422) => Object.assign(new Error(message), { httpStatus: status });

export const CLAIM_TYPES = ['fact', 'interpretation', 'opinion'];

// ─────────────────────────────────────────────────────────────
// 스키마
// ─────────────────────────────────────────────────────────────
const claimSchema = {
  type: 'object', additionalProperties: false,
  properties: { claims: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: {
      claim: { type: 'string' },
      field: { type: 'string', enum: ['title', 'body'] },
      excerpt: { type: 'string' },
      type: { type: 'string', enum: CLAIM_TYPES },
      group: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' } }
    },
    required: ['claim', 'field', 'excerpt', 'type', 'group', 'keywords']
  } } }, required: ['claims']
};

const searchSchema = {
  type: 'object', additionalProperties: false,
  properties: { sources: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: { url: { type: 'string' }, publisher: { type: 'string' }, reason: { type: 'string' } },
    required: ['url', 'publisher', 'reason']
  } } }, required: ['sources']
};

const groupVerdictSchema = {
  type: 'object', additionalProperties: false,
  properties: { results: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: {
      id: { type: 'string' },
      verdict: { type: 'string', enum: ['VERIFIED', 'CONTRADICTED', 'INSUFFICIENT'] },
      reason: { type: 'string' }, evidence: { type: 'string' }, suggestion: { type: 'string' }
    },
    required: ['id', 'verdict', 'reason', 'evidence', 'suggestion']
  } } }, required: ['results']
};

// ─────────────────────────────────────────────────────────────
// URL 안전 검사
// ─────────────────────────────────────────────────────────────
function publicIP(address) {
  if (isIP(address) === 4) {
    const a = address.split('.').map(Number);
    return !(a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
      (a[0] === 169 && a[1] === 254) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && a[1] === 168) || (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
      (a[0] === 192 && a[1] === 0) || (a[0] === 198 && (a[1] === 18 || a[1] === 19)));
  }
  if (isIP(address) === 6) {
    const v = address.toLowerCase();
    return !(v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') ||
      v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') ||
      v.startsWith('::ffff:'));
  }
  return false;
}

function checkUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw fail('잘못된 출처 URL'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !url.hostname.includes('.') || isIP(url.hostname) || url.hostname.endsWith('.local')) {
    throw fail('허용되지 않는 출처 URL');
  }
  return url;
}

// 검색 결과에 실제 등장한 URL만 사용하고, URL의 추적 매개변수는 제거합니다.
function canonicalUrl(raw) {
  const url = checkUrl(raw);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

// 모델이 URL을 옮겨 적으며 생기는 사소한 차이(www, 끝 슬래시, 모바일 위키)를 무시하는 비교용 키
function matchKey(raw) {
  const url = new URL(canonicalUrl(raw));
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.m\.wikipedia\.org$/, '.wikipedia.org');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `${host}${path}${url.search}`;
}

// ─────────────────────────────────────────────────────────────
// 출처 본문 확보
// ─────────────────────────────────────────────────────────────
function decodeEntities(text) {
  return text
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } })
    .replace(/&amp;/gi, '&');
}

function htmlToText(html) {
  // 본문(<article>/<main>)이 있으면 그 부분을 우선 사용하고, 메뉴·광고 영역은 제거합니다.
  const main = html.match(/<article\b[\s\S]*<\/article>/i)?.[0] || html.match(/<main\b[\s\S]*<\/main>/i)?.[0];
  const source = main && main.length > 2000 ? main : html;
  const withoutNoise = source
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(withoutNoise).replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

async function resolvePublic(hostname) {
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicIP(item.address))) throw fail('사설망 주소 차단');
  return addresses;
}

// 안전한 GET: 공개 IP 고정, 리다이렉트는 매번 같은 검사를 거쳐 최대 3회까지 따라갑니다.
async function safeGet(raw, accept, redirects = 0) {
  const url = checkUrl(raw);
  const addresses = await resolvePublic(url.hostname);
  const https = await import('node:https');
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: 15000,
      // DNS 검사 후의 주소 변경(DNS 재바인딩)을 막기 위해 검사한 주소로 고정합니다.
      lookup: (_host, opts, callback) => {
        const item = addresses[0];
        if (opts?.all) callback(null, [{ address: item.address, family: item.family }]);
        else callback(null, item.address, item.family);
      },
      headers: { 'User-Agent': 'TodaysRockEditorialResearch/1.1 (fact-check)', Accept: accept }
    }, response => {
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) { reject(fail('출처 페이지 리다이렉트 초과')); return; }
        const next = new URL(response.headers.location, url).href;
        safeGet(next, accept, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume(); reject(fail(`출처 페이지 HTTP ${status}`)); return;
      }
      const type = response.headers['content-type'] || '';
      let size = 0; const chunks = []; let truncated = false;
      response.on('data', chunk => {
        if (truncated) return;
        size += chunk.length;
        chunks.push(chunk);
        // 큰 페이지는 실패 처리하지 않고 앞부분만 사용합니다.
        if (size > MAX_PAGE_BYTES) { truncated = true; response.destroy(); finish(); }
      });
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        resolve({ body: Buffer.concat(chunks).toString('utf8'), type, truncated, finalUrl: url.href });
      };
      response.on('end', finish);
      response.on('close', finish);
      response.on('error', error => { if (!truncated) reject(error); });
    });
    request.on('timeout', () => request.destroy(fail('출처 페이지 시간 초과')));
    request.on('error', error => reject(error.httpStatus ? error : fail(`출처 페이지 접근 실패: ${error.code || error.message}`)));
  });
}

// 위키백과는 HTML이 매우 크므로 공식 텍스트 추출 API를 사용합니다.
function wikipediaTitle(url) {
  const match = url.hostname.match(/^([a-z-]+)\.(?:m\.)?wikipedia\.org$/i);
  if (!match || !url.pathname.startsWith('/wiki/')) return null;
  return { lang: match[1], title: decodeURIComponent(url.pathname.slice(6)) };
}

async function wikipediaText(url) {
  const wiki = wikipediaTitle(url);
  const api = new URL(`https://${wiki.lang}.wikipedia.org/w/api.php`);
  for (const [key, value] of Object.entries({ action: 'query', prop: 'extracts', explaintext: '1',
    redirects: '1', format: 'json', formatversion: '2', titles: wiki.title })) api.searchParams.set(key, value);
  const result = await safeGet(api.href, 'application/json');
  const page = JSON.parse(result.body)?.query?.pages?.[0];
  if (!page?.extract) throw fail('위키백과 문서를 찾지 못했습니다.');
  return page.extract;
}

const pageCache = new Map(); // 같은 요청 안에서 같은 URL은 한 번만 내려받습니다.

export async function pageText(raw) {
  const key = canonicalUrl(raw);
  if (!pageCache.has(key)) {
    pageCache.set(key, (async () => {
      const url = checkUrl(raw);
      if (wikipediaTitle(url)) return wikipediaText(url);
      if (/\.pdf$/i.test(url.pathname)) throw fail('PDF 출처는 자동으로 읽지 않습니다. 직접 확인해 주세요.');
      const page = await safeGet(url.href, 'text/html, text/plain;q=0.9');
      if (/pdf/i.test(page.type)) throw fail('PDF 출처는 자동으로 읽지 않습니다. 직접 확인해 주세요.');
      if (!/text\/html|text\/plain|xhtml/i.test(page.type)) throw fail('텍스트 페이지가 아닙니다.');
      return /text\/plain/i.test(page.type) ? page.body : htmlToText(page.body);
    })());
    if (pageCache.size > 50) pageCache.delete(pageCache.keys().next().value);
  }
  try {
    const text = await pageCache.get(key);
    if (text.replace(/\s+/g, ' ').length < 150) {
      throw fail('읽을 수 있는 본문이 거의 없습니다. 자바스크립트로 그려지는 페이지일 수 있습니다.');
    }
    return text;
  } catch (error) {
    pageCache.delete(key);
    throw error;
  }
}

// 본문 앞부분만 자르지 않고, 주장 키워드가 많이 나오는 단락을 골라 AI에 보냅니다.
export function selectPassages(text, keywords, limit = MAX_PROMPT_CHARS) {
  const clean = text.replace(/[ \t]+/g, ' ');
  if (clean.length <= limit) return clean;
  const terms = [...new Set(keywords.map(k => String(k).toLowerCase().trim()).filter(k => k.length >= 2))];
  const paragraphs = clean.split(/\n+/).flatMap(p => {
    if (p.length <= 1200) return [p];
    const parts = []; // 아주 긴 단락은 문장 경계로 나눕니다.
    let buf = '';
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if ((buf + sentence).length > 1000 && buf) { parts.push(buf); buf = ''; }
      buf += (buf ? ' ' : '') + sentence;
    }
    if (buf) parts.push(buf);
    return parts;
  }).filter(p => p.trim());
  const scored = paragraphs.map((p, index) => {
    const lower = p.toLowerCase();
    let score = 0;
    for (const term of terms) if (lower.includes(term)) score += term.length >= 5 ? 2 : 1;
    if (index < 3) score += 1; // 도입부(인물 소개)는 근거가 되는 경우가 많습니다.
    return { index, p, score };
  });
  const chosen = new Set();
  let used = 0;
  for (const item of [...scored].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (item.score <= 0 && used > limit / 2) break;
    if (used + item.p.length > limit) continue;
    chosen.add(item.index); used += item.p.length + 6;
  }
  const ordered = scored.filter(item => chosen.has(item.index));
  return ordered.map((item, i) => (i > 0 && item.index !== ordered[i - 1].index + 1 ? '[…]\n' : '') + item.p).join('\n');
}

// ─────────────────────────────────────────────────────────────
// 출처 검색 (그룹당 1회)
// ─────────────────────────────────────────────────────────────
async function searchSources(client, claims, excludeUrls = []) {
  const excluded = new Set(excludeUrls.flatMap(raw => { try { return [matchKey(raw)]; } catch { return []; } }));
  const list = claims.map((c, i) => `${i + 1}. ${c.claim}${c.keywords?.length ? ` (키워드: ${c.keywords.join(', ')})` : ''}`).join('\n');
  const response = await client.responses.create({
    model: model(), reasoning: { effort: 'low' },
    tools: [{ type: 'web_search', search_context_size: 'medium' }],
    include: ['web_search_call.action.sources'],
    tool_choice: 'required',
    instructions: `음악 기사 사실 검증을 위한 출처 조사자입니다.
아래 주장들은 같은 대상을 다룹니다. 주장들을 함께 확인할 수 있는 출처를 찾으세요.
영어권 아티스트라면 영어 키워드로 검색하세요. 작품명·연도·사건 등 핵심 키워드를 사용하세요.
실제 검색 결과에 나온 URL만 선정하세요. URL을 지어내거나 고쳐 쓰지 마세요.
우선순위: 공식 사이트·음반사·시상식 기관 > 신뢰할 만한 언론·음악 매체 > 위키백과·AllMusic 같은 참고 자료.
PDF나 로그인이 필요한 페이지보다 일반 웹페이지를 고르세요.
제외 목록에 있는 URL은 다시 고르지 마세요.
신뢰도 순으로 최대 ${MAX_CANDIDATES}개를 고르세요.`,
    input: `검증 대상 주장:\n${list}\n\n제외할 URL:\n${excludeUrls.length ? excludeUrls.join('\n') : '없음'}`,
    text: { format: { type: 'json_schema', name: 'source_candidates', strict: true, schema: searchSchema } },
    max_output_tokens: 6000
  }, { timeout: SEARCH_TIMEOUT_MS });
  if (response.status !== 'completed') {
    throw fail(`웹 검색 AI 응답 미완료(${response.incomplete_details?.reason || response.status})`, 502);
  }
  // 실제 검색 도구가 반환한 URL 목록
  const discovered = new Map();
  for (const item of response.output || []) {
    if (item.type === 'web_search_call') {
      for (const source of item.action?.sources || []) {
        try { discovered.set(matchKey(source.url), { url: source.url, title: source.title || '' }); } catch { /* 제외 */ }
      }
    }
    for (const part of item.content || []) {
      for (const ann of part.annotations || []) {
        try {
          const key = matchKey(ann.url);
          if (!discovered.has(key)) discovered.set(key, { url: ann.url, title: ann.title || '' });
        } catch { /* 제외 */ }
      }
    }
  }
  let proposed = [];
  try {
    const raw = response.output_text || '';
    proposed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)).sources || [];
  } catch {
    console.warn('[출처 검색] 후보 JSON 해석 실패', (response.output_text || '').slice(0, 200));
  }
  const result = [];
  const add = (found, publisher) => {
    const key = matchKey(found.url);
    if (excluded.has(key) || result.some(item => matchKey(item.url) === key)) return;
    result.push({ url: canonicalUrl(found.url), publisher: publisher || new URL(found.url).hostname.replace(/^www\./, '') });
  };
  for (const candidate of proposed) {
    if (result.length >= MAX_CANDIDATES) break;
    try {
      const found = discovered.get(matchKey(candidate.url));
      if (found) add(found, candidate.publisher); // 검색 결과에 없는 URL은 쓰지 않습니다.
    } catch { /* 제외 */ }
  }
  // 모델 제안이 부족하면 실제 검색 결과로 보충합니다.
  // 사실 여부는 본문 판정과 인용문 대조에서 다시 걸러집니다.
  for (const found of discovered.values()) {
    if (result.length >= MAX_CANDIDATES) break;
    try { add(found); } catch { /* 제외 */ }
  }
  console.log('[출처 검색]', { 주장: claims.length, 모델제안: proposed.length, 검색결과: discovered.size, 후보: result.length });
  return result;
}

// ─────────────────────────────────────────────────────────────
// 사실 추출
// ─────────────────────────────────────────────────────────────
async function extractClaims(client, article) {
  const extracted = await structuredResponse(client, {
    name: 'article_claim_extraction', schema: claimSchema,
    instructions: `당신은 한국어 음악 기사의 팩트체크 담당자입니다. 원고에서 검증 대상 문장을 뽑아 분류하세요.

[분류 type]
- fact: 출처로 참·거짓을 확인할 수 있는 객관적 사실 (출신지, 직업, 결성 연도, 멤버, 발매일, 편성, 수상·후보, 횟수 등)
- interpretation: 음악사적 평가·영향처럼 출처로 '그렇게 평가된다'는 것을 확인할 수 있는 해석 (예: 개러지 록 리바이벌의 상징)
- opinion: 감상·비유·최상급 평론 표현처럼 객관적 확인이 불가능한 문장 (예: 가장 손맛 나는 록, 꽉 찬 소리)

[추출 규칙]
- 하나의 문장에 여러 사실이 있으면 독립적으로 검증 가능한 단위로 나누세요.
  예: '디트로이트 출신의 기타리스트이자 싱어송라이터' → 출신지 / 기타리스트 / 싱어송라이터.
  예: '2025년 그래미 후보, 솔로 34번째·통산 46번째 노미네이트' → 후보 지명 / 부문 / 솔로 횟수 / 통산 횟수.
- 사실과 평가가 한 문장에 섞이면 나누세요. 예: '베이스 없이 기타와 드럼만으로 꽉 찬 소리' → 편성(fact) / 꽉 찬 소리(opinion).
- 생략된 주어는 문맥으로 채워 claim을 완결된 문장으로 쓰세요. (예: '잭 화이트는 …')
- 기사 제목 자체, 원고 구성 등 기사에 대한 메타 정보는 추출하지 마세요.
  제목은 그 안에 객관적 주장이 담겨 있을 때만 field=title로 추출하세요.
- 원문에 없는 사실을 만들어내지 마세요.

[필드]
- excerpt: 원고에서 해당 부분을 그대로 복사 (수정·요약 금지)
- group: 같은 출처로 함께 확인될 가능성이 큰 주장끼리 같은 짧은 ID(G1, G2 …)를 주세요.
  같은 인물의 이력, 같은 밴드의 결성·편성, 같은 앨범의 정보처럼 묶고, 한 그룹은 6개 이하로 하세요.
- keywords: 출처 검색과 본문 대조에 쓸 핵심어. 영어권 대상은 영어 표기를 반드시 포함하세요.
  (인물·밴드·앨범·곡명의 원어 표기, 연도·숫자, 핵심 명사. 예: "Jack White", "Detroit", "1997", "Meg White")

opinion도 목록에 포함하되 짧게 쓰세요. 주요 사실을 우선해 최대 ${MAX_CLAIMS}개를 반환하세요.`,
    input: { article }
  });
  const unique = new Set();
  const claims = [];
  for (const item of extracted.claims || []) {
    if (!item.claim?.trim()) continue;
    const key = item.claim.replace(/\s+/g, '').toLowerCase();
    if (unique.has(key)) continue;
    unique.add(key);
    claims.push({
      claim: item.claim.trim(),
      field: item.field === 'title' ? 'title' : 'body',
      excerpt: item.excerpt || item.claim,
      type: CLAIM_TYPES.includes(item.type) ? item.type : 'fact',
      group: String(item.group || 'G1').trim().slice(0, 20) || 'G1',
      keywords: (item.keywords || []).map(k => String(k).trim()).filter(Boolean).slice(0, 12)
    });
  }
  return { claims: claims.slice(0, MAX_CLAIMS), truncated: claims.length > MAX_CLAIMS };
}

// ─────────────────────────────────────────────────────────────
// 인용문 대조
// AI는 의미를 판단하고, 코드는 인용 근거가 실제 본문에 있는지만 확인합니다.
// 공백·인용부호·구두점 차이는 허용하되, 출처에 없는 문장은 근거로 채택하지 않습니다.
// ─────────────────────────────────────────────────────────────
export function locateEvidence(sourceText, quotation) {
  const quote = String(quotation || '').normalize('NFKC').toLowerCase();
  const isWordChar = ch => /[\p{L}\p{N}]/u.test(ch);
  const normalizedQuote = [...quote].filter(isWordChar).join('');
  if (normalizedQuote.length < 8) return '';
  let normalizedText = '';
  const positions = [];
  let offset = 0;
  for (const ch of sourceText) {
    for (const unit of ch.normalize('NFKC').toLowerCase()) {
      if (isWordChar(unit)) {
        normalizedText += unit;
        positions.push(offset);
      }
    }
    offset += ch.length;
  }
  const at = normalizedText.indexOf(normalizedQuote);
  if (at < 0) return '';
  const start = positions[at];
  const end = positions[at + normalizedQuote.length - 1] + 2;
  return sourceText.slice(start, Math.min(end, sourceText.length)).trim();
}

// ─────────────────────────────────────────────────────────────
// 판정: 출처 1개 × 사실 여러 개를 한 번에
// ─────────────────────────────────────────────────────────────
const verdictInstructions = `당신은 음악 기사 편집실의 팩트체커입니다.
claims의 각 항목을 sourceText와 대조해 항목마다 따로 판정하세요.
articleContext는 생략된 주어, 인물, 작품, 연도를 파악하는 데만 사용합니다.
판정 근거는 오직 sourceText입니다. 사전 지식이나 원고 자체를 근거로 삼지 마세요.
표현이 달라도 의미가 같으면 같은 사실입니다. 한국어 주장과 영어 출처를 의미로 비교하세요.
예: guitarist / plays guitar → 기타리스트, born in Detroit / Detroit native → 디트로이트 출신, formed in 1997 → 1997년 결성.

VERIFIED: sourceText가 그 항목의 모든 객관적 요소(이름·연도·숫자·부문 등)를 분명히 뒷받침할 때만.
CONTRADICTED: sourceText가 그 항목과 직접 모순될 때만 (예: 다른 연도, 다른 숫자).
INSUFFICIENT: 언급이 없거나 일부만 확인될 때. 일부만 확인되면 reason에 확인된 부분과 안 된 부분을 나눠 쓰세요.
type이 interpretation인 항목은 출처가 같은 취지의 평가를 하고 있으면 VERIFIED입니다.
숫자·횟수·수상 기록은 숫자가 정확히 일치할 때만 VERIFIED입니다.

evidence: sourceText에서 그대로 복사한 연속 구절 1개 (원문 언어 그대로, 20~200자).
번역·의역·말줄임표·여러 곳을 이어 붙인 인용은 금지입니다. VERIFIED·CONTRADICTED인데 이런 구절이 없으면 INSUFFICIENT로 바꾸세요.
reason: 한국어로, 출처의 무엇을 근거로 판단했는지 구체적으로.
suggestion: CONTRADICTED이거나 원고 표현이 출처보다 과장된 경우에만, 원문 문체를 살린 최소 수정안을 쓰세요. 그 외에는 빈 문자열.
출처에 언급이 없다는 이유만으로 삭제를 권하지 마세요.
results에는 claims의 모든 id를 정확히 한 번씩 포함하세요.`;

async function judgeSource(client, claims, content, article) {
  const keywords = claims.flatMap(c => [...(c.keywords || []), ...c.claim.split(/\s+/)]);
  const result = await structuredResponse(client, {
    name: 'source_fact_verification_group', schema: groupVerdictSchema,
    instructions: verdictInstructions,
    input: {
      claims: claims.map(c => ({ id: c.id, type: c.type, claim: c.claim, excerpt: c.excerpt })),
      articleContext: `${article?.title || ''}\n${article?.body || ''}`.slice(0, 3500),
      sourceText: selectPassages(content, keywords)
    }
  });
  const byId = new Map();
  for (const item of result.results || []) if (!byId.has(item.id)) byId.set(item.id, item);
  return byId;
}

function newFact(item, id) {
  return {
    id, claim: item.claim, field: item.field || 'body', excerpt: item.excerpt || item.claim,
    type: CLAIM_TYPES.includes(item.type) ? item.type : 'fact',
    group: item.group || null, keywords: Array.isArray(item.keywords) ? item.keywords : [],
    verificationStatus: 'NOT CHECKED', source: null, sources: [], evidence: '',
    reason: '', suggestion: '', checkedAt: null, failureType: null
  };
}

// 평론적 표현은 웹 검색 없이 표시만 합니다. (사실 오류로 취급하지 않음)
function markOpinion(fact) {
  fact.verificationStatus = 'OPINION';
  fact.failureType = null;
  fact.reason = '평론적 표현입니다. 사실 검증 대상이 아니며, 표현의 적절성은 편집자가 판단합니다.';
  fact.checkedAt = new Date().toISOString();
  return fact;
}

/**
 * 같은 그룹의 주장들을 함께 검증합니다. 결과는 사실별로 따로 기록됩니다.
 * 호출 수: 웹 검색 1회 + 읽은 출처 수만큼 판정 1회 (최대 MAX_READ_SOURCES).
 */
async function verifyGroup(client, items, ids, excludeUrls = [], article = {}) {
  const facts = items.map((item, i) => newFact(item, ids[i]));
  const targets = facts.filter(f => f.type !== 'opinion');
  facts.filter(f => f.type === 'opinion').forEach(markOpinion);
  if (!targets.length) return facts;

  const tally = new Map(targets.map(f => [f.id, { supported: 0, contradicted: 0, insufficient: 0, notes: [] }]));
  let candidates = [];
  let searchError = '';
  let accessError = '';
  let readable = 0;
  try { candidates = await searchSources(client, targets, excludeUrls); }
  catch (error) { searchError = error.message; }

  for (const candidate of candidates) {
    const open = targets.filter(f => f.verificationStatus !== 'VERIFIED');
    if (!open.length || readable >= MAX_READ_SOURCES) break;
    let content;
    try {
      content = await pageText(candidate.url);
    } catch (error) {
      accessError = error.message;
      for (const fact of open) {
        fact.sources.push({ url: candidate.url, publisher: candidate.publisher, verificationStatus: 'NOT CHECKED',
          evidence: '', reason: `본문 접근 실패: ${error.message}`, failureType: 'SOURCE_ACCESS_FAILED' });
      }
      continue;
    }
    readable++;
    let verdicts;
    try { verdicts = await judgeSource(client, open, content, article); }
    catch (error) {
      for (const fact of open) {
        fact.sources.push({ url: candidate.url, publisher: candidate.publisher, verificationStatus: 'NOT CHECKED',
          evidence: '', reason: `판정 AI 오류: ${error.message}`, failureType: 'VERIFY_FAILED' });
      }
      continue;
    }
    for (const fact of open) {
      const verdict = verdicts.get(fact.id) || { verdict: 'INSUFFICIENT', reason: '판정 결과가 누락되었습니다.', evidence: '', suggestion: '' };
      const anchored = locateEvidence(content, verdict.evidence);
      const status = verdict.verdict !== 'INSUFFICIENT' && !anchored ? 'INSUFFICIENT' : verdict.verdict;
      const reason = !anchored && verdict.verdict !== 'INSUFFICIENT'
        ? `AI가 ${verdict.verdict === 'VERIFIED' ? '지지' : '반박'} 근거로 제시한 인용문을 실제 출처 본문에서 찾지 못해 근거 부족으로 처리했습니다. (AI 판단: ${verdict.reason})`
        : verdict.reason;
      fact.sources.push({ url: candidate.url, publisher: candidate.publisher, verificationStatus: status,
        evidence: anchored, reason, suggestion: verdict.suggestion || '' });
      const t = tally.get(fact.id);
      if (status === 'VERIFIED') {
        t.supported++;
        if (!fact.source) {
          fact.source = { url: candidate.url, publisher: candidate.publisher };
          fact.evidence = anchored;
          fact.reason = reason;
          fact.suggestion = verdict.suggestion || '';
        }
        fact.verificationStatus = 'VERIFIED';
      } else if (status === 'CONTRADICTED') t.contradicted++;
      else t.insufficient++;
    }
  }

  // 사실별 최종 상태 정리
  const now = new Date().toISOString();
  for (const fact of targets) {
    const t = tally.get(fact.id);
    fact.checkedAt = now;
    const readSources = fact.sources.filter(s => !s.failureType);
    if (t.supported && t.contradicted) {
      fact.verificationStatus = 'INSUFFICIENT';
      fact.failureType = 'CONFLICTING_EVIDENCE';
      fact.reason = '출처 사이에 내용이 엇갈립니다. ' + readSources.map(s => `${s.publisher}: ${s.reason}`).join(' / ');
      fact.suggestion = '엇갈리는 출처를 직접 비교해 확정해 주세요.';
    } else if (t.supported) {
      fact.failureType = null;
    } else if (t.contradicted) {
      const against = readSources.find(s => s.verificationStatus === 'CONTRADICTED');
      fact.verificationStatus = 'CONTRADICTED';
      fact.failureType = 'SOURCE_CONTRADICTS';
      fact.source = { url: against.url, publisher: against.publisher };
      fact.evidence = against.evidence;
      fact.reason = against.reason;
      fact.suggestion = against.suggestion || '출처와 원고를 대조해 수정 여부를 판단해 주세요.';
    } else if (readSources.length) {
      fact.verificationStatus = 'INSUFFICIENT';
      fact.failureType = 'EVIDENCE_INSUFFICIENT';
      fact.reason = readSources.map(s => `${s.publisher}: ${s.reason}`).join(' / ');
      fact.suggestion = '이 출처들에는 직접 근거가 없습니다. 출처 재검색을 하거나 원출처를 직접 확인해 주세요.';
    } else if (fact.sources.length) {
      fact.verificationStatus = 'NOT CHECKED';
      fact.failureType = 'SOURCE_ACCESS_FAILED';
      fact.reason = `출처 ${fact.sources.length}개를 찾았지만 본문을 읽지 못했습니다. (${accessError})`;
      fact.suggestion = '출처 링크를 브라우저에서 직접 확인하거나 재검색해 주세요.';
    } else {
      fact.verificationStatus = 'NOT CHECKED';
      fact.failureType = 'SEARCH_FAILED';
      fact.reason = `웹 검색에서 출처 후보를 확보하지 못했습니다.${searchError ? ` (${searchError})` : ''}`;
      fact.suggestion = '출처 재검색을 시도해 주세요. 검색 실패는 사실이 틀렸다는 뜻이 아닙니다.';
    }
  }
  return facts;
}

// ─────────────────────────────────────────────────────────────
// 공개 함수
// ─────────────────────────────────────────────────────────────
export async function extractFactClaims(client, article) {
  return extractClaims(client, article);
}

/**
 * options.claims + options.ids : 그룹 검증 (편집실 단계별 조사)
 * options.claim + options.id   : 단일 주장 검증 (개별 재검색, 기존 호환)
 * 옵션이 없으면 원고 전체를 추출해 그룹별로 검증합니다.
 */
export async function buildFactSheet(client, article, options = {}) {
  const excludeUrls = options.excludeUrls || [];
  let facts = [];
  let truncated = false;
  if (Array.isArray(options.claims) && options.claims.length) {
    const ids = options.ids || options.claims.map((_, i) => `F${String(i + 1).padStart(3, '0')}`);
    facts = await verifyGroup(client, options.claims, ids, excludeUrls, article);
  } else if (options.claim && typeof options.claim.claim === 'string') {
    facts = await verifyGroup(client, [options.claim], [options.id || 'F001'], excludeUrls, article);
  } else {
    const extracted = await extractClaims(client, article);
    if (!extracted.claims.length) throw fail('검증할 사실 주장을 추출하지 못했습니다.');
    truncated = extracted.truncated;
    const ids = extracted.claims.map((_, i) => `F${String(i + 1).padStart(3, '0')}`);
    const groups = new Map();
    extracted.claims.forEach((claim, i) => {
      if (!groups.has(claim.group)) groups.set(claim.group, { claims: [], ids: [] });
      groups.get(claim.group).claims.push(claim);
      groups.get(claim.group).ids.push(ids[i]);
    });
    const byId = new Map();
    for (const group of groups.values()) {
      for (const fact of await verifyGroup(client, group.claims, group.ids, excludeUrls, article)) byId.set(fact.id, fact);
    }
    facts = ids.map(id => byId.get(id));
  }
  return {
    artist: { name: '기사 기반 자료' }, facts, truncated,
    generatedAt: new Date().toISOString(),
    note: '웹 검색으로 찾은 출처 본문을 대조한 자동 검증 결과입니다. 웹 전체를 조사한 것은 아니며 편집자의 원출처 확인이 필요합니다.'
  };
}
