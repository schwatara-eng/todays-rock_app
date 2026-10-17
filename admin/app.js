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
  OPINION: '평론적 표현',
  SOURCE_CONTRADICTS: '출처와 불일치',
  VERIFY_FAILED: '판정 오류',

  fact: '사실',
  interpretation: '해석·평가',
  opinion: '평론',

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
  const checks = $('fact-check-cards');
  const rows = $('fact-pairs');
  root.replaceChildren();
  checks.replaceChildren();
  rows.replaceChildren();
  const facts = sheet?.facts || [];
  const verified = facts.filter(f => f.verificationStatus === 'VERIFIED');
  const opinions = facts.filter(f => f.verificationStatus === 'OPINION');
  const pending = facts.filter(f => f.failureType === 'PENDING');
  $('fact-count').textContent = sheet ? `${facts.length - pending.length}/${facts.length}개 조사 · ${verified.length}개 검증 완료${opinions.length ? ` · 평론 ${opinions.length}개` : ''}${sheet.truncated ? ' · 일부만 추출' : ''}` : '조사 전';
  renderReport($('fact-report') || root, lastState?.review?.report, facts);
  $('fact-check-count').textContent = sheet ? `${facts.length}개 항목` : '조사 전';
  const issues = Array.isArray(lastState?.review?.issues) ? lastState.review.issues : [];
  for (const fact of facts) {
    const id = String(fact.id);
    const card = element('div', '', 'fact fact-claim');
    card.id = `claim-${id}`;
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'fact-select';
    select.textContent = `${id} · ${koreanLabel(fact.verificationStatus || 'NOT_CHECKED')}`;
    select.addEventListener('click', () => {
      document.querySelectorAll('.fact-selected').forEach(n => n.classList.remove('fact-selected'));
      card.classList.add('fact-selected');
      const target = document.getElementById(`check-${id}`);
      if (target) { target.classList.add('fact-selected'); target.scrollIntoView({behavior:'smooth',block:'nearest'}); }
    });
    card.append(
    select,
    element('span', koreanLabel(fact.type || 'fact'), `fact-type fact-type-${fact.type || 'fact'}`),
    element('p', fact.claim ? `“${fact.claim}”` : '내용 없음')
    );
    if (fact.excerpt && fact.excerpt !== fact.claim) card.append(element('p', `원고: ${fact.excerpt}`, 'fact-reason'));

    const result = element('div', '', 'fact fact-check');
    result.id = `check-${id}`;
    result.append(element('div', `${id} · ${koreanLabel(fact.verificationStatus || 'NOT_CHECKED')}`, 'fact-id'));
    if (fact.evidence) result.append(element('p', `근거 원문: ${fact.evidence}`, 'evidence'));
    if (fact.reason) result.append(element('p', `검수 의견: ${fact.reason}`, 'fact-reason'));
    if (fact.suggestion) result.append(element('p', `수정 권고: ${fact.suggestion}`, 'fact-reason'));
    if (fact.failureType && fact.failureType !== 'PENDING') result.append(element('p', `조사 상태: ${koreanLabel(fact.failureType)}`, 'fact-reason'));
    if (fact.verificationStatus !== 'VERIFIED' && !fact.reason && !fact.evidence) {
      result.append(element('p', fact.failureType === 'PENDING' ? '아직 검증을 진행하지 않았습니다.' : '직접 확인된 근거가 없어 검증을 완료하지 못했습니다.', 'fact-reason'));
    }
    if (fact.failureType !== 'PENDING' && fact.verificationStatus !== 'VERIFIED' && fact.verificationStatus !== 'OPINION') {
      const retry = document.createElement('button');
      retry.type = 'button'; retry.textContent = '이 항목 출처 재검색'; retry.className = 'fact-retry';
      retry.addEventListener('click', () => run(async () => {
        if (hasUnsavedChanges()) throw new Error('현재 원고를 먼저 저장해 주세요.');
        message(`${id} 출처를 다시 검색하고 있습니다…`);
        const data = await post('/local/research-one', { factId: id });
        showState(data, false); message(`${id} 재검색이 완료됐습니다.`);
      }));
      result.append(retry);
    }
    const sources = Array.isArray(fact.sources) ? fact.sources : [];
    const visibleSources = sources.length ? sources : (fact.source ? [fact.source] : []);
    const sourceCard = element('div', '', 'fact fact-source-card');
    sourceCard.id = `sources-${id}`;
    sourceCard.append(element('div', `${id} · 검색된 출처`, 'fact-id'));
    if (visibleSources.length) {
      const sourceBox = element('div', '', 'fact-sources');
      sourceBox.append(element('strong', `검색된 출처 ${visibleSources.length}개 (직접 확인 필요)`));
      for (const [index, source] of visibleSources.entries()) {
        const entry = element('div', '', 'fact-source');
        let safeUrl;
        try { const parsed = new URL(source.url); if (parsed.protocol === 'https:') safeUrl = parsed.href; } catch {}
        if (safeUrl) {
          const link = document.createElement('a');
          link.href = safeUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
          link.textContent = `${index + 1}. ${source.publisher || new URL(safeUrl).hostname} ↗`;
          entry.append(link, element('div', safeUrl, 'fact-reason'));
        } else entry.append(element('div', `${index + 1}. 출처 주소 확인 불가`, 'fact-reason'));
        if (source.failureType) entry.append(element('div', `접근 상태: ${koreanLabel(source.failureType)}`, 'fact-reason'));
        else if (source.verificationStatus) entry.append(element('div', `검증 상태: ${koreanLabel(source.verificationStatus)}`, 'fact-reason'));
        if (source.reason) entry.append(element('div', `상세 사유: ${source.reason}`, 'fact-reason'));
        sourceBox.append(entry);
      }
      sourceCard.append(sourceBox);
    } else {
      sourceCard.append(element('p', '검색된 출처가 없습니다.', 'fact-reason'));
    }
    // 사실 검수의 원문 문장이 기존 팩트시트 주장과 겹치면
    // 같은 검수 의견을 다시 카드로 출력하지 않습니다.
    // F003/F004처럼 한 원문에서 여러 사실이 분리된 경우도 포함합니다.
    const matchedIssues = findFactIssues(fact, issues, facts);
    const novelIssues = matchedIssues.filter(issue =>
      !facts.some(saved => reviewRefersToFact(issue, saved))
    );
    if (novelIssues.length) {
      const box = element('div', '', 'fact-matched-review');
      box.append(element('h3', `추가 검수 의견 ${novelIssues.length}건`));
      const existing = facts.flatMap(saved => [saved.claim, saved.evidence, saved.reason, saved.suggestion]).filter(Boolean);
      novelIssues.forEach(issue => appendReviewIssue(box, issue, existing));
      if (box.querySelector('.issue')) result.append(box);
    }
    const pair = element('div', '', 'fact-pair');
    const combined = element('div', '', 'fact-combined');
    combined.append(card, result);
    pair.append(combined, sourceCard);
    rows.append(pair);
  }
  if (!facts.length) rows.append(element('p', '아직 추출된 사실이 없습니다. 원고 저장 후 팩트시트를 생성하세요.'));
  // ID 미연결 의견은 별도 화면 카드로 중복 출력하지 않습니다.
  // 원본 검수 기록(lastState.review)은 변경하거나 삭제하지 않습니다.
  // 누락된 새로운 주장 여부는 향후 서버 factId 연결 단계에서 처리합니다.
}

