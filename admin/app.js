/**
 * TODAY'S ROCK - 관리자 편집기 화면 제어
 *
 * 서버와의 통신은 /local/* 경로만 사용한다.
 * OPENAI_API_KEY 및 ADMIN_SECRET은 이 파일에 절대 넣지 않는다.
 */

// ─────────────────────────────────────────────────────────────
// 1. 화면 요소와 현재 저장된 기사 버전
// ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
let lastSaved = { title: '', body: '' };
let lastState = null;

function message(text) {
  $('status').textContent = text;
}

function element(tag, content, className) {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}

function currentArticle() {
  return { title: $('title').value, body: $('body').value };
}

function hasUnsavedChanges() {
  const current = currentArticle();
  return current.title !== lastSaved.title || current.body !== lastSaved.body;
}

// ─────────────────────────────────────────────────────────────
// 2. 검증 자료·검토 결과 표시 (HTML 문자열 삽입 방지)
// ─────────────────────────────────────────────────────────────
function renderFacts(sheet) {
  const root = $('facts');
  root.replaceChildren();
  const facts = sheet?.facts || [];
  const verified = facts.filter((fact) => fact.verificationStatus === 'verified');
  $('fact-count').textContent = `${verified.length} VERIFIED`;

  for (const fact of facts) {
    const card = element('div', '', 'fact');
    card.append(element('div', `${fact.id} · ${fact.verificationStatus}`, 'fact-id'));
    card.append(element('p', fact.claim || '내용 없음'));

    if (fact.source?.url?.startsWith('https://')) {
      const link = document.createElement('a');
      link.href = fact.source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = fact.source.publisher || '출처 보기';
      card.append(link);
    }
    root.append(card);
  }
}

function renderIssues(targetId, countId, review, kind) {
  const root = $(targetId);
  root.replaceChildren();

  if (!review) {
    $(countId).textContent = 'NOT CHECKED';
    root.append(element('p', '현재 저장된 기사에 대한 검토 결과가 없습니다.'));
    return;
  }

  const issues = Array.isArray(review.issues) ? review.issues : [];
  $(countId).textContent = `${issues.length} ISSUES`;

  if (issues.length === 0) {
    root.append(element('p', 'AI가 지적한 문제가 없습니다. 편집자 확인은 별도로 필요합니다.', 'ok'));
  }

  for (const issue of issues) {
    const card = element('div', '', 'issue');
    card.append(element('strong', `${issue.field} · ${issue.verdict || issue.category || kind}`));
    if (issue.text) card.append(element('p', issue.text));
    card.append(element('p', `사유: ${issue.reason}`));
    card.append(element('p', `수정 제안: ${issue.suggestion}`));
    root.append(card);
  }
}

function showArticle(article) {
  $('title').value = article?.title || '';
  $('body').value = article?.body || '';
  lastSaved = currentArticle();
}

function showState(data, replaceArticle = true) {
  lastState = data;
  renderFacts(data.factSheet);
  if (replaceArticle) showArticle(data.article);
  renderIssues('review-result', 'issue-count', data.review, 'fact');
  renderIssues('editorial-result', 'editorial-count', data.editorialReview, 'editorial');

  const approved = data.state?.approved === true;
  $('draft-status').textContent = approved ? 'APPROVED' : 'DRAFT';
  $('approval-status').textContent = approved ? 'APPROVED · NOT PUBLISHED' : 'DRAFT · NOT PUBLISHED';
  $('confirm-sources').checked = false;
}

// ─────────────────────────────────────────────────────────────
// 3. 서버 통신과 버튼 중복 실행 방지
// ─────────────────────────────────────────────────────────────
async function post(endpoint, payload = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function run(task) {
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await task();
  } catch (error) {
    message(`오류: ${error.message}`);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function initialize() {
  try {
    const response = await fetch('/local/data');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '불러오기 실패');
    showState(data);
    message('로컬 기사와 검토 기록을 불러왔습니다.');
  } catch (error) {
    message(`불러오기 실패: ${error.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 4. 초안 생성·저장·AI 검토
// ─────────────────────────────────────────────────────────────
$('generate').addEventListener('click', () => run(async () => {
  if (hasUnsavedChanges() && !confirm('편집 중인 내용을 AI 초안으로 덮어쓸까요?')) return;
  message('AI 초안 생성과 사실 검수를 진행하고 있습니다…');
  const data = await post('/local/generate');
  showState(data);
  message('AI 초안과 사실 검수를 저장했습니다. 편집 검토는 별도로 진행하세요.');
}));

$('save').addEventListener('click', () => run(async () => {
  message('현재 원고를 로컬에 저장하고 있습니다…');
  const data = await post('/local/save', { article: currentArticle() });
  showState(data);
  message('초안 저장 완료. 수정한 원고는 사실 검수와 편집 검토를 다시 받아야 합니다.');
}));

$('recheck').addEventListener('click', () => run(async () => {
  if (hasUnsavedChanges()) throw new Error('먼저 초안 저장을 눌러 주세요.');
  message('사실 검수와 편집 검토를 순서대로 실행하고 있습니다…');
  const data = await post('/local/recheck', { article: currentArticle() });
  showState(data, false);
  message('사실 검수와 편집 검토가 완료됐습니다.');
}));

$('editorial').addEventListener('click', () => run(async () => {
  if (hasUnsavedChanges()) throw new Error('먼저 초안 저장을 눌러 주세요.');
  message('AI 편집 검토를 진행하고 있습니다…');
  const data = await post('/local/editorial', { article: currentArticle() });
  showState(data, false);
  message('AI 편집 검토가 완료됐습니다.');
}));

// ─────────────────────────────────────────────────────────────
// 5. 사람의 명시적 최종 승인 (실제 게시는 수행하지 않음)
// ─────────────────────────────────────────────────────────────
$('approve').addEventListener('click', () => run(async () => {
  if (hasUnsavedChanges()) throw new Error('수정한 원고를 먼저 저장하고 재검토하세요.');
  if (!$('confirm-sources').checked) throw new Error('출처 확인 체크박스를 선택해 주세요.');
  if (!confirm('원출처를 확인했고 이 원고를 승인할까요? 실제 게시되지는 않습니다.')) return;

  message('기사 승인 상태를 저장하고 있습니다…');
  const data = await post('/local/approve', {
    article: currentArticle(),
    confirmSources: true
  });
  showState(data, false);
  message('편집자 승인 완료. 공개 사이트에는 게시되지 않았습니다.');
}));

// 사용자가 글을 고치면 승인 상태가 즉시 유효하지 않음을 표시한다.
for (const id of ['title', 'body']) {
  $(id).addEventListener('input', () => {
    if (hasUnsavedChanges()) {
      $('draft-status').textContent = 'UNSAVED';
      $('approval-status').textContent = 'UNSAVED · RECHECK REQUIRED';
    } else if (lastState) {
      $('draft-status').textContent = lastState.state?.approved ? 'APPROVED' : 'DRAFT';
      $('approval-status').textContent = lastState.state?.approved ? 'APPROVED · NOT PUBLISHED' : 'DRAFT · NOT PUBLISHED';
    }
  });
}

initialize();
