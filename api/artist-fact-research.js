/** 에디터 원고 기반 사실 추출, 그룹 단위 조사, 단일 주장 재검색 API */
import { authorize, getClient, handleError } from './_lib/artist-common.js';
import { buildFactSheet, extractFactClaims, CLAIM_TYPES } from './_lib/source-verification.js';

const MAX_GROUP = 8;

// 주장 1개의 형식 검사. type·group·keywords는 이전 데이터와의 호환을 위해 선택 항목입니다.
function validClaim(claim) {
  return claim && typeof claim.claim === 'string' && claim.claim.trim() &&
    claim.claim.length <= 1000 && ['title', 'body'].includes(claim.field) &&
    typeof claim.excerpt === 'string' && claim.excerpt.length <= 1500 &&
    (claim.type === undefined || CLAIM_TYPES.includes(claim.type)) &&
    (claim.group === undefined || claim.group === null || typeof claim.group === 'string') &&
    (claim.keywords === undefined || (Array.isArray(claim.keywords) && claim.keywords.length <= 20 &&
      claim.keywords.every(k => typeof k === 'string' && k.length <= 100)));
}

function cleanClaim(claim) {
  return {
    claim: claim.claim, field: claim.field, excerpt: claim.excerpt,
    type: claim.type || 'fact', group: claim.group || null,
    keywords: Array.isArray(claim.keywords) ? claim.keywords : []
  };
}

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
    const excludeUrls = Array.isArray(req.body?.excludeUrls)
      ? req.body.excludeUrls.filter(u => typeof u === 'string' && u.length <= 2000).slice(0, 50)
      : [];

    // 그룹 조사: 같은 대상을 다루는 주장 여러 개를 출처 검색 1회로 함께 검증합니다.
    if (Array.isArray(req.body?.claims)) {
      const { claims, factIds } = req.body;
      if (!claims.length || claims.length > MAX_GROUP || !Array.isArray(factIds) ||
          factIds.length !== claims.length || !claims.every(validClaim) ||
          !factIds.every(id => /^F\d{3}$/.test(id))) {
        return res.status(400).json({ error: '조사할 주장 묶음 형식이 올바르지 않습니다.' });
      }
      const factSheet = await buildFactSheet(getClient(), article,
        { claims: claims.map(cleanClaim), ids: factIds, excludeUrls });
      return res.status(200).json({ success: true, factSheet });
    }

    // 단일 주장 (개별 재검색)
    const claim = req.body?.claim;
    if (!claim) return res.status(400).json({ error: '단계별 검증에서는 조사할 주장을 지정해야 합니다.' });
    if (!validClaim(claim) || !/^F\d{3}$/.test(req.body.factId || '')) {
      return res.status(400).json({ error: '재검색할 주장 형식이 올바르지 않습니다.' });
    }
    const factSheet = await buildFactSheet(getClient(), article,
      { claim: cleanClaim(claim), id: req.body.factId, excludeUrls });
    return res.status(200).json({ success: true, factSheet });
  } catch (error) { handleError(res, error); }
}