// 편집자용 검수 보고서: 원고 주장 / 판정 / 근거 및 판단 표 + 전체 의견 + 수정 제안
// 판정 라벨은 서버가 팩트시트 상태로 정한 값이며, AI가 쓴 것은 설명 문장뿐입니다.
function renderReport(root, report, facts) {
  if (root.id === 'fact-report') root.replaceChildren();
  root.hidden = !facts.length;
  if (!facts.length) return;
  const box = element('div', '', 'fact-report');
  if (!report) {
    const pending = facts.some(f => f.failureType === 'PENDING');
    box.append(element('p', pending ? '모든 항목을 조사하면 검수 보고서가 만들어집니다.' : '검수 보고서가 아직 없습니다. 재검수를 실행하면 만들어집니다.', 'fact-reason'));
    root.append(box);
    return;
  }
  box.append(element('h3', '검수 보고서'));
  if (report.overall) box.append(element('p', report.overall, 'report-overall'));
  const wrap = element('div', '', 'report-table-wrap');
  const table = document.createElement('table');
  table.className = 'report-table';
  const head = document.createElement('tr');
  ['원고의 주장', '판정', '근거 및 판단'].forEach(t => head.append(element('th', t)));
  table.append(head);
  for (const row of report.rows || []) {
    const tr = document.createElement('tr');
    const claimCell = element('td', row.text);
    claimCell.append(element('div', (row.factIds || []).join(', '), 'report-ids'));
    const verdict = element('td', row.verdict, 'report-verdict');
    verdict.dataset.verdict = row.verdict;
    const note = element('td', row.note);
    for (const source of row.sources || []) {
      try {
        const url = new URL(source.url);
        if (url.protocol !== 'https:') continue;
        const link = document.createElement('a');
        link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.textContent = `${source.publisher || url.hostname} ↗`;
        const line = element('div', '', 'report-source'); line.append(link); note.append(line);
      } catch { /* 잘못된 주소는 표시하지 않음 */ }
    }
    tr.append(claimCell, verdict, note);
    table.append(tr);
  }
  wrap.append(table);
  box.append(wrap);
  const corrections = report.corrections || [];
  box.append(element('h3', corrections.length ? `수정 제안 ${corrections.length}건` : '수정 제안 없음'));
  for (const item of corrections) {
    const card = element('div', '', 'issue');
    card.append(element('strong', `${koreanLabel(item.field)} · ${(item.factIds || []).join(', ')}`));
    card.append(element('p', `원문: ${item.text}`));
    card.append(element('p', `사유: ${item.problem}`));
    card.append(element('p', `수정 제안: ${item.suggestion}`));
    box.append(card);
  }
  root.append(box);
}

