/**
 * 원고의 사실 검수 API
 *
 * 1) issues: 팩트시트 상태로 '기계적으로' 만듭니다. 승인 차단 여부는 이 목록으로만 결정합니다.
 *    평론적 표현(OPINION)은 사실 오류가 아니므로 차단 항목에 넣지 않습니다.
 * 2) report: 편집자용 검수 보고서(표·전체 의견·수정 제안). AI가 문장을 쓰지만,
 *    각 행의 판정 라벨은 코드가 팩트시트 상태로 정하므로 AI가 확인된 사실을 뒤집을 수 없습니다.
 *    보고서 생성에 실패해도 issues는 그대로 반환합니다.
 */
import { authorize, getClient, handleError, structuredResponse } from './_lib/artist-common.js';

const reportSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    overall: { type: 'string' },
    rows: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        text: { type: 'string' },
        factIds: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
        needsWording: { type: 'boolean' }
      }, required: ['text', 'factIds', 'note', 'needsWording']
    } },
    corrections: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: {
        field: { type: 'string', enum: ['title', 'body'] },
        text: { type: 'string' },
        problem: { type: 'string' },
        suggestion: { type: 'string' },
        factIds: { type: 'array', items: { type: 'string' } }
      }, required: ['field', 'text', 'problem', 'suggestion', 'factIds']
    } }
  }, required: ['overall', 'rows', 'corrections']
};

const reportInstructions = `당신은 음악 기사 편집실의 데스크입니다. 팩트체크 결과(facts)를 바탕으로 편집자용 검수 보고서를 씁니다.
새로 사실을 조사하거나 사전 지식으로 판단하지 마세요. facts의 판정(verificationStatus), 근거(evidence), 사유(reason)만 사용하세요.

rows: 원고 흐름 순서대로, 원고의 주장 단위 표를 만드세요.
- text: 원고의 해당 표현을 짧게 (예: '디트로이트 출신', '기타리스트이자 싱어송라이터')
- factIds: 이 행에 해당하는 facts의 id. 모든 fact id가 어느 한 행에 들어가야 합니다.
- note: 근거와 판단을 한두 문장으로. 확인된 사실은 어떤 출처가 무엇을 뒷받침하는지, 평가 표현은 사실 부분과 평가 부분을 나눠서.
- needsWording: 출처 내용보다 원고 표현이 강하거나 단정적이어서 표현을 다듬으면 좋을 때만 true.

corrections: 실제로 고칠 필요가 있는 부분만. 사실 불일치, 근거 없는 단정, 출처보다 과장된 표현이 대상입니다.
- 검증 완료(VERIFIED)된 사실은 고치지 마세요.
- 평론적 표현은 틀렸다고 하지 말고, 필요할 때만 '…로 꼽힌다'처럼 평가임을 드러내는 방식을 제안하세요.
- suggestion은 원문의 문체와 어순을 최대한 살린 최소 수정안으로 쓰세요. 원고 전체를 다시 쓰지 마세요.
- 고칠 것이 없으면 빈 배열.

overall: 전체 검수 의견 2~4문장. 확인된 범위, 남은 확인 사항, 편집자가 직접 볼 부분.
모든 문장은 자연스러운 한국어로 쓰고, 인명·밴드명·앨범명·곡명은 원어 표기를 유지하세요.`;

// 행의 판정 라벨은 AI가 아니라 팩트시트 상태로 정합니다.
function rowLabel(facts) {
  const statuses = facts.map(f => f.verificationStatus);
  if (statuses.includes('CONTRADICTED')) return '사실 불일치';
  if (facts.some(f => f.failureType === 'CONFLICTING_EVIDENCE')) return '출처 충돌';
  const checkable = facts.filter(f => f.verificationStatus !== 'OPINION');
  if (!checkable.length) return '평론적 표현';
  if (checkable.some(f => f.verificationStatus === 'NOT CHECKED')) return '미검증';
  if (checkable.some(f => f.verificationStatus !== 'VERIFIED')) {
    return checkable.some(f => f.verificationStatus === 'VERIFIED') ? '일부 확인' : '근거 부족';
  }
  if (checkable.length < facts.length) return '확인 + 평가';
  return checkable.every(f => f.type === 'interpretation') ? '해석 (출처 확인)' : '확인';
}

