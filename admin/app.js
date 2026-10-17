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
// 검수 상태 및 분류명 한글 표시
const reviewLabels = {
  VERIFIED: '검증 완료',
  CONTRADICTED: '사실 불일치',
  INSUFFICIENT: '근거 부족',
  NOT_CHECKED: '미검증',
  PENDING: '조사 대기',
  SEARCH_FAILED: '검색 실패',
  ACCESS_FAILED: '페이지 접근 실패',
  NO_EVIDENCE: '근거 부족',
  SOURCE_CONFLICT: '출처 충돌',
  SOURCE_ACCESS_FAILED: '출처 본문 접근 실패',
  EVIDENCE_INSUFFICIENT: '직접 근거 부족',
  CONFLICTING_EVIDENCE: '출처 간 근거 충돌',
  'NOT CHECKED': '미검증',

  readability: '가독성',
  structure: '구성',
  style: '문체·표현',
  repetition: '반복·중복',

  unsupported: '근거 없음',
  misleading: '오해 소지',
  needs_review: '추가 검토 필요',

  title: '제목',
  body: '본문'
};

function koreanLabel(value) {
  if (typeof value !== 'string') return value ?? '';
  return reviewLabels[value] || reviewLabels[value.toUpperCase()] || value;
}
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
  const verified = facts.filter((fact) => fact.verificationStatus === 'VERIFIED');
  const pending = facts.filter((fact) => fact.failureType === 'PENDING');
  const checked = facts.length - pending.length;
  $('fact-count').textContent = sheet ? `${checked}/${facts.length}개 조사 · ${verified.length}개 검증 완료${sheet.truncated ? ' · 일부만 추출' : ''}` : '조사 전';

  for (const fact of facts) {
    const card = element('div', '', 'fact');
    card.append(element('div', `${fact.id} · ${koreanLabel(fact.verificationStatus)}`, 'fact-id'));
    card.append(element('p', fact.claim || '내용 없음'));
    if (fact.evidence) card.append(element('p', `근거 원문: ${fact.evidence}`, 'evidence'));
    if (fact.reason) card.append(element('p', `검수 의견: ${fact.reason}`, 'fact-reason'));
    if (fact.suggestion) card.append(element('p', `수정 권고: ${fact.suggestion}`, 'fact-reason'));

    if (fact.failureType && fact.failureType !== 'PENDING') {
      card.append(element('p', `조사 상태: ${koreanLabel(fact.failureType)}`, 'fact-reason'));
    }
    if (fact.failureType !== 'PENDING' && fact.verificationStatus !== 'VERIFIED') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = '이 항목 출처 재검색';
      retry.className = 'fact-retry';
      retry.addEventListener('click', () => run(async () => {
        if (hasUnsavedChanges()) throw new Error('현재 원고를 먼저 저장해 주세요.');
        message(`${fact.id} 출처를 다시 검색하고 있습니다…`);
        const data = await post('/local/research-one', { factId: fact.id });
        showState(data, false);
        message(`${fact.id} 재검색이 완료됐습니다.`);
      }));
      card.append(retry);
    }
    // 검증 성공 여부와 무관하게 실제 검색된 출처 URL과 실패 사유를 표시합니다.
    // 링크는 HTTPS 주소만 허용하며 텍스트는 textContent로 삽입합니다.
    const sources = Array.isArray(fact.sources) ? fact.sources : [];
    const visibleSources = sources.length ? sources : (fact.source ? [fact.source] : []);
    if (visibleSources.length) {
      const sourceBox = element('div', '', 'fact-sources');
      sourceBox.style.marginTop = '12px';
      sourceBox.append(element('strong', `검색된 출처 ${visibleSources.length}개 (직접 확인 필요)`));
      for (const [index, source] of visibleSources.entries()) {
        const entry = element('div', '', 'fact-source');
        entry.style.marginTop = '8px';
        let safeUrl;
        try {
          const parsed = new URL(source.url);
          if (parsed.protocol === 'https:') safeUrl = parsed.href;
        } catch { /* 잘못된 URL은 링크로 만들지 않습니다. */ }
        if (safeUrl) {
          const link = document.createElement('a');
          link.href = safeUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = `${index + 1}. ${source.publisher || new URL(safeUrl).hostname} ↗`;
          entry.append(link);
          entry.append(element('div', safeUrl, 'fact-reason'));
        } else {
          entry.append(element('div', `${index + 1}. 출처 주소 확인 불가`, 'fact-reason'));
        }
        if (source.failureType) entry.append(element('div', `접근 상태: ${koreanLabel(source.failureType)}`, 'fact-reason'));
        else if (source.verificationStatus) entry.append(element('div', `검증 상태: ${koreanLabel(source.verificationStatus)}`, 'fact-reason'));
        if (source.reason) entry.append(element('div', `상세 사유: ${source.reason}`, 'fact-reason'));
        sourceBox.append(entry);
      }
      card.append(sourceBox);
    }
    const matchedIssues = findFactIssues(fact, lastState?.review?.issues || []);
    if (matchedIssues.length) {
      const box = element('div', '', 'fact-matched-review');
      box.append(element('h3', `팩트체크 의견 ${matchedIssues.length}건`));
      matchedIssues.forEach((issue) => appendReviewIssue(box, issue));
      card.append(box);
    }
    root.append(card);
  }
  if (!facts.length) root.append(element('p', '아직 추출된 사실이 없습니다. 원고 저장 후 팩트시트를 생성하세요.'));

  const issues = Array.isArray(lastState?.review?.issues) ? lastState.review.issues : [];
  const unmatched = issues.filter((issue) => !matchedFactId(issue, facts));
  if (unmatched.length) {
    const extras = element('section', '', 'unmatched-fact-issues');
    extras.append(element('h3', `연결되지 않은 검수 의견 ${unmatched.length}건`));
    extras.append(element('p', '팩트시트의 주장과 정확히 대응하지 않는 검수 의견입니다. 누락하지 않고 별도로 표시합니다.'));
    unmatched.forEach((issue) => appendReviewIssue(extras, issue));
    root.append(extras);
  }
}