function appendReviewIssue(root, issue, existing = []) {
  const card = element('div', '', 'issue');
  card.append(element('strong', `${koreanLabel(issue.field)} · ${koreanLabel(issue.verdict || issue.category || 'fact')}`));
  const items = [[issue.text, ''], [issue.reason, '사유: '], [issue.suggestion, '수정 제안: ']];
  const unique = [];
  for (const [value, prefix] of items) {
    if (!value || [...existing, ...unique].some(prev => sameReviewContent(value, prev))) continue;
    card.append(element('p', `${prefix}${value}`));
    unique.push(value);
  }
  if (unique.length) root.append(card);
}

function normalizeFactText(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\s\u200b\u00a0“”‘’"'.,!?()[\]{}:;·—–-]+/g, '');
}

function sameReviewContent(a, b) {
  const x = normalizeFactText(a), y = normalizeFactText(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 24 &&
    (x.includes(y) || y.includes(x))));
}

function overlapScore(a, b) {
  const x = normalizeFactText(a), y = normalizeFactText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (Math.min(x.length, y.length) >= 12 && (x.includes(y) || y.includes(x))) return 0.95;
  // 조사 의견이 길어도 핵심 주장 부분이 일치하면 연결합니다.
  const ngrams = value => {
    const set = new Set();
    for (let i = 0; i <= value.length - 4; i++) set.add(value.slice(i, i + 4));
    return set;
  };
  const ax = ngrams(x), by = ngrams(y);
  if (!ax.size || !by.size) return 0;
  let common = 0;
  for (const part of ax) if (by.has(part)) common++;
  return common / Math.min(ax.size, by.size);
}

