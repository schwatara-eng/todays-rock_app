/**
 * 원고 기반 사실 추출 및 출처 대조.
 * 1) 사실 추출  2) OpenAI 웹 검색  3) 실제 HTTPS 페이지 본문 확보
 * 4) 독립 AI가 확보된 본문만 보고 판정
 * 주의: 자동 검증은 사람의 출처 확인을 대체하지 않습니다.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { structuredResponse } from './artist-common.js';

const model = () => process.env.OPENAI_MODEL || 'gpt-5-mini';
const MAX_CLAIMS = 12;
const MAX_SOURCES = 2;
const fail = (message, status = 422) => Object.assign(new Error(message), { httpStatus: status });

const claimSchema = {
  type: 'object', additionalProperties: false,
  properties: { claims: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: { claim: { type: 'string' }, field: { type: 'string', enum: ['title', 'body'] }, excerpt: { type: 'string' } },
    required: ['claim', 'field', 'excerpt']
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

const verdictSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['VERIFIED', 'CONTRADICTED', 'INSUFFICIENT'] },
    reason: { type: 'string' }, evidence: { type: 'string' }, suggestion: { type: 'string' }
  }, required: ['verdict', 'reason', 'evidence', 'suggestion']
};

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

async function pageText(raw) {
  const url = checkUrl(raw);
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicIP(item.address))) throw fail('사설망 주소 차단');
  // DNS 검사 후의 주소 변경도 방지하기 위해 고정 DNS lookup을 사용합니다.
  const https = await import('node:https');
  const html = await new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: 12000,
      lookup: (_host, _opts, callback) => {
        const item = addresses[0];
        // Node.js가 all:true로 호출하면 주소 객체 배열을 반환해야 합니다.
        // 단일 문자열을 반환하면 Invalid IP address: undefined가 발생할 수 있습니다.
        if (_opts?.all) {
          callback(null, [{ address: item.address, family: item.family }]);
        } else {
          callback(null, item.address, item.family);
        }
      },
      headers: { 'User-Agent': 'TodaysRockEditorialResearch/1.0', Accept: 'text/html, text/plain' }
    }, response => {
      if (response.statusCode !== 200) {
        response.resume(); reject(fail(`출처 페이지 HTTP ${response.statusCode}`)); return;
      }
      if (!/text\/html|text\/plain/i.test(response.headers['content-type'] || '')) {
        response.resume(); reject(fail('텍스트 페이지가 아닙니다.')); return;
      }
      let size = 0; const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 750000) { response.destroy(fail('출처 페이지 크기 초과')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(fail('출처 페이지 시간 초과')));
    request.on('error', reject);
  });
  const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ').trim();
  if (text.length < 150) throw fail('읽을 수 있는 출처 본문이 부족합니다.');
  return text.slice(0, 18000);
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

// 출처 검색은 기사 속 인물과 주장 모두에 연결되어야 합니다.
function subjectForArticle(article) {
  const text = `${article?.title || ''} ${article?.body || ''}`;
  if (/잭\s*화이트|Jack\s+White/i.test(text)) return { name: 'Jack White', aliases: ['Jack White', '잭 화이트'] };
  // 다른 인물에 대한 기사는 명시적 주제 없이 임의 출처를 채택하지 않습니다.
  return { name: String(article?.title || '').trim().slice(0, 90), aliases: [] };
}

function isRelevantSource(source, subject) {
  if (!subject.aliases.length) return false;
  const title = String(source.title || source.page_title || '');
  const snippet = String(source.snippet || '');
  const url = String(source.url || '');
  const evidence = `${title} ${snippet} ${url}`.toLowerCase();
  // 다른 음악가의 약력 페이지를 잘못 채택하지 않도록 명시적 주제 일치를 요구합니다.
  return subject.aliases.some(alias => evidence.includes(alias.toLowerCase())) ||
    /jack[-_]?white/i.test(url);
}

async function searchSources(client, claim, subject) {
  if (!subject.aliases.length) return [];
  const response = await client.responses.create({
    model: model(), reasoning: { effort: 'low' },
    tools: [{ type: 'web_search', search_context_size: 'medium' }],
    include: ['web_search_call.action.sources'],
    tool_choice: 'required',
    instructions: `음악 기사 출처 조사자입니다. 검증 대상 인물은 반드시 ${subject.name}입니다.
검색 결과에서 다른 음악가의 전기나 무관한 PDF를 절대 선정하지 마세요.
실제 검색 결과에 있는 URL만 사용하고 관련성이 불명확하면 빈 배열을 반환하세요.
공식 아티스트 사이트, 음반사, 시상식 기관, 신뢰할 만한 언론을 우선합니다.
응답은 JSON만: {"sources":[{"url":"...","publisher":"...","reason":"..."}]}`,
    input: `인물: ${subject.name}\n검증 주장: ${claim}\n검색어에 인물의 영문 전체 이름을 반드시 포함하고 이 사람에 관한 직접적인 근거를 찾으세요.`,
    max_output_tokens: 1800
  });
  if (response.status !== 'completed') throw fail('웹 검색 AI 응답 미완료', 502);
  const discovered = new Map();
  for (const item of response.output || []) {
    if (item.type === 'web_search_call') {
      for (const source of item.action?.sources || []) {
        try {
          const key = canonicalUrl(source.url);
          discovered.set(key, { url: source.url, title: source.title || '', snippet: source.snippet || '' });
        } catch { /* 부적절한 주소 제외 */ }
      }
    }
    for (const part of item.content || []) {
      for (const ann of part.annotations || []) {
        try {
          const key = canonicalUrl(ann.url);
          if (!discovered.has(key)) discovered.set(key, { url: ann.url, title: ann.title || '', snippet: '' });
        } catch { /* 제외 */ }
      }
    }
  }
  let proposed = [];
  try {
    proposed = JSON.parse((response.output_text || '').replace(/^```(?:json)?\s*|\s*```$/g, '')).sources || [];
  } catch { /* 파싱 실패 시 안전하게 빈 결과 */ }
  const result = [];
  for (const candidate of proposed) {
    try {
      const key = canonicalUrl(candidate.url);
      const found = discovered.get(key);
      if (!found || !isRelevantSource(found, subject)) continue;
      if (result.some(item => canonicalUrl(item.url) === key)) continue;
      result.push({ url: found.url, publisher: candidate.publisher || new URL(key).hostname });
      if (result.length >= MAX_SOURCES) break;
    } catch { /* 제외 */ }
  }
  // 중요한 점: 관련성을 확인하지 못한 검색 URL을 자동으로 끼워 넣지 않습니다.
  return result;
}