function appendReviewIssue(root, issue) {
  const card = element('div', '', 'issue');
  card.append(element('strong', `${koreanLabel(issue.field)} · ${koreanLabel(issue.verdict || issue.category || 'fact')}`));
  if (issue.text) card.append(element('p', issue.text));
  if (issue.reason) card.append(element('p', `사유: ${issue.reason}`));
  if (issue.suggestion) card.append(element('p', `수정 제안: ${issue.suggestion}`));
  root.append(card);
}

function normalizeFactText(value) {
  return String(value || '').normalize('NFKC')
    .replace(/[\\s\\u200b\\u00a0]+/g, '')
    .replace(/[“”‘’"'.,!?()[\\]{}:;·—–-]/g, '')
    .toLowerCase();
}

function matchedFactId(issue, facts) {
  // 1순위: 서버가 제공한 사실 ID
  const explicit = [issue.factId, issue.fact_id, issue.claimId, issue.claim_id]
    .filter((id) => id !== undefined && id !== null && String(id).trim());
  for (const id of explicit) {
    const found = facts.find((fact) => String(fact.id) === String(id));
    if (found) return String(found.id);
  }

  // 2순위: 검수 의견의 원문 주장과 팩트시트 주장이 완전히 같은 경우
  // 유사한 문장을 억지로 연결하지 않아 잘못된 매칭을 방지합니다.
  const candidate = normalizeFactText(issue.text);
  if (!candidate || candidate.length < 12) return null;
  const matches = facts.filter((fact) => normalizeFactText(fact.claim) === candidate);
  return matches.length === 1 ? String(matches[0].id) : null;
}

function findFactIssues(fact, issues) {
  const facts = lastState?.factSheet?.facts || [];
  return issues.filter((issue) => matchedFactId(issue, facts) === String(fact.id));
}

function renderIssues(targetId, countId, review, kind) {
  const root = $(targetId);
  root.replaceChildren();

  if (!review) {
    $(countId).textContent = '미검토';
    root.append(element('p', '현재 저장된 기사에 대한 검토 결과가 없습니다.'));
    return;
  }

  const issues = Array.isArray(review.issues) ? review.issues : [];
  $(countId).textContent = `문제 ${issues.length}건`;

  if (issues.length === 0) {
    root.append(element('p', 'AI가 지적한 문제가 없습니다. 편집자 확인은 별도로 필요합니다.', 'ok'));
  }

  for (const issue of issues) {
    const card = element('div', '', 'issue');
    card.append(element(
  'strong',
  `${koreanLabel(issue.field)} · ${koreanLabel(issue.verdict || issue.category || kind)}`
));
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
  if (replaceArticle) showArticle(data.article);
  renderIssues('review-result', 'issue-count', data.review, 'fact');
  renderFacts(data.factSheet);
  renderIssues('editorial-result', 'editorial-count', data.editorialReview, 'editorial');

  const approved = data.state?.approved === true;
  $('draft-status').textContent = approved ? '승인 완료' : '초안';
  $('approval-status').textContent = approved ? '승인 완료 · 미게시' : '초안 · 미게시';
  $('confirm-sources').checked = false;
  $('export-article').disabled = !approved;
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
    buttons.forEach((button) => { button.disabled = button.id === 'export-article' ? !lastState?.state?.approved : false; });
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
$('research').addEventListener('click', () => run(async () => {
  if (hasUnsavedChanges()) throw new Error('현재 원고를 먼저 저장해 주세요.');
  message('저장된 팩트시트를 확인하고 있습니다…');
  // 서버는 요청 1회마다 사실 추출 또는 사실 1건 검증만 처리한다.
  // 한 항목의 실패가 전체 검증 결과를 날리지 않도록 매번 화면을 갱신한다.
  let state = await post('/local/research', { article: currentArticle() });
  showState(state, false);
  let facts = state.factSheet?.facts || [];
  let pending = facts.filter((fact) => fact.failureType === 'PENDING').length;
  if (!pending) {
    message(`조사 완료. 총 ${facts.length}개 사실 중 ${facts.filter(f => f.verificationStatus === 'VERIFIED').length}개 검증 완료.`);
    return;
  }
  while (pending > 0) {
    const checked = facts.length - pending;
    message(`웹 출처 조사 진행 중: ${checked}/${facts.length}개 처리. 각 항목 완료 시 저장됩니다…`);
    state = await post('/local/research', { article: currentArticle() });
    showState(state, false);
    facts = state.factSheet?.facts || [];
    const remaining = facts.filter((fact) => fact.failureType === 'PENDING').length;
    if (remaining >= pending) throw new Error('조사가 진행되지 않았습니다. 서버 기록을 확인해 주세요.');
    pending = remaining;
  }
  message(`전체 조사 완료: ${facts.length}개 중 ${facts.filter(f => f.verificationStatus === 'VERIFIED').length}개 검증 완료. 미검증 항목은 개별 재검색할 수 있습니다.`);
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
      $('draft-status').textContent = '저장되지 않음';
      $('approval-status').textContent = '저장되지 않음 · 재검토 필요';
      $('export-article').disabled = true;
    } else if (lastState) {
      $('draft-status').textContent = lastState.state?.approved ? '승인 완료' : '초안';
      $('approval-status').textContent = lastState.state?.approved ? '승인 완료 · 미게시' : '초안 · 미게시';
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 6. 로컬 기사 미리보기와 승인된 기사 데이터 내보내기
// ─────────────────────────────────────────────────────────────

// 줄바꿈은 문단으로 표현합니다. innerHTML 대신 textContent를 사용해
// 기사 내용에 HTML 코드가 있어도 실행되지 않도록 합니다.
function renderPreview() {
  const article = currentArticle();
  if (!article.title.trim() || !article.body.trim()) {
    throw new Error('미리보기할 기사 제목과 본문이 필요합니다.');
  }

  $('preview-title').textContent = article.title.trim();
  const approved = lastState?.state?.approved === true && !hasUnsavedChanges();
  $('preview-meta').textContent = approved
    ? 'EDITOR APPROVED · NOT PUBLISHED'
    : 'DRAFT PREVIEW · NOT PUBLISHED';

  const body = $('preview-body');
  body.replaceChildren();
  const paragraphs = article.body.trim().split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const p = document.createElement('p');
    p.textContent = paragraph.trim();
    body.append(p);
  }
  $('preview-panel').hidden = false;
  $('preview-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('preview-open').addEventListener('click', () => {
  try {
    renderPreview();
    message('로컬 기사 미리보기를 열었습니다. 실제 사이트에는 반영되지 않습니다.');
  } catch (error) {
    message(`오류: ${error.message}`);
  }
});

$('preview-close').addEventListener('click', () => {
  $('preview-panel').hidden = true;
});

// 서버가 저장된 원고의 승인 상태를 다시 검증한 후에만 내보냅니다.
// 브라우저에 저장된 이전 승인 상태만 믿고 JSON을 만들지 않습니다.
$('export-article').addEventListener('click', () => run(async () => {
  if (hasUnsavedChanges()) throw new Error('현재 수정한 원고를 먼저 저장하고 재검토하세요.');

  const response = await fetch('/local/publication-export', { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);

  const blob = new Blob([`${JSON.stringify(result, null, 2)}\n`], {
    type: 'application/json;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'jack-white-approved.json';
  link.click();
  URL.revokeObjectURL(url);
  message('승인된 기사 JSON을 내보냈습니다. 실제 게시는 별도 작업입니다.');
}));


// ─────────────────────────────────────────────────────────────
// 편집실 3단계 작업 공간 (화면 재배치 전용)
// 기존 원고/팩트시트/검토 결과 및 서버 API는 변경하지 않습니다.
// ─────────────────────────────────────────────────────────────
function setupEditorialWorkflow() {
  const workspace = document.querySelector('.workspace');
  const draft = document.querySelector('.work-column > .editor');
  const factPanel = document.querySelector('.facts-panel');
  const sourcePanel = $('review-result')?.closest('section.panel');
  const editorialPanel = $('editorial-result')?.closest('section.panel');
  const approval = document.querySelector('.approval-panel');
  if (!workspace || !draft || !factPanel || !sourcePanel || !editorialPanel) return;

  const createStage = (number, name, subtitle, className) => {
    const section = document.createElement('section');
    section.className = `workflow-stage ${className}`;
    const heading = document.createElement('div');
    heading.className = 'workflow-heading';
    heading.append(element('span', number, 'workflow-number'));
    const titles = document.createElement('div');
    titles.append(element('h2', name));
    titles.append(element('p', subtitle));
    heading.append(titles);
    section.append(heading);
    return section;
  };

  const writing = createStage('01', '작성', '에디터 원고 작성 · 초안 저장 · 미리보기', 'workflow-writing');
  const factcheck = createStage('02', '사실 검수', '팩트시트 · 출처 검색 · 사실 대조 · 재검색', 'workflow-factcheck');
  const editing = createStage('03', '편집 검토', '원고 구조 · 윤문 · 표현 · 교정', 'workflow-editing');

  const draftHead = draft.querySelector('.panel-head h2');
  if (draftHead) draftHead.textContent = '원고 작성';
  const factsHead = factPanel.querySelector('.panel-head h2');
  if (factsHead) factsHead.textContent = '팩트시트 · 사실 목록';
  const sourceHead = sourcePanel.querySelector('.panel-head h2');
  if (sourceHead) sourceHead.textContent = '사실 검수 결과';
  const editHead = editorialPanel.querySelector('.panel-head h2');
  if (editHead) editHead.textContent = '편집 검토 결과';

  // 기존 버튼 ID와 이벤트 연결을 보존하면서 역할별로 이동합니다.
  const actions = draft.querySelector('.actions');
  const save = $('save');
  const research = $('research');
  const recheck = $('recheck');
  if (actions && save) {
    actions.replaceChildren(save);
    const preview = $('preview-open');
    if (preview) actions.append(preview);
  }
  if (research) {
    research.textContent = '팩트시트 생성 · 출처 검증';
    const controls = element('div', '', 'actions');
    controls.append(research);
    factcheck.append(controls);
  }
  if (recheck) {
    recheck.textContent = '사실 검수 + 편집 재검토';
    const controls = element('div', '', 'actions');
    controls.append(recheck);
    editing.append(controls);
  }

  const factContent = element('div', '', 'workflow-fact-content');
  factContent.append(factPanel);
  factcheck.append(factContent);
  // 검수 의견은 renderFacts()가 해당 사실 카드 또는 미연결 의견 구역에 표시합니다.
  // 별도의 사실 검수 결과 박스는 제거하되 기존 DOM 요소는 이벤트 호환을 위해 보존합니다.
  sourcePanel.hidden = true;
  sourcePanel.style.display = 'none';
  factcheck.append(sourcePanel);
  writing.append(draft);
  editing.append(editorialPanel);

  workspace.replaceChildren(writing, factcheck, editing);
  if (approval) {
    const head = approval.querySelector('.panel-head h2');
    if (head) head.textContent = '최종 승인 · 게시 준비';
  }
  const intro = document.querySelector('.intro > p:last-child');
  if (intro) intro.textContent = '01 작성 → 02 사실 검수 → 03 편집 검토 → 에디터 최종 승인';

  const style = document.createElement('style');
  style.textContent = `
    .workspace {display:flex !important;flex-direction:column;align-items:stretch !important;gap:22px}
    .workflow-stage {min-width:0;width:100%;border-top:1px solid #4a3732;padding-top:16px}
    .workflow-heading {display:flex;align-items:center;gap:14px;margin:0 0 15px}
    .workflow-number {font-size:24px;font-weight:800;color:#d55b4f}
    .workflow-heading h2 {font-size:20px;letter-spacing:-.4px;margin:0}
    .workflow-heading p {font-size:12px;color:#afa49b;margin:6px 0 0}
    .workflow-stage > .panel {width:100%;min-height:0}
    .workflow-fact-content {display:block}
    .workflow-fact-content > .panel {position:static !important;inset:auto !important;max-height:none !important;min-height:0 !important;overflow:visible !important;width:100%}
    .workflow-fact-content .facts {overflow:visible !important;max-height:none !important;display:grid;grid-template-columns:1fr;gap:14px}
    .workflow-fact-content .fact {padding:20px;margin:0;border:1px solid #51413a;border-radius:6px;background:#211e1c}
    .workflow-fact-content .fact-id {font-weight:700;font-size:13px}
    .workflow-fact-content .fact-matched-review {margin-top:16px;padding-top:12px;border-top:1px solid #51413a}
    .workflow-fact-content .fact-matched-review h3 {font-size:13px;color:#e6b4aa}
    .workflow-fact-content .unmatched-fact-issues {padding:20px;border:1px solid #645045;border-radius:6px;background:#27211e}
    .workflow-fact-content .unmatched-fact-issues h3 {font-size:15px;margin:0 0 8px;color:#e6b4aa}
    .workflow-fact-content .unmatched-fact-issues > p {font-size:12px;color:#bba99e}
    .workflow-factcheck > .panel[hidden] {display:none}
    .workflow-factcheck > .panel {margin-top:16px}
    .workflow-writing .editor {position:static !important;grid-column:auto !important;grid-row:auto !important;max-height:none !important;overflow:visible !important}
    .workflow-writing .editor textarea {min-height:320px;max-height:none;height:auto}
    .workflow-factcheck > .actions {margin:0 0 14px}
    .workflow-editing > .actions {margin:0 0 14px}
    @media(max-width:900px) {.workflow-fact-content {grid-template-columns:1fr}}
  `;
  document.head.append(style);
}
setupEditorialWorkflow();

initialize();