async function buildReport(client, article, facts) {
  const result = await structuredResponse(client, {
    name: 'fact_check_report', schema: reportSchema, instructions: reportInstructions,
    input: {
      article: { title: article.title, body: article.body },
      facts: facts.map(f => ({
        id: f.id, type: f.type || 'fact', claim: f.claim, excerpt: f.excerpt,
        verificationStatus: f.verificationStatus, failureType: f.failureType || null,
        evidence: f.evidence || '', reason: String(f.reason || '').slice(0, 600),
        source: f.source?.publisher || null, suggestion: f.suggestion || ''
      }))
    }
  });
  const byId = new Map(facts.map(f => [String(f.id), f]));
  const used = new Set();
  const rows = [];
  for (const row of result.rows || []) {
    const ids = [...new Set(row.factIds.map(String))].filter(id => byId.has(id) && !used.has(id));
    if (!ids.length) continue;
    ids.forEach(id => used.add(id));
    const rowFacts = ids.map(id => byId.get(id));
    const label = rowLabel(rowFacts);
    rows.push({
      text: row.text, factIds: ids,
      verdict: row.needsWording && ['확인', '확인 + 평가', '해석 (출처 확인)'].includes(label) ? `${label} · 표현 보완` : label,
      note: row.note,
      sources: rowFacts.filter(f => f.source?.url).map(f => ({ url: f.source.url, publisher: f.source.publisher }))
    });
  }
  // AI가 빠뜨린 사실도 표에 남깁니다.
  for (const fact of facts) {
    if (used.has(String(fact.id))) continue;
    rows.push({ text: fact.excerpt || fact.claim, factIds: [String(fact.id)], verdict: rowLabel([fact]),
      note: fact.reason || '', sources: fact.source?.url ? [fact.source] : [] });
  }
  // 표는 원고(팩트시트) 순서대로 정렬합니다.
  const order = new Map(facts.map((f, i) => [String(f.id), i]));
  rows.sort((x, y) => Math.min(...x.factIds.map(id => order.get(id))) - Math.min(...y.factIds.map(id => order.get(id))));
  // 검증 완료 사실만 가리키고 출처상 수정 권고도 없는 '수정 제안'은 버립니다.
  const corrections = (result.corrections || []).filter(c => {
    const refs = c.factIds.map(id => byId.get(String(id))).filter(Boolean);
    if (!refs.length) return true;
    return refs.some(f => f.verificationStatus !== 'VERIFIED' || f.suggestion);
  });
  return { overall: result.overall, rows, corrections, generatedAt: new Date().toISOString() };
}

export default async function handler(req, res) {
  if (!authorize(req, res)) return;
  try {
    const { article, factSheet } = req.body || {};
    if (!article?.title?.trim() || !article?.body?.trim() || !Array.isArray(factSheet?.facts)) {
      return res.status(400).json({ error: '저장된 원고와 원고 기반 Fact Sheet가 필요합니다.' });
    }
    const facts = factSheet.facts;
    const issues = facts
      .filter(f => f.verificationStatus !== 'VERIFIED' && f.verificationStatus !== 'OPINION')
      .map(f => ({
        field: f.field === 'title' ? 'title' : 'body',
        text: f.excerpt || f.claim,
        verdict: f.verificationStatus || 'NOT CHECKED',
        reason: f.reason || '출처 본문에서 직접 확인하지 못했습니다.',
        suggestion: f.suggestion || '원출처를 직접 확인하고 사실을 수정하거나 삭제하세요.',
        factIds: [f.id]
      }));

    let report = null;
    if (facts.length && !facts.some(f => f.failureType === 'PENDING') && req.body?.report !== false) {
      try { report = await buildReport(getClient(), article, facts); }
      catch (error) { console.error('[검수 보고서 생성 실패]', error.message); }
    }

    return res.status(200).json({ success: true, review: {
      articleId: article.id || 'jack-white', status: 'needs_review', issues, report,
      approved: false, note: '외부 출처 기반 AI 보조 검수입니다. 사람의 원출처 확인이 필요합니다.'
    } });
  } catch (error) { handleError(res, error); }
}
