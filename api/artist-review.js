/** 원고의 검증 상태를 검사하는 사실 검수 API. 검증 미완료는 이슈로 표시합니다. */
import { authorize, handleError } from './_lib/artist-common.js';

export default async function handler(req, res) {
  if (!authorize(req, res)) return;
  try {
    const { article, factSheet } = req.body || {};
    if (!article?.title?.trim() || !article?.body?.trim() || !Array.isArray(factSheet?.facts)) {
      return res.status(400).json({ error: '저장된 원고와 원고 기반 Fact Sheet가 필요합니다.' });
    }
    const issues = factSheet.facts.filter(f => f.verificationStatus !== 'VERIFIED').map(f => ({
      field: f.field === 'title' ? 'title' : 'body',
      text: f.excerpt || f.claim,
      verdict: f.verificationStatus || 'NOT CHECKED',
      reason: f.reason || '출처 본문에서 직접 확인하지 못했습니다.',
      suggestion: f.suggestion || '원출처를 직접 확인하고 사실을 수정하거나 삭제하세요.',
      factIds: [f.id]
    }));
    return res.status(200).json({ success: true, review: {
      articleId: article.id || 'jack-white', status: 'needs_review', issues,
      approved: false, note: '외부 출처 기반 AI 보조 검수입니다. 사람의 원출처 확인이 필요합니다.'
    } });
  } catch (error) { handleError(res, error); }
}