// 원문 검수 문장과 추출된 사실 주장의 의미상 중복을 보수적으로 판별합니다.
// 문자열 완전 일치뿐 아니라, 긴 문장에서 분리된 F003/F004 주장도 감지합니다.
function reviewRefersToFact(issue, fact) {
  const text = String(issue.text || '');
  const claim = String(fact.claim || '');
  if (!text || !claim) return false;
  const score = overlapScore(text, claim);
  return score >= 0.60 || sameReviewContent(text, claim);
}

function matchedFactId(issue, facts) {
  // 명시적 서버 사실 ID를 최우선으로 사용합니다.
  for (const id of [issue.factId, issue.fact_id, issue.claimId, issue.claim_id]) {
    if (id == null) continue;
    const found = facts.find(f => String(f.id).toUpperCase() === String(id).trim().toUpperCase());
    if (found) return String(found.id);
  }
  const text = String(issue.text || '');
  if (normalizeFactText(text).length < 8) return null;
  const candidates = facts.map(f => ({id:String(f.id), score:overlapScore(text, f.claim)}))
    .sort((a,b) => b.score - a.score);
  const best = candidates[0], second = candidates[1];
  if (!best || best.score < 0.62 || (second && best.score - second.score < 0.08)) return null;
  return best.id;
}

function findFactIssues(fact, issues, facts = lastState?.factSheet?.facts || []) {
  return issues.filter(issue => matchedFactId(issue, facts) === String(fact.id));
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
  const facts = document.querySelector('.facts-panel');
  const sourcePanel = $('review-result')?.closest('section.panel');
  const editorialPanel = $('editorial-result')?.closest('section.panel');
  if (!workspace || !draft || !facts || !sourcePanel || !editorialPanel) return;
  const writing = document.createElement('div'); writing.className = 'workflow-writing';
  const factcheck = document.createElement('div'); factcheck.className = 'workflow-factcheck';
  const editing = document.createElement('div'); editing.className = 'workflow-editing';
  const factResults = document.createElement('section');
  factResults.className = 'panel fact-check-panel';
  const head = document.createElement('div'); head.className = 'panel-head';
  head.append(element('h2', '02 / 팩트체크 · 검증'));
  const count = element('span', '—'); count.id = 'fact-check-count'; head.append(count);
  factResults.append(head);
  const results = element('div', '', 'fact-check-cards'); results.id = 'fact-check-cards';
  factResults.append(results);
  const pairs = element('div', '', 'fact-pairs'); pairs.id = 'fact-pairs';
  // 검수 보고서: 사실별 카드 위에 전체 폭으로 표시합니다.
  const report = element('section', '', 'panel fact-report-panel'); report.id = 'fact-report'; report.hidden = true;
  const actions = draft.querySelector('.actions');
  if (actions) {
    const save = $('save');
    const research = $('research');
    const preview = $('preview-open');
    actions.replaceChildren();
    if (save) actions.append(save);
    if (research) actions.append(research);
    if (preview) actions.append(preview);
  }
  const recheck = $('recheck');
  if (recheck) { const controls = element('div', '', 'actions'); controls.append(recheck); editing.append(controls); }
  const draftHead = draft.querySelector('.panel-head h2');
  if (draftHead) draftHead.textContent = '01 / EDITOR’S DRAFT · 원고 작성';
  const factsHead = facts.querySelector('.panel-head h2');
  if (factsHead) factsHead.textContent = '02 / 팩트시트 + 팩트체크';
  factResults.querySelector('h2').textContent = '03 / 검색된 출처';
  const editHead = editorialPanel.querySelector('.panel-head h2');
  if (editHead) editHead.textContent = '04 / EDITORIAL REVIEW · 편집 검토';
  writing.append(draft);
  factcheck.append(facts, factResults, report, pairs);
  editing.append(editorialPanel);
  // 기존 사실 검수 결과 DOM은 renderIssues 호환용으로만 유지한다.
  sourcePanel.hidden = true;
  sourcePanel.classList.add('legacy-review-hidden');
  editing.append(sourcePanel);
  workspace.replaceChildren(writing, factcheck, editing);
}

setupEditorialWorkflow();

initialize();
