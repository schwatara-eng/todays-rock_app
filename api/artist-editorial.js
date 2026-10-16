/**
 * TODAY'S ROCK — AI 편집 검토 API
 *
 * 사실 검수와 독립적으로 문장과 구성만 평가합니다.
 * AI는 원고를 수정하지 않고 최대 5개의 개선 의견만 반환합니다.
 *
 * 핵심 개선:
 * - 편집 검토에만 추론 강도(low)를 적용해 출력 토큰 소모를 줄입니다.
 * - 최대 출력 토큰을 명시하고, 미완료 원인을 서버 로그에 기록합니다.
 * - 기존 관리자 화면의 응답 형식을 유지합니다.
 */
import { authorize, getClient, handleError } from './_lib/artist-common.js';

// 기존 화면이 사용하는 이슈 구조를 그대로 유지합니다.
const editorialSchema = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['title', 'body'] },
          category: {
            type: 'string',
            enum: ['structure', 'readability', 'repetition', 'style', 'title']
          },
          text: { type: 'string' },
          reason: { type: 'string' },
          suggestion: { type: 'string' }
        },
        required: ['field', 'category', 'text', 'reason', 'suggestion'],
        additionalProperties: false
      }
    }
  },
  required: ['issues'],
  additionalProperties: false
};

const instructions = `당신은 TODAY'S ROCK의 한국어 음악 기사 편집자입니다.
기사의 구성, 문단 연결, 가독성, 중복, 제목, 한글·영문 표기만 평가하세요.
사실 검증은 별도 API가 담당합니다. 새 사실·연도·인물·앨범·평가를 만들지 마세요.
가장 중요한 개선점만 최대 5개 제시하세요. 문제가 없으면 issues를 빈 배열로 반환하세요.
각 문제의 text는 원문 중 짧은 부분(100자 이내)으로, reason과 suggestion은 각각 120자 이내로 작성하세요.
전체 기사 재작성은 하지 마세요. 수정 의견만 간결하게 제시하세요.
모든 검수 의견, 사유, 수정 권고는 자연스러운 한국어로 작성하세요.
뮤지션명, 밴드명, 앨범명, 곡명은 원어 표기를 유지하세요.
기사 원문을 인용하는 text 필드는 번역하거나 수정하지 마세요.`;

export default async function handler(req, res) {
  if (!authorize(req, res)) return;

  try {
    const article = req.body?.article;
    const valid = article &&
      typeof article.title === 'string' && article.title.trim().length > 0 && article.title.length <= 300 &&
      typeof article.body === 'string' && article.body.trim().length > 0 && article.body.length <= 15000;

    if (!valid) {
      return res.status(400).json({ error: '기사 제목 또는 본문을 확인하세요.' });
    }

    const started = Date.now();
    console.log('[편집 검토] 요청 시작:', { bodyLength: article.body.length });

    // 공통 structuredResponse()를 호출하지 않습니다.
    // 편집 검토에만 reasoning.effort를 적용하기 위해 독립적으로 호출합니다.
    const client = getClient();
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || 'gpt-5-mini',
      reasoning: { effort: 'low' },
      instructions,
      input: JSON.stringify({
        article: { title: article.title, body: article.body }
      }),
      max_output_tokens: 6500,
      text: {
        format: {
          type: 'json_schema',
          name: 'artist_editorial_review',
          strict: true,
          schema: editorialSchema
        }
      }
    });

    // 'incomplete'는 일반적인 연결 오류와 다릅니다.
    // 원인을 별도로 기록해야 토큰 한도 문제인지 판단할 수 있습니다.
    if (response.status !== 'completed' || !response.output_text?.trim()) {
      const reason = response.incomplete_details?.reason || response.status || 'unknown';
      console.error('[편집 검토] AI 응답 미완료:', {
        status: response.status,
        reason,
        outputTokens: response.usage?.output_tokens ?? null,
        elapsedSeconds: ((Date.now() - started) / 1000).toFixed(1)
      });
      return res.status(502).json({
        error: '편집 검토 AI 응답이 완료되지 않았습니다.',
        reason
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(response.output_text);
    } catch {
      console.error('[편집 검토] AI JSON 해석 실패');
      return res.status(502).json({ error: '편집 검토 결과를 해석하지 못했습니다.' });
    }

    if (!Array.isArray(parsed.issues)) {
      return res.status(502).json({ error: '편집 검토 결과 형식이 올바르지 않습니다.' });
    }

    console.log('[편집 검토] 완료:', {
      issues: parsed.issues.length,
      elapsedSeconds: ((Date.now() - started) / 1000).toFixed(1)
    });

    return res.status(200).json({
      success: true,
      review: {
        type: 'editorial',
        issues: parsed.issues.slice(0, 5),
        approved: false,
        note: 'AI 편집 의견입니다. 사실 검수 및 편집자 승인을 대체하지 않습니다.'
      }
    });
  } catch (error) {
    console.error('[편집 검토] 요청 실패:', {
      message: error?.message,
      code: error?.code,
      status: error?.status
    });
    handleError(res, error);
  }
}
