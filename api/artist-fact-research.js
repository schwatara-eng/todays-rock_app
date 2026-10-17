/** 에디터 원고 기반 전체 조사 및 단일 주장 재검색 API */
import { authorize, getClient, handleError } from './_lib/artist-common.js';
import { buildFactSheet, extractFactClaims } from './_lib/source-verification.js';

export default async function handler(req, res) {
  if (!authorize(req, res)) return;
  try {
    const article = req.body?.article;
    if (!article || typeof article.title !== 'string' || !article.title.trim() ||
        article.title.length > 300 || typeof article.body !== 'string' ||
        !article.body.trim() || article.body.length > 15000) {
      return res.status(400).json({ error: '먼저 제목과 본문을 작성하고 저장하세요.' });
    }
    if (req.body?.mode === 'extract') {
      const result = await extractFactClaims(getClient(), article);
      return res.status(200).json({ success: true, ...result });
    }
    const claim = req.body?.claim;
    if (claim && (typeof claim.claim !== 'string' || !claim.claim.trim() ||
        claim.claim.length > 1000 || !['title', 'body'].includes(claim.field) ||
        typeof claim.excerpt !== 'string' || claim.excerpt.length > 1500 ||
        !/^F\d{3}$/.test(req.body.factId || ''))) {
      return res.status(400).json({ error: '재검색할 주장 형식이 올바르지 않습니다.' });
    }
    if (!claim) return res.status(400).json({ error: '단계별 검증에서는 단일 주장을 지정해야 합니다.' });
    const factSheet = await buildFactSheet(getClient(), article,
      claim ? { claim, id: req.body.factId } : {});
    return res.status(200).json({ success: true, factSheet });
  } catch (error) { handleError(res, error); }
}
