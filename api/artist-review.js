import { authorize, getClient, loadFactSheet, reviewArticle, handleError } from './_lib/artist-common.js';

export default async function handler(req, res) {
  if (!authorize(req, res)) return;
  try {
    const { facts } = await loadFactSheet();
    const article = req.body?.article;
    if (!article || typeof article.title !== 'string' || typeof article.body !== 'string' ||
        !article.title.trim() || !article.body.trim() || article.title.length > 300 || article.body.length > 15000) {
      return res.status(400).json({ error: 'article.title과 article.body를 요청 본문에 전달해야 합니다.' });
    }
    const review = await reviewArticle(getClient(), article, facts);
    res.status(200).json({ success: true, review });
  } catch (err) { handleError(res, err); }
}
