/** 에디터 원고를 기준으로 실제 웹 출처를 조사하는 API */
import { authorize, getClient, handleError } from './_lib/artist-common.js';
import { buildFactSheet } from './_lib/source-verification.js';

export default async function handler(req, res) {
  if (!authorize(req, res)) return;
  try {
    const article = req.body?.article;
    if (!article || typeof article.title !== 'string' || !article.title.trim() ||
        article.title.length > 300 || typeof article.body !== 'string' ||
        !article.body.trim() || article.body.length > 15000) {
      return res.status(400).json({ error: '먼저 제목과 본문을 작성하고 저장하세요.' });
    }
    console.log('[팩트 조사] 시작');
    const factSheet = await buildFactSheet(getClient(), article);
    console.log('[팩트 조사] 완료', { count: factSheet.facts.length });
    return res.status(200).json({ success: true, factSheet });
  } catch (error) { handleError(res, error); }
}