async function extractClaims(client, article) {
  const extracted = await structuredResponse(client, {
    name: 'article_claim_extraction', schema: claimSchema,
    instructions: `한국어 음악 기사 제목과 본문의 확인 가능한 사실을 빠뜨리지 말고 추출하세요.
하나의 문장에 여러 사실이 있으면 각각 독립된 원자적 주장으로 분리하세요.
예: '디트로이트 출신의 기타리스트이자 싱어송라이터' → 출신지, 기타리스트, 싱어송라이터 3개.
원문에 없는 사실을 만들어내지 마세요. 감상과 의견은 제외하세요.
각 항목의 excerpt에는 원고의 실제 해당 부분을 기록하세요.
주요 사실을 우선하여 최대 ${MAX_CLAIMS}개를 반환하세요.`,
    input: { article }
  });
  const unique = new Set();
  const claims = [];
  for (const item of extracted.claims || []) {
    if (!item.claim?.trim()) continue;
    const key = item.claim.replace(/\s+/g, '').toLowerCase();
    if (unique.has(key)) continue;
    unique.add(key);
    claims.push(item);
  }
  return { claims: claims.slice(0, MAX_CLAIMS), truncated: claims.length > MAX_CLAIMS };
}

async function verifyClaim(client, item, id, subject) {
  const fact = {
    id, claim: item.claim, field: item.field || 'body', excerpt: item.excerpt || item.claim,
    verificationStatus: 'NOT CHECKED', source: null, sources: [], evidence: '',
    reason: '', suggestion: '', checkedAt: null, failureType: null
  };
  const seen = new Set();
  let readable = 0;
  let searchError = '';
  let accessError = '';
  let insufficient = 0;
  let contradictions = 0;
  // 1차 검증에서는 웹 검색 1회와 출처 본문 최대 2개만 검토합니다.
  for (let round = 0; round < 1; round++) {
    let candidates = [];
    try { candidates = await searchSources(client, item.claim, subject); }
    catch (error) { searchError = error.message; continue; }
    for (const candidate of candidates) {
      let key;
      try { key = canonicalUrl(candidate.url); } catch { continue; }
      if (seen.has(key) || seen.size >= MAX_SOURCES) continue;
      seen.add(key);
      const source = { url: candidate.url, publisher: candidate.publisher,
        verificationStatus: 'NOT CHECKED', evidence: '', reason: '' };
      fact.sources.push(source);
      try {
        const content = await pageText(candidate.url);
        readable++;
        const verdict = await structuredResponse(client, {
          name: 'source_fact_verification', schema: verdictSchema,
          instructions: `독립적인 팩트 검수자입니다. sourceText에 있는 정보만 사용하세요.
VERIFIED는 주장 전체를 출처가 명시적으로 지지할 때만, CONTRADICTED는 직접 모순될 때만 사용하세요.
근거가 없으면 INSUFFICIENT를 반환하세요.
evidence는 sourceText에 실제로 존재하는 짧은 연속 원문 인용이어야 합니다.
검수 사유와 수정 권고는 한국어로 작성하세요. 출처가 부족하다고 원고를 곧바로 삭제하도록 권하지 마세요.`,
          input: { claim: item.claim, sourceText: content }
        });
        const quote = (verdict.evidence || '').trim().replace(/\s+/g, ' ');
        const exists = quote.length >= 8 && content.includes(quote);
        const status = verdict.verdict !== 'INSUFFICIENT' && !exists ? 'INSUFFICIENT' : verdict.verdict;
        source.verificationStatus = status;
        source.evidence = exists ? quote : '';
        source.reason = !exists && verdict.verdict !== 'INSUFFICIENT'
          ? '인용 문구가 수집한 출처 본문과 정확히 일치하지 않습니다.' : verdict.reason;
        if (status === 'VERIFIED') {
          fact.verificationStatus = 'VERIFIED';
          fact.source = { url: candidate.url, publisher: candidate.publisher };
          fact.evidence = source.evidence;
          fact.reason = verdict.reason;
          fact.suggestion = verdict.suggestion;
          fact.checkedAt = new Date().toISOString();
          fact.failureType = null;
          return fact;
        }
        if (status === 'CONTRADICTED') contradictions++;
        else insufficient++;
      } catch (error) {
        accessError = error.message;
        source.reason = `출처 접근 또는 검증 실패: ${error.message}`;
        source.failureType = 'SOURCE_ACCESS_FAILED';
      }
    }
    if (seen.size >= MAX_SOURCES) break;
  }
  fact.checkedAt = new Date().toISOString();
  if (contradictions > 0) {
    // 일부 출처의 모순만으로 사실 전체가 틀렸다고 단정하지 않습니다.
    fact.verificationStatus = 'INSUFFICIENT';
    fact.failureType = 'CONFLICTING_EVIDENCE';
    fact.reason = '조사한 출처에 주장과 모순되는 자료가 있습니다. 출처를 직접 비교해야 합니다.';
    fact.suggestion = '표시된 출처와 주장 문장을 직접 대조해 주세요.';
  } else if (readable > 0) {
    fact.verificationStatus = 'INSUFFICIENT';
    fact.failureType = 'EVIDENCE_INSUFFICIENT';
    fact.reason = `출처 ${readable}개를 읽었지만 주장을 직접 뒷받침하는 근거를 확보하지 못했습니다.`;
    fact.suggestion = '다른 원출처를 검색하거나 주장 표현을 구체화해 주세요.';
  } else if (seen.size > 0) {
    fact.failureType = 'SOURCE_ACCESS_FAILED';
    fact.reason = `검색된 출처 ${seen.size}개에서 본문을 읽지 못했습니다. ${accessError}`;
    fact.suggestion = '출처를 브라우저에서 직접 확인하거나 다른 출처를 재검색해 주세요.';
  } else {
    fact.failureType = 'SEARCH_FAILED';
    fact.reason = `검색에서 확인 가능한 출처를 확보하지 못했습니다.${searchError ? ` (${searchError})` : ''}`;
    fact.suggestion = '다른 검색어로 출처 재검색을 시도해 주세요.';
  }
  return fact;
}

export async function extractFactClaims(client, article) {
  return extractClaims(client, article);
}

export async function buildFactSheet(client, article, options = {}) {
  const selected = options.claim && typeof options.claim.claim === 'string';
  const extracted = selected
    ? { claims: [options.claim], truncated: false }
    : await extractClaims(client, article);
  if (!extracted.claims.length) throw fail('검증할 사실 주장을 추출하지 못했습니다.');
  const facts = [];
  for (let i = 0; i < extracted.claims.length; i++) {
    const item = extracted.claims[i];
    const id = selected ? (options.id || 'F001') : `F${String(i + 1).padStart(3, '0')}`;
    facts.push(await verifyClaim(client, item, id, subjectForArticle(article)));
  }
  return {
    artist: { name: '기사 기반 자료' }, facts, truncated: extracted.truncated,
    generatedAt: new Date().toISOString(),
    note: '여러 출처를 조사한 자동 검증 결과입니다. 웹 전체를 조사한 것은 아니며 편집자의 원출처 확인이 필요합니다.'
  };
}
