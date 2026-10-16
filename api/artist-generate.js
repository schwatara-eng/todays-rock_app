import { authorize, getClient, loadFactSheet, generateArticle, handleError } from './_lib/artist-common.js';

export default async function handler(req, res) {
  if (!authorize(req, res)) return;
  try {
    const { factSheet, facts } = await loadFactSheet();
    const article = await generateArticle(getClient(), factSheet, facts);
    res.status(200).json({ success: true, article, verifiedFacts: facts.length });
  } catch (err) { handleError(res, err); }
}
