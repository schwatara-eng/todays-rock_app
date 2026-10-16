import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';

export function authorize(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'POST 요청만 허용합니다.' });
    return false;
  }
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.status(503).json({ error: '관리자 인증이 설정되지 않았습니다.' });
    return false;
  }
  const supplied = req.headers['x-admin-secret'];
  if (typeof supplied !== 'string') {
    res.status(401).json({ error: '관리자 인증이 필요합니다.' });
    return false;
  }
  const a = Buffer.from(secret);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: '관리자 인증에 실패했습니다.' });
    return false;
  }
  return true;
}

export function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error('OpenAI API 키가 설정되지 않았습니다.');
    err.httpStatus = 503;
    throw err;
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000, maxRetries: 1 });
}

export async function loadFactSheet() {
  const file = path.join(process.cwd(), 'facts', 'jack-white.json');
  const factSheet = JSON.parse(await readFile(file, 'utf8'));
  if (!factSheet?.artist?.name || !Array.isArray(factSheet.facts)) {
    const err = new Error('Fact Sheet 형식이 올바르지 않습니다.');
    err.httpStatus = 422;
    throw err;
  }
  const facts = factSheet.facts.filter(f =>
    f.verificationStatus === 'verified' &&
    typeof f.claim === 'string' && f.claim.trim() &&
    typeof f.id === 'string' &&
    typeof f.source?.url === 'string' && /^https:\/\//.test(f.source.url)
  );
  if (!facts.length) {
    const err = new Error('출처 URL이 있는 검증 완료 사실이 없습니다.');
    err.httpStatus = 422;
    throw err;
  }
  return { factSheet, facts };
}

export async function structuredResponse(client, { instructions, input, name, schema }) {
  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-5-mini',
    instructions,
    input: JSON.stringify(input),
    max_output_tokens: 2500,
    text: { format: { type: 'json_schema', name, strict: true, schema } }
  });
  if (response.status !== 'completed' || !response.output_text?.trim()) {
    const err = new Error('AI 응답이 완료되지 않았습니다.');
    err.httpStatus = 502;
    err.reason = response.incomplete_details?.reason || response.status;
    throw err;
  }
  try { return JSON.parse(response.output_text); }
  catch {
    const err = new Error('AI 응답 JSON을 해석하지 못했습니다.');
    err.httpStatus = 502;
    throw err;
  }
}

export async function generateArticle(client, factSheet, facts) {
  const article = await structuredResponse(client, {
    name: 'artist_article',
    instructions: `당신은 TODAY'S ROCK의 음악 전문 에디터입니다. 한국어로 제목과 본문을 작성하세요.
facts 배열의 claim에 명시된 사실만 사용하세요. source는 출처 확인용이며 evidence에만 있는 새 사실을 추가하지 마세요.
자료는 전체 활동 이력이 아닐 수 있습니다. 두 밴드뿐, 유일한, 최초, 전부 등 완결·배타 표현을 근거 없이 쓰지 마세요.
사실이 적으면 짧게 작성하고, 근거 없는 날짜·수상·평가·추측을 넣지 마세요. 제목도 동일한 기준을 지키세요.
반환 JSON에는 제목과 본문만 넣고 '편집자 검토 필요' 같은 메타 문구는 넣지 마세요.`,
    input: { artist: factSheet.artist, facts },
    schema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title', 'body'], additionalProperties: false
    }
  });
  if (!article.title?.trim() || !article.body?.trim()) throw Object.assign(new Error('빈 기사 초안입니다.'), { httpStatus: 502 });
  return {
    id: 'jack-white', artist: factSheet.artist,
    title: article.title.trim(), body: article.body.trim(),
    factIds: facts.map(f => f.id), status: 'draft', reviewed: false
  };
}

export async function reviewArticle(client, article, facts) {
  const result = await structuredResponse(client, {
    name: 'artist_review',
    instructions: `당신은 음악 기사 사실 검수자입니다. 기사 제목과 본문의 주장들을 검증된 facts.claim과 대조하세요.
개별 사실이 맞아도 '두 밴드', '유일한', '최초', '전부' 등 전체 활동을 한정하는 암시는 별도 근거가 없으면 misleading으로 표시하세요.
source.evidence는 claim에 없는 사실을 정당화하지 않습니다. source URL의 실제 페이지를 읽었다고 주장하지 마세요.
문제 표현마다 field(title 또는 body), text, verdict(unsupported/misleading/needs_review), reason, suggestion, factIds를 기입하세요.
명확한 문제가 없으면 issues는 빈 배열로 반환하세요. 이 검토는 AI 보조 검수이며 사람의 승인과 독립적 출처 확인을 대체하지 않습니다.`,
    input: { article: { title: article.title, body: article.body }, facts },
    schema: {
      type: 'object',
      properties: {
        issues: {
          type: 'array', items: {
            type: 'object',
            properties: {
              field: { type: 'string', enum: ['title', 'body'] },
              text: { type: 'string' },
              verdict: { type: 'string', enum: ['unsupported', 'misleading', 'needs_review'] },
              reason: { type: 'string' },
              suggestion: { type: 'string' },
              factIds: { type: 'array', items: { type: 'string' } }
            },
            required: ['field', 'text', 'verdict', 'reason', 'suggestion', 'factIds'],
            additionalProperties: false
          }
        }
      },
      required: ['issues'], additionalProperties: false
    }
  });
  return {
    articleId: article.id || 'jack-white',
    status: 'needs_review',
    issues: result.issues,
    approved: false,
    note: 'AI 보조 검수 결과입니다. 문제가 없어도 편집자 승인 전 게시할 수 없습니다.'
  };
}

export function handleError(res, err) {
  console.error('Artist API error:', err?.message, err?.status || '', err?.code || '');
  const status = err.httpStatus || (err.status === 429 ? 429 : err.status === 401 ? 502 : 500);
  const safeMessage = err.httpStatus ? err.message : status === 429 ? 'AI 요청 한도에 도달했습니다.' : '기사 처리 중 오류가 발생했습니다. 서버 로그를 확인하세요.';
  res.status(status).json({ error: safeMessage, ...(err.reason ? { reason: err.reason } : {}) });
}
