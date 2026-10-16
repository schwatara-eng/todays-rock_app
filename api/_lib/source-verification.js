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
        callback(null, item.address, item.family);
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

async function searchSources(client, claim) {
  const response = await client.responses.create({
    model: model(), reasoning: { effort: 'low' },
    tools: [{ type: 'web_search', search_context_size: 'medium' }],
    include: ['web_search_call.action.sources'],
    tool_choice: 'required',
    instructions: `음악 기사 팩트체크를 위한 출처 조사자입니다. 웹 검색을 수행하세요.
공식 뮤지션·음반사·공식 시상식·공신력 있는 언론을 우선합니다.
검색 결과에서 실제 발견한 HTTPS URL만 최대 3개 반환하세요. URL을 만들어내지 마세요.
응답은 JSON 객체만: {"sources":[{"url":"...","publisher":"...","reason":"..."}]}`,
    input: `검증할 주장: ${claim}`,
    max_output_tokens: 2500
  });
  if (response.status !== 'completed' || !response.output_text) throw fail('웹 출처 조사 AI 응답 미완료', 502);
  let parsed;
  try { parsed = JSON.parse(response.output_text.replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { throw fail('웹 출처 조사 응답을 해석할 수 없습니다.', 502); }
  // 검색 결과에 실제 노출된 URL만 허용: 모델의 자유 생성 URL 차단.
  const discovered = new Set();
  for (const item of response.output || []) {
    if (item.type === 'web_search_call') {
      for (const source of item.action?.sources || []) if (source.url) discovered.add(source.url);
    }
    for (const part of item.content || []) {
      for (const ann of part.annotations || []) if (ann.url) discovered.add(ann.url);
    }
  }
  return (parsed.sources || []).filter(s => {
    try { checkUrl(s.url); return discovered.has(s.url); } catch { return false; }
  }).slice(0, 3);
}

export async function buildFactSheet(client, article) {
  const extracted = await structuredResponse(client, {
    name: 'article_claim_extraction', schema: claimSchema,
    instructions: `한국어 음악 기사 제목과 본문에서 외부 출처로 확인 가능한 구체적 사실 주장만 추출하세요.
인물, 날짜, 앨범, 수상, 발언, 비교, 최초·유일 등의 주장을 포함합니다.
감상과 의견은 제외합니다. 원문 위치를 excerpt로 기록합니다. 최대 12개, 빠뜨리지 말고 우선순위를 정하세요.`,
    input: { article }
  });
  const claims = extracted.claims.slice(0, 5);
  const truncated = extracted.claims.length > claims.length;
  if (!claims.length) throw fail('검증할 사실 주장을 추출하지 못했습니다.');
  const facts = [];
  for (let i = 0; i < claims.length; i++) {
    const item = claims[i];
    const fact = {
      id: `F${String(i + 1).padStart(3, '0')}`, claim: item.claim,
      field: item.field, excerpt: item.excerpt, verificationStatus: 'NOT CHECKED',
      source: null, evidence: '', reason: '', suggestion: '', checkedAt: null
    };
    let candidates = [];
    try { candidates = await searchSources(client, item.claim); }
    catch (error) { fact.reason = `검색 실패: ${error.message}`; }
    for (const candidate of candidates) {
      try {
        const content = await pageText(candidate.url);
        const verdict = await structuredResponse(client, {
          name: 'source_fact_verification', schema: verdictSchema,
          instructions: `당신은 원고 작성 및 검색 AI와 독립적인 팩트 검수자입니다.
반드시 제공된 sourceText 안에 실제로 적힌 내용만 사용해 판정하세요.
VERIFIED는 제공된 텍스트가 주장의 모든 요소를 직접 지지할 때만 사용합니다.
충돌하면 CONTRADICTED, 명시적 근거가 없으면 INSUFFICIENT입니다.
evidence에는 제공된 텍스트에서 직접 찾을 수 있는 짧은 원문 인용만 넣으세요.
검색 요약, 일반 지식, 추측으로 VERIFIED를 반환하지 마세요.`,
          input: { claim: item.claim, sourceText: content }
        });
        // AI가 만든 인용이 실제 수집된 본문에 없으면 검증 성공으로 인정하지 않습니다.
        const quote = verdict.evidence.trim().replace(/\s+/g, ' ');
        const quoteExists = quote.length >= 12 && content.includes(quote);
        const status = verdict.verdict === 'VERIFIED' && !quoteExists ? 'INSUFFICIENT' : verdict.verdict;
        fact.sources ??= [];
        fact.sources.push({ url: candidate.url, publisher: candidate.publisher,
          verificationStatus: status, evidence: quoteExists ? quote : '', reason: verdict.reason });
        if (status === 'VERIFIED' || status === 'CONTRADICTED') {
          fact.verificationStatus = status;
          fact.source = { url: candidate.url, publisher: candidate.publisher };
          fact.evidence = quoteExists ? quote : '';
          fact.reason = verdict.reason;
          fact.suggestion = verdict.suggestion;
          fact.checkedAt = new Date().toISOString();
          break;
        }
        fact.verificationStatus = 'INSUFFICIENT';
        fact.reason = verdict.reason;
        fact.suggestion = verdict.suggestion;
      } catch (error) { fact.reason = `페이지 확인 실패: ${error.message}`; }
    }
    facts.push(fact);
  }
  return { artist: { name: '기사 기반 자료' }, facts, truncated,
    generatedAt: new Date().toISOString(), note: '자동 검증 결과입니다. 편집자 원출처 확인 필요.' };
}
