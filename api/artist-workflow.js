/**
 * TODAY'S ROCK — 뮤지션 기사 생성·검수 통합 API
 *
 * 처리 순서: 관리자 인증 → 검증 사실 로드 → 기사 생성 → AI 검수 → 결과 반환
 * 각 단계의 시작·완료·소요시간을 Vercel 개발 서버 터미널에 기록한다.
 * API 키나 관리자 비밀값, 기사 본문은 로그에 출력하지 않는다.
 *
 * 참고: 실제 OpenAI 호출과 시간 제한 설정은 _lib/artist-common.js에 있다.
 */
import {
  authorize,
  getClient,
  loadFactSheet,
  generateArticle,
  reviewArticle,
  handleError,
} from './_lib/artist-common.js';

export default async function handler(req, res) {
  const startedAt = Date.now();
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}초`;

  // 1. 인증 실패 시 추가 작업을 수행하지 않는다.
  console.log('[기사 워크플로] 요청 수신:', req.method);
  if (!authorize(req, res)) {
    console.warn('[기사 워크플로] 인증 또는 요청 방식 확인 필요');
    return;
  }

  try {
    // 2. AI에 전달할 검증 완료 사실만 불러온다.
    console.log('[기사 워크플로] Fact Sheet 불러오는 중');
    const { factSheet, facts } = await loadFactSheet();
    console.log(`[기사 워크플로] 검증 사실 ${facts.length}개 로드 (${elapsed()})`);

    // 3. 기사 초안을 생성한다.
    const client = getClient();
    console.log('[기사 워크플로] AI 기사 생성 시작');
    const article = await generateArticle(client, factSheet, facts);
    console.log(`[기사 워크플로] AI 기사 생성 완료 (${elapsed()})`);

    // 4. 생성된 기사를 별도의 AI 검수 단계에 전달한다.
    console.log('[기사 워크플로] AI 검수 시작');
    const review = await reviewArticle(client, article, facts);
    console.log(`[기사 워크플로] AI 검수 완료 (${elapsed()})`);

    // 5. 결과를 로컬 관리자 편집기로 반환한다. 자동 게시하지 않는다.
    res.status(200).json({
      success: true,
      article,
      review,
      verifiedFacts: facts.length,
      published: false,
    });
    console.log(`[기사 워크플로] 응답 전송 완료 (${elapsed()})`);
  } catch (err) {
    // 자세한 오류는 서버 터미널에만 남긴다.
    console.error(`[기사 워크플로] 오류 발생 (${elapsed()}):`, err);
    handleError(res, err);
  }
}
