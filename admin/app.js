/**
 * TODAY'S ROCK - 관리자 편집기 화면 제어
 *
 * 서버와의 통신은 /local/* 경로만 사용한다.
 * 회원 세션과 CSRF 토큰을 사용합니다. API 비밀키는 이 파일에 넣지 않습니다.
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
  interpretation: '평론', // 예전 '해석·평가' 항목은 평론으로 표시
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
// 지금 편집 중인 뮤지션 ID. 서버 DB의 뮤지션별 원고·검토 기록과 짝을 이룹니다.
let currentArtist = 'jack-white';
// 아직 한 번도 저장하지 않은 새 뮤지션의 이름 정보 (첫 저장 때 서버로 보냅니다)
let pendingArtistInfo = null;
let reportExpanded = true;
let editorCsrf = '';

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
// 추출 오류 수정은 원고를 고치지 않습니다. 해당 팩트시트 버전에서만 적용합니다.
async function saveFactChange(payload, expectedSheetHash) {
  if (hasUnsavedChanges()) throw new Error('현재 원고를 먼저 저장하세요. 원고가 달라지면 팩트시트를 갱신한 뒤 수정해야 합니다.');
  const data = await post('/local/fact-edit', { ...payload, expectedSheetHash, article: currentArticle() });
  showState(data, false);
  message(payload.operation === 'exclude'
    ? '항목을 검증에서 제외했습니다. 다른 항목의 결과는 유지됩니다. 사실 검수를 갱신한 뒤 다시 승인하세요.'
    : payload.type === 'opinion'
      ? '평론으로 저장했습니다. 출처 검증에서 제외됩니다. 사실 검수를 갱신한 뒤 다시 승인하세요.'
      : '항목을 저장했습니다. 해당 항목의 검증 버튼을 누르세요. 다른 항목은 다시 조사하지 않습니다.');
}

function factEditForm(fact, expectedSheetHash) {
  const form = document.createElement('form'); form.className = 'fact-edit-form'; form.hidden = true;
  const field = document.createElement('select');
  for (const [value, text] of [['body', '본문'], ['title', '제목']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; field.append(option);
  }
  field.value = fact?.field || 'body';
  const type = document.createElement('select');
  for (const [value, text] of [['fact', '사실'], ['opinion', '평론 · 검증 제외']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; type.append(option);
  }
  type.value = fact?.type === 'opinion' ? 'opinion' : 'fact';
  const claim = document.createElement('textarea'); claim.rows = 3; claim.maxLength = 1500; claim.required = true; claim.value = fact?.claim || '';
  const excerpt = document.createElement('textarea'); excerpt.rows = 3; excerpt.maxLength = 6000; excerpt.required = true; excerpt.value = fact?.excerpt || '';
  const keywords = document.createElement('input'); keywords.value = (fact?.keywords || []).join(', '); keywords.placeholder = '예: Jack White, Detroit, 1997';
  const reason = document.createElement('input'); reason.maxLength = 600; reason.placeholder = '예: 주어를 잘못 연결함 / 평론을 사실로 추출함';
  for (const [title, control] of [['분류', type], ['원고 위치', field], ['검증할 주장', claim], ['원고 근거 문장 (원고에서 그대로 복사)', excerpt], ['검색어 (쉼표로 구분, 최대 12개)', keywords], ['변경 사유 (선택)', reason]]) {
    const label = document.createElement('label'); label.append(document.createTextNode(title), control); form.append(label);
  }
  form.append(element('p', '사실 항목을 수정하면 이 항목의 판정과 출처만 초기화됩니다. 원고 본문은 그대로입니다.', 'fact-edit-hint'));
  const save = element('button', fact ? '항목 수정 저장' : '새 항목 저장'); save.type = 'submit';
  const cancel = element('button', '취소'); cancel.type = 'button'; cancel.addEventListener('click', () => { form.hidden = true; });
  const actions = element('div', '', 'fact-edit-actions'); actions.append(save, cancel); form.append(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const payload = { operation: fact ? 'edit' : 'add', factId: fact?.id, type: type.value, field: field.value, claim: claim.value, excerpt: excerpt.value, keywords: keywords.value.split(',').map(s => s.trim()).filter(Boolean), reason: reason.value };
    run(() => saveFactChange(payload, expectedSheetHash));
  });
  return form;
}

function appendFactControls(card, fact, expectedSheetHash) {
  const tools = element('div', '', 'fact-edit-actions');
  const edit = element('button', '항목 수정 · 분류'); edit.type = 'button';
  const form = factEditForm(fact, expectedSheetHash);
  edit.addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('textarea').focus(); });
  tools.append(edit); card.append(tools, form);
  const exclude = document.createElement('details'); exclude.className = 'fact-exclude';
  const summary = document.createElement('summary'); summary.textContent = '검증 제외';
  const reason = document.createElement('input'); reason.maxLength = 600; reason.placeholder = '제외 이유: 중복 / 원고에 없는 주장 / 편집자 선정 목록 등'; reason.setAttribute('aria-label', `${fact.id} 제외 이유`);
  const button = element('button', '이유 기록 후 제외'); button.type = 'button';
  button.addEventListener('click', () => run(() => saveFactChange({operation:'exclude', factId:fact.id, reason:reason.value}, expectedSheetHash)));
  exclude.append(summary, reason, button); card.append(exclude);
  if (fact.manuallyEdited) card.append(element('p', '에디터가 수정한 추출 항목', 'fact-edit-hint'));
}

function renderFactTools(rows, sheet) {
  const header = $('fact-header-actions');
  header?.querySelector('.fact-header-extra')?.remove();
  document.querySelector('.fact-panel-hint')?.remove();
  if (!sheet || !header) return;
  const token = lastState?.factSheetHash;
  const actions = element('div', '', 'fact-header-extra');
  const add = element('button', '항목 추가'); add.type = 'button';
  const form = factEditForm(null, token);
  add.addEventListener('click', () => {
    if (rows.hidden) document.querySelector('.fact-fold-toggle')?.click();
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector('textarea').focus();
  });
  const review = element('button', '사실 검수 갱신'); review.type = 'button';
  review.addEventListener('click', () => run(async () => {
    if (hasUnsavedChanges()) throw new Error('현재 원고를 먼저 저장하세요.');
    if ((lastState?.factSheet?.facts || []).some(f => f.failureType === 'PENDING')) throw new Error('수정·추가한 사실 항목을 먼저 검증하세요.');
    message('기존 항목 결과로 사실 검수 보고서를 갱신하고 있습니다…');
    const data = await post('/local/review', { article: currentArticle() });
    showState(data, false); message('사실 검수를 갱신했습니다. 남은 지적을 확인한 뒤 다시 승인하세요.');
  }));
  actions.append(add, review); header.append(actions);
  rows.append(form);
  if (sheet.excludedFacts?.length) {
    const list = document.createElement('details'); list.className = 'fact-excluded-list';
    const summary = document.createElement('summary'); summary.textContent = `제외한 항목 ${sheet.excludedFacts.length}개 · 보기/복원`; list.append(summary);
    for (const record of sheet.excludedFacts) {
      const item = element('div', '', 'fact-excluded-item');
      item.append(element('strong', `${record.fact.id} · ${record.fact.claim}`), element('p', `제외 이유: ${record.reason}`));
      const restore = element('button', '항목 복원'); restore.type = 'button';
      restore.addEventListener('click', () => run(() => saveFactChange({operation:'restore', factId:record.fact.id, reason:'제외 항목 복원'}, token)));
      item.append(restore); list.append(item);
    }
    rows.append(list);
  }
}

function renderFacts(sheet) {
  const rows = $('fact-pairs');
  const scrollPane = rows.closest('.fact-workspace');
  const savedScroll = scrollPane?.scrollTop || 0;
  rows.replaceChildren();
  const facts = sheet?.facts || [];
  renderFactTools(rows, sheet);
  const verified = facts.filter(f => f.verificationStatus === 'VERIFIED');
  const opinions = facts.filter(f => f.verificationStatus === 'OPINION');
  const pending = facts.filter(f => f.failureType === 'PENDING');
  $('fact-count').textContent = sheet ? `${facts.length - pending.length}/${facts.length}개 조사 · ${verified.length}개 검증 완료${opinions.length ? ` · 평론 ${opinions.length}개` : ''}${sheet.truncated ? ' · 일부만 추출' : ''}` : '조사 전';
  renderReport($('fact-report'), lastState?.review?.report, facts);
  $('fact-check-count').textContent = sheet ? `${facts.length}개 항목` : '조사 전';
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

    appendFactControls(card, fact, lastState?.factSheetHash);
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
    if (fact.type !== 'opinion' && fact.verificationStatus !== 'OPINION' && fact.verificationStatus !== 'VERIFIED') {
      const retry = document.createElement('button');
      retry.type = 'button'; retry.textContent = fact.failureType === 'PENDING' ? '이 항목만 검증' : '이 항목 출처 재검색'; retry.className = 'fact-retry';
      retry.addEventListener('click', () => run(async () => {
        if (hasUnsavedChanges()) throw new Error('현재 원고를 먼저 저장해 주세요.');
        message(`${id} 출처를 다시 검색하고 있습니다…`);
        const data = await post('/local/research-one', { factId: id, article: currentArticle(), expectedSheetHash: lastState?.factSheetHash });
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
    const pair = element('div', '', 'fact-pair');
    const combined = element('div', '', 'fact-combined');
    // 검증 완료 항목은 초록 도장으로 한눈에 구분합니다.
    if (fact.verificationStatus === 'VERIFIED') stamp(combined);
    // 평론(의견) 항목은 검증 대상이 아니므로 회색 '평론' 도장으로 구분합니다.
    else if (fact.verificationStatus === 'OPINION' || fact.type === 'opinion') stamp(combined, 'gray');
    combined.append(card, result);
    pair.append(combined, sourceCard);
    rows.append(pair);
  }
  if (!facts.length) rows.append(element('p', '아직 추출된 사실이 없습니다. 원고 저장 후 팩트시트를 생성하세요.'));
  if (scrollPane) scrollPane.scrollTop = savedScroll;
}

// 편집자용 검수 보고서: 원고 주장 / 판정 / 근거 및 판단 표 + 전체 의견 + 수정 제안
// 판정 라벨은 서버가 팩트시트 상태로 정한 값이며, AI가 쓴 것은 설명 문장뿐입니다.
function renderReport(root, report, facts) {
  if (!root) return;
  root.replaceChildren();
  root.hidden = !facts.length;
  if (!facts.length) return;
  const box = document.createElement('details'); box.className = 'fact-report';
  box.open = reportExpanded;
  const summary = document.createElement('summary'); summary.textContent = '검수 보고서';
  const content = element('div', '', 'report-content'); content.id = 'report-content';
  box.addEventListener('toggle', () => { if (box.isConnected) reportExpanded = box.open; });
  box.append(summary, content);
  if (!report) {
    const pending = facts.some(f => f.failureType === 'PENDING');
    content.append(element('p', pending ? '모든 항목을 조사하면 검수 보고서가 만들어집니다.' : '검수 보고서가 아직 없습니다. 재검수를 실행하면 만들어집니다.', 'fact-reason'));
    root.append(box);
    return;
  }

  if (report.overall) content.append(element('p', report.overall, 'report-overall'));
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
  content.append(wrap);
  const corrections = report.corrections || [];
  content.append(element('h3', corrections.length ? `수정 제안 ${corrections.length}건` : '수정 제안 없음'));
  for (const item of corrections) {
    const card = element('div', '', 'issue');
    card.append(element('strong', `${koreanLabel(item.field)} · ${(item.factIds || []).join(', ')}`));
    card.append(element('p', `원문: ${item.text}`));
    card.append(element('p', `사유: ${item.problem}`));
    card.append(element('p', `수정 제안: ${item.suggestion}`));
    content.append(card);
  }
  root.append(box);
}

async function saveEditorialChange(payload, expectedReviewHash) {
  if (hasUnsavedChanges()) throw new Error('현재 원고를 먼저 저장하고 AI 편집 검토를 갱신하세요.');
  const fields = [$('title'), $('body')];
  const previous = fields.map(field => field.readOnly);
  fields.forEach(field => { field.readOnly = true; });
  try {
    const data = await post('/local/editorial-edit', { ...payload, expectedReviewHash, article: currentArticle() });
    showState(data, payload.operation === 'edit');
    message(payload.operation === 'edit'
      ? '수정문을 원고에 반영하고 처리 기록을 저장했습니다. 바뀐 원고의 사실 검수를 갱신한 뒤 승인하세요.'
      : payload.operation === 'pass'
        ? '에디터의 사유와 함께 패스했습니다. 남은 편집 의견을 확인하세요.'
        : '다시 검토할 항목으로 돌렸습니다. 현재 원고를 확인하고 수정 또는 패스하세요.');
  } finally {
    fields.forEach((field, index) => { field.readOnly = previous[index]; });
  }
}

function editorialForm(issue, operation, token, close) {
  const form = document.createElement('form'); form.className = 'editorial-human-form'; form.hidden = true;
  form.id = `editorial-${operation}-${issue.id}`;
  function label(text, control) {
    const wrapper = document.createElement('label');
    control.setAttribute('aria-label', `${issue.id} ${text}`);
    wrapper.append(document.createTextNode(text), control); form.append(wrapper);
  }
  let original, replacement, occurrence;
  if (operation === 'edit') {
    original = document.createElement('textarea'); original.rows = 3; original.maxLength = 6000; original.required = true; original.value = issue.currentText || issue.text || '';
    replacement = document.createElement('textarea'); replacement.rows = 3; replacement.maxLength = 15000; replacement.value = original.value;
    label('바꿀 부분 · 현재 원고에서 그대로 복사', original);
    label('수정문 · 비우면 해당 부분 삭제', replacement);
    occurrence = document.createElement('select');
    label('같은 문구 중 수정할 위치', occurrence);
    const note = element('p', '', 'editorial-form-note'); form.append(note);
    function findOccurrences() {
      const text = currentArticle()[issue.field] || '', excerpt = original.value;
      const positions = []; let start = 0;
      while (excerpt) {
        const index = text.indexOf(excerpt, start); if (index < 0) break;
        positions.push(index); start = index + excerpt.length;
      }
      occurrence.replaceChildren();
      if (positions.length > 1) {
        const placeholder = element('option', '수정할 위치를 선택하세요.'); placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true; occurrence.append(placeholder);
      }
      positions.forEach((position, index) => {
        const option = element('option', `${index + 1}번째 · ${text.slice(Math.max(0, position - 20), position + excerpt.length + 20).replace(/\s+/g, ' ')}`);
        option.value = String(index); occurrence.append(option);
      });
      occurrence.required = positions.length > 1;
      occurrence.parentElement.hidden = positions.length <= 1;
      note.textContent = !positions.length ? '일치하는 부분이 없습니다. 현재 원고에서 바꿀 부분을 그대로 복사하세요.'
        : positions.length > 1 ? `${positions.length}곳 중 선택한 한 곳만 수정합니다.` : '이 부분만 원고에 반영해 저장합니다. 변경된 원고의 사실 검수는 갱신해야 합니다.';
    }
    original.addEventListener('input', findOccurrences); findOccurrences();
  }
  const reason = document.createElement('textarea'); reason.rows = 2; reason.maxLength = 600; reason.required = true;
  reason.placeholder = operation === 'pass' ? '예: 에디터 코멘트의 의도된 구어체이므로 유지합니다.' : '예: 같은 내용의 반복을 줄이고 문장을 연결했습니다.';
  label(operation === 'pass' ? '패스 사유' : '수정 사유', reason);
  const actions = element('div', '', 'editorial-form-actions');
  const save = element('button', operation === 'pass' ? '사유 기록 후 패스' : '원고에 반영 · 수정 처리', 'primary'); save.type = 'submit';
  const cancel = element('button', '취소'); cancel.type = 'button'; cancel.addEventListener('click', close);
  actions.append(save, cancel); form.append(actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const payload = { operation, issueId: issue.id, reason: reason.value };
    if (operation === 'edit') Object.assign(payload, { text: original.value, replacement: replacement.value, occurrence: Number(occurrence.value || 0) });
    run(() => saveEditorialChange(payload, token));
  });
  return form;
}

// 통과한 칸에는 초록 APPROVED 도장, 평론 항목에는 회색 CRITIQUE 도장을 찍습니다.
// 그림은 style.css의 .stamped / .stamped-gray 규칙에 있습니다.
function stamp(node, tone = 'approved') {
  node.classList.add('stamped');
  node.classList.toggle('stamped-gray', tone === 'gray');
  node.dataset.stamp = tone === 'gray' ? 'CRITIQUE' : 'APPROVED';
}

function editorialActor(decision) {
  const actor = decision.actor || {};
  const role = actor.role === 'admin' ? '관리자' : '기자';
  const time = decision.at ? new Date(decision.at).toLocaleString('ko-KR') : '';
  return `${actor.displayName || '편집자'} · ${role}${time ? ' · ' + time : ''}`;
}

function editorialChange(event) {
  const change = document.createElement('details'); change.className = 'editorial-change';
  change.append(element('summary', '수정 전후 보기'));
  change.append(element('p', `수정 전: ${event.original}`, 'editorial-quote'), element('p', `수정 후: ${event.replacement || '(삭제)'}`, 'editorial-quote'));
  return change;
}

function editorialCard(issue, event = null) {
  const card = element('div', '', 'issue editorial-issue'); card.dataset.editorialIssue = issue.id;
  card.append(element('strong', `${issue.id} · ${koreanLabel(issue.field)} · ${koreanLabel(issue.category || 'editorial')}`));
  if (issue.text) card.append(element('p', `AI 검토 원문: ${issue.text}`, 'editorial-quote'));
  card.append(element('p', `AI 검토 사유: ${issue.reason}`), element('p', `AI 수정 제안: ${issue.suggestion}`));
  const token = lastState?.editorialReviewHash;
  if (issue.decision) {
    const decision = issue.decision;
    stamp(card);
    card.append(element('p', decision.status === 'edited' ? '수정 반영 완료' : '에디터 패스', 'editorial-decision'));
    card.append(element('p', `처리 사유: ${decision.reason}`), element('p', editorialActor(decision), 'editorial-form-note'));
    if (event?.operation === 'edit') card.append(editorialChange(event));
    const reopen = element('button', '다시 검토'); reopen.type = 'button';
    reopen.addEventListener('click', () => run(() => saveEditorialChange({ operation: 'reopen', issueId: issue.id }, token)));
    card.append(reopen);
  } else {
    const tools = element('div', '', 'editorial-tools');
    const controls = [];
    for (const [operation, title] of [['edit', '원고 수정'], ['pass', '패스']]) {
      const button = element('button', title); button.type = 'button'; button.setAttribute('aria-expanded', 'false');
      const close = () => { form.hidden = true; button.setAttribute('aria-expanded', 'false'); button.focus(); };
      const form = editorialForm(issue, operation, token, close);
      button.setAttribute('aria-controls', form.id);
      controls.push({ button, form }); tools.append(button);
      button.addEventListener('click', () => {
        const open = form.hidden;
        for (const control of controls) { control.form.hidden = true; control.button.setAttribute('aria-expanded', 'false'); }
        if (open) { form.hidden = false; button.setAttribute('aria-expanded', 'true'); form.querySelector('textarea').focus(); }
      });
    }
    card.append(tools, ...controls.map(control => control.form));
  }
  return card;
}

function renderEditorialReview(review) {
  const root = $('editorial-result');
  root.replaceChildren();
  if (!review) {
    $('editorial-count').textContent = '미검토';
    root.append(element('p', '현재 저장된 기사에 대한 검토 결과가 없습니다.'));
    return;
  }
  const issues = Array.isArray(review.issues) ? review.issues : [];
  const waiting = issues.filter(issue => !issue.decision), resolved = issues.filter(issue => issue.decision);
  const edited = resolved.filter(issue => issue.decision.status === 'edited').length;
  $('editorial-count').textContent = `대기 ${waiting.length} · 수정 ${edited} · 패스 ${resolved.length - edited}`;
  root.append(element('p', !issues.length ? 'AI가 지적한 문제가 없습니다. 편집자의 최종 확인을 마치세요.'
    : waiting.length ? 'AI 편집 의견을 확인하고 원고 수정 또는 사유를 남겨 패스하세요.'
      : '에디터가 편집 의견을 모두 처리했습니다. 사실 검수와 최종 출처 확인을 마치면 승인할 수 있습니다.', waiting.length ? 'editorial-summary' : 'ok'));
  if (review.aiArticleHash && review.aiArticleHash !== review.articleHash && !lastState?.state?.factCurrent) {
    root.append(element('p', '원고를 수정했습니다. 바뀐 원고의 팩트시트와 사실 검수를 갱신하세요.', 'editorial-summary'));
  }
  for (const issue of waiting) root.append(editorialCard(issue));
  const history = Array.isArray(review.manualHistory) ? review.manualHistory : [];
  const decisions = new Map(resolved.map(issue => [issue.id, issue.decision]));
  const latest = new Map();
  history.forEach((event, index) => {
    const decision = decisions.get(event.issueId);
    if (decision && event.reviewId === review.reviewId && event.at === decision.at
        && event.operation === (decision.status === 'edited' ? 'edit' : 'pass')) latest.set(event.issueId, index);
  });
  // 현재 처리 결과는 카드에서 한 번만 보여 주고, 그 전의 기록만 아래에 남깁니다.
  const shown = new Set(latest.values());
  const earlier = history.filter((event, index) => !shown.has(index));
  if (resolved.length || earlier.length) {
    const done = document.createElement('details'); done.className = 'editorial-resolved';
    done.append(element('summary', resolved.length ? `처리한 편집 의견 ${resolved.length}건 · 보기/다시 검토` : `처리한 편집 의견 · 이전 기록 ${earlier.length}건`));
    for (const issue of resolved) done.append(editorialCard(issue, history[latest.get(issue.id)]));
    if (earlier.length) {
      done.append(element('p', `이전 처리 기록 ${earlier.length}건${earlier.length > 20 ? ' · 최근 20건' : ''}`, 'editorial-record-heading'));
      const list = document.createElement('ol'); list.className = 'editorial-activity-list';
      for (const event of earlier.slice(-20).reverse()) {
        const item = document.createElement('li');
        const operation = { edit: '원고 수정', pass: '패스', reopen: '다시 검토' }[event.operation] || '처리';
        item.append(element('strong', `${event.issueId} · ${operation}`), element('p', editorialActor(event), 'editorial-form-note'), element('p', `사유: ${event.reason}`));
        if (event.issue?.text) item.append(element('p', `AI 검토 대상: ${event.issue.text}`, 'editorial-quote'));
        if (event.operation === 'edit') item.append(editorialChange(event));
        list.append(item);
      }
      done.append(list);
    }
    root.append(done);
  }
}

function showArticle(article) {
  $('title').value = article?.title || '';
  $('body').value = article?.body || '';
  lastSaved = currentArticle();
}

function showState(data, replaceArticle = true) {
  lastState = data;
  syncKorean(data);
  if (replaceArticle) showArticle(data.article);
  renderFacts(data.factSheet);
  renderEditorialReview(data.editorialReview);

  const approved = data.state?.approved === true;
  const published = data.state?.published === true;
  const hidden = data.state?.hidden === true;
  $('draft-status').textContent = approved ? '승인 완료' : '초안';
  $('approval-status').textContent = published ? (data.state?.isCurrent ? '승인 완료 · 홈 게시됨' : '승인 완료 · 아카이브 공개') : hidden ? '비공개' : approved ? '승인 완료 · 미게시' : '초안 · 미게시';
  const approvalPanel = document.querySelector('.approval-panel');
  if (approved) stamp(approvalPanel);
  else { approvalPanel.classList.remove('stamped'); delete approvalPanel.dataset.stamp; }
  $('confirm-sources').checked = false;
  $('export-article').disabled = !approved;
  $('publish').disabled = !approved;
  setPublishLook(published ? 'published' : hidden ? 'hidden' : approved ? 'ready' : 'locked');
  $('unpublish').hidden = !published;
  $('unpublish').disabled = !published;
  showPhoto(data.article);
}

// 등록된 뮤지션 사진을 작은 미리보기로 보여 줍니다.
function showPhoto(article) {
  const thumb = $('photo-thumb');
  if (article?.photo) {
    thumb.src = `/site/${article.photo}?v=${encodeURIComponent(article.photoUpdatedAt || '')}`;
    thumb.hidden = false;
    $('photo-status').textContent = `등록됨: ${article.photo}`;
  } else {
    thumb.removeAttribute('src');
    thumb.hidden = true;
    $('photo-status').textContent = '등록된 사진이 없습니다. (PNG·JPG·WEBP, 4MB 이하)';
  }
  const credit = $('photo-credit');
  if (document.activeElement !== credit) credit.value = photoCredit(article);
}

// 사진 출처('PHOTO | ' 뒤에 붙는 글자). 입력한 적 없는 잭 화이트 원고는 예전 표기를 씁니다. (publish.py와 같은 규칙)
function photoCredit(article) {
  if (!article) return '';
  if ('photoCredit' in article) return article.photoCredit || '';
  return (article.artist?.name || '').trim().toLowerCase() === 'jack white' ? 'AI-generated (OpenAI)' : '';
}

// ─────────────────────────────────────────────────────────────
// 3. 서버 통신과 버튼 중복 실행 방지
// ─────────────────────────────────────────────────────────────
// 서버 응답을 JSON으로 읽습니다. 서버 오류 페이지처럼 JSON이 아니어도 알아볼 수 있게 알려 줍니다.
async function readJson(response) {
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (response.status === 401) location.assign('/login?next=%2Feditor%2F');
  if (!response.ok) throw new Error(data.error || data.detail || `서버 응답 오류 (HTTP ${response.status})`);
  return data;
}

async function post(endpoint, payload = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': editorCsrf },
    body: JSON.stringify({ ...payload, artist: currentArtist })
  });
  return readJson(response);
}

// 작업 중(팩트시트·출처 검증·편집 검토 등)에는 화면 전체를 투명한 막으로 덮습니다.
//  - 막 위에서는 커서가 어디서든 대기(모래시계) 모양으로 바뀝니다.
//  - 클릭과 키 입력을 막아, 작업 중에 새로 그려진 버튼(예: '이 항목만 검증')을
//    눌러 다른 작업이 겹쳐 시작되거나 진행 중인 작업이 끊기지 않게 합니다.
//  - 스크롤은 그대로 되므로 진행 상황은 계속 볼 수 있습니다.
let busy = false;
const busyShield = document.createElement('div');
busyShield.className = 'busy-shield';
busyShield.hidden = true;
busyShield.setAttribute('aria-hidden', 'true');
document.body.append(busyShield);

function setBusy(on) {
  busy = on;
  busyShield.hidden = !on;
  document.documentElement.classList.toggle('is-busy', on);
  document.body.setAttribute('aria-busy', String(on));
  if (on && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

// 작업 중에는 스크롤 키만 허용하고, 그 밖의 키 입력(Enter·Space·글자 입력 등)은 막습니다.
const SCROLL_KEYS = ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];
document.addEventListener('keydown', (event) => {
  if (busy && !SCROLL_KEYS.includes(event.key)) { event.preventDefault(); event.stopPropagation(); }
}, true);

// 작업 중에 창을 닫거나 새로고침하면 한 번 더 묻습니다.
window.addEventListener('beforeunload', (event) => {
  if (busy) { event.preventDefault(); event.returnValue = ''; }
});

async function run(task) {
  if (busy) return;   // 이미 작업 중이면 새 작업을 시작하지 않습니다.
  setBusy(true);
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  $('artist-select').disabled = true;
  try {
    await task();
  } catch (error) {
    message(`오류: ${error.message}`);
  } finally {
    buttons.forEach((button) => { button.disabled = ['export-article', 'publish'].includes(button.id) ? (!lastState?.state?.approved || hasUnsavedChanges()) : false; });
    markKorean();   // '한국 뮤지션' 저장 버튼은 바뀐 내용이 있을 때만 켭니다.
    $('artist-select').disabled = false;
    setBusy(false);
  }
}

async function getJson(url) {
  return readJson(await fetch(url, { cache: 'no-store' }));
}

const artistQuery = () => `artist=${encodeURIComponent(currentArtist)}`;

function rememberArtist(id) {
  try { localStorage.setItem('editor-artist', id); } catch { /* 저장 불가 환경은 무시 */ }
}

function recalledArtist() {
  try { return localStorage.getItem('editor-artist'); } catch { return null; }
}

// 저장된 뮤지션 목록으로 선택 상자를 채웁니다. extra는 아직 저장 전인 새 뮤지션입니다.
async function loadArtists(extra = null) {
  const { artists } = await getJson('/local/artists');
  const list = [...artists];
  if (extra && !list.some((a) => a.id === extra.id)) list.push(extra);
  if (!list.some((a) => a.id === currentArtist)) list.push({ id: currentArtist, name: currentArtist, nameKo: '' });
  const select = $('artist-select');
  select.replaceChildren(...list.map((a) => {
    const option = document.createElement('option');
    option.value = a.id;
    option.textContent = a.nameKo ? `${a.nameKo} (${a.name})` : a.name;
    return option;
  }));
  select.value = currentArtist;
  return list;
}

async function loadArtist(id) {
  currentArtist = id;
  rememberArtist(id);
  const data = await getJson(`/local/data?${artistQuery()}`);
  showState(data);
  $('artist-select').value = id;
}

async function initialize() {
  try {
    const account = await getJson('/api/auth/me');
    if (!account.user) { location.assign('/login?next=%2Feditor%2F'); return; }
    if (!account.user.canEdit) { location.assign('/mypage'); return; }
    editorCsrf = account.csrfToken;
    document.querySelector('.local').textContent = `${account.user.displayName} · ${account.user.roleLabel}`;
    const accountLink = document.createElement('a');
    accountLink.href = account.user.isAdmin ? '/admin/' : '/mypage';
    accountLink.textContent = account.user.isAdmin ? '관리자 페이지 ↗' : '마이페이지 ↗';
    accountLink.className = 'account-return';
    document.querySelector('.topbar').append(accountLink);
    const artists = (await getJson('/local/artists')).artists;
    const saved = recalledArtist();
    if (saved && artists.some((a) => a.id === saved)) currentArtist = saved;
    else if (artists.length && !artists.some((a) => a.id === currentArtist)) currentArtist = artists[0].id;
    await loadArtists();
    await loadArtist(currentArtist);
    message('로컬 기사와 검토 기록을 불러왔습니다.');
  } catch (error) {
    message(`불러오기 실패: ${error.message}`);
  }
}

$('artist-select').addEventListener('change', (event) => run(async () => {
  const next = event.target.value;
  if (hasUnsavedChanges() && !confirm('저장하지 않은 원고가 있습니다. 다른 뮤지션으로 이동할까요?')) {
    event.target.value = currentArtist;
    return;
  }
  pendingArtistInfo = null;
  await loadArtist(next);
  message('뮤지션을 바꿨습니다. 이 뮤지션의 원고와 검토 기록을 불러왔습니다.');
}));

// '한국 뮤지션' 체크 + 저장 버튼
// 체크 표시는 항상 서버에 저장된 값(현재 뮤지션의 원고 정보)에서 다시 그립니다.
// 뮤지션을 바꾸면 그 뮤지션의 값으로 바뀌고, 체크만 바꾼 상태에서는 '저장' 버튼이 켜집니다.
let savedKorean = false;
function syncKorean(data) {
  savedKorean = pendingArtistInfo ? Boolean(pendingArtistInfo.korean) : data?.article?.artist?.korean === true;
  $('artist-korean').checked = savedKorean;
  markKorean();
}
function markKorean() {
  const button = $('artist-korean-save');
  const dirty = $('artist-korean').checked !== savedKorean;
  button.disabled = !dirty;
  button.textContent = dirty ? '저장' : '저장됨';
  button.classList.toggle('primary', dirty);
}
$('artist-korean').addEventListener('change', markKorean);
$('artist-korean-save').addEventListener('click', () => run(async () => {
  const korean = $('artist-korean').checked;
  if (pendingArtistInfo) {            // 아직 저장 전인 새 뮤지션은 초안 저장 때 함께 저장됩니다.
    pendingArtistInfo.korean = korean;
    savedKorean = korean; markKorean();
    message('새 뮤지션이라 초안을 저장할 때 함께 저장됩니다.');
    return;
  }
  const data = await post('/local/artist-info', { korean });
  showState(data, false);
  await loadArtists();
  message(korean ? "한국 뮤지션으로 저장했습니다. 아카이브에는 '한글 (영문)' 순서로 보입니다." : "한국 뮤지션 표시를 껐습니다. 아카이브에는 '영문 (한글)' 순서로 보입니다.");
}));

$('artist-new').addEventListener('click', () => {
  $('artist-new-form').hidden = !$('artist-new-form').hidden;
});

// 영문 이름에서 파일 ID 후보를 자동으로 만듭니다 (직접 고쳐도 됩니다).
$('artist-new-name').addEventListener('input', () => {
  const id = $('artist-new-id');
  if (id.dataset.edited) return;
  id.value = $('artist-new-name').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
});
$('artist-new-id').addEventListener('input', () => { $('artist-new-id').dataset.edited = '1'; });

$('artist-new-add').addEventListener('click', () => run(async () => {
  const name = $('artist-new-name').value.trim();
  const nameKo = $('artist-new-nameko').value.trim();
  const id = $('artist-new-id').value.trim().toLowerCase();
  const korean = $('artist-new-korean').checked;
  if (!name) throw new Error('영문 이름을 입력해 주세요.');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || id.length > 50) throw new Error('파일 ID는 영문 소문자·숫자·하이픈만 쓸 수 있습니다. 예: kim-yuna');
  if (hasUnsavedChanges() && !confirm('저장하지 않은 원고가 있습니다. 새 뮤지션으로 이동할까요?')) return;
  const existing = (await getJson('/local/artists')).artists;
  if (existing.some((a) => a.id === id)) throw new Error('이미 있는 파일 ID입니다. 목록에서 선택해 주세요.');
  pendingArtistInfo = { name, nameKo, korean };
  await loadArtists({ id, name, nameKo, korean });
  await loadArtist(id);
  $('artist-new-form').hidden = true;
  for (const field of ['artist-new-name', 'artist-new-nameko', 'artist-new-id']) $(field).value = '';
  $('artist-new-korean').checked = false;
  delete $('artist-new-id').dataset.edited;
  message(`새 뮤지션 '${nameKo || name}'을 추가했습니다. 원고를 쓰고 초안 저장을 누르면 파일이 만들어집니다.`);
}));

// 선택한 뮤지션 삭제: 공개 중인 기사·저장소 기본 원고는 서버가 거절합니다.
$('artist-delete').addEventListener('click', () => run(async () => {
  const deleting = currentArtist;
  const label = $('artist-select').selectedOptions[0]?.textContent || deleting;
  const { artists } = await getJson('/local/artists');
  const saved = artists.some((a) => a.id === deleting);
  if (!confirm(saved
    ? `'${label}'을(를) 삭제할까요?\n\n원고·팩트시트·검토·승인 기록과 등록한 사진이 모두 지워지며 편집실에서 되돌릴 수 없습니다.\n(삭제 직전 기록은 서버 백업에 남습니다.)`
    : `'${label}'은(는) 아직 저장하지 않은 뮤지션입니다. 목록에서 뺄까요?`)) return;
  let remaining = artists;
  if (saved) remaining = (await post('/local/artist-delete', { confirm: deleting })).artists;
  pendingArtistInfo = null;
  currentArtist = remaining.find((a) => a.id !== deleting)?.id || 'jack-white';
  await loadArtists();
  await loadArtist(currentArtist);
  message(saved ? `'${label}'을(를) 삭제했습니다.` : `'${label}'을(를) 목록에서 뺐습니다.`);
}));

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
  const data = await post('/local/save', { article: currentArticle(), artistInfo: pendingArtistInfo });
  pendingArtistInfo = null;
  showState(data);
  await loadArtists();
  message('초안 저장 완료. 수정한 원고는 사실 검수와 편집 검토를 다시 받아야 합니다.');
}));

$('recheck').addEventListener('click', () => run(async () => {
  if (hasUnsavedChanges()) throw new Error('먼저 초안 저장을 눌러 주세요.');
  if ((lastState?.editorialReview?.manualRevision || 0) > 0 && !confirm('AI 편집 검토를 새로 실행할까요? 처리 이력은 남고, 새 검토의 의견은 다시 확인해야 합니다.')) return;
  message('사실 검수와 편집 검토를 순서대로 실행하고 있습니다…');
  const data = await post('/local/recheck', { article: currentArticle() });
  showState(data, false);
  message('사실 검수와 편집 검토가 완료됐습니다.');
}));

$('editorial').addEventListener('click', () => run(async () => {
  if (hasUnsavedChanges()) throw new Error('먼저 초안 저장을 눌러 주세요.');
  if ((lastState?.editorialReview?.manualRevision || 0) > 0 && !confirm('AI 편집 검토를 새로 실행할까요? 처리 이력은 남고, 새 검토의 의견은 다시 확인해야 합니다.')) return;
  message('AI 편집 검토를 진행하고 있습니다…');
  const data = await post('/local/editorial', { article: currentArticle() });
  showState(data, false);
  message('AI 편집 검토가 완료됐습니다.');
}));

// ─────────────────────────────────────────────────────────────
// 5. 사람의 명시적 최종 승인 (승인만으로는 홈에 게시되지 않음)
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
      $('publish').disabled = true;
      setPublishLook('unsaved');
    } else if (lastState) {
      showState(lastState, false); // 저장된 내용으로 되돌리면 원래 상태 표시로 돌아갑니다.
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 6. 기사 미리보기·승인 기사 내보내기·사진 등록·홈 게시
// ─────────────────────────────────────────────────────────────

// 공개 기사 템플릿과 CSS를 사용하되 편집 중인 텍스트만 안전하게 삽입합니다.
async function renderPreview() {
  const article = currentArticle();
  if (!article.title.trim() || !article.body.trim()) throw new Error('미리보기할 기사 제목과 본문이 필요합니다.');
  const response = await fetch('/site/artist-jack-white.html', { cache: 'no-store' });
  if (!response.ok) throw new Error('홈페이지 기사 디자인을 불러오지 못했습니다.');
  const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
  doc.querySelectorAll('script').forEach(n => n.remove());
  // srcdoc의 상대 주소를 로컬 서버가 제공하는 공개 사이트 자산으로 연결합니다.
  doc.querySelectorAll('[href], [src]').forEach(n => {
    for (const attr of ['href', 'src']) {
      const value = n.getAttribute(attr);
      if (value && !/^(https?:|#)/i.test(value)) n.setAttribute(attr, '/site/' + value.replace(/^\.\//, ''));
    }
  });
  const sections = {intro: [], history: [], comment: [], tracks: []};
  let section = 'intro';
  for (const line of article.body.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    if (/^주요 앨범과 활동$/.test(line)) section = 'history';
    else if (/^(에디터 코멘트|EDITOR['’]S COMMENT)$/i.test(line)) section = 'comment';
    else if (/^대표곡$/.test(line)) section = 'tracks';
    else sections[section].push(line);
  }
  const name = lastState?.article?.artist || pendingArtistInfo || { name: 'Jack White', nameKo: '잭 화이트' };
  // 등록된 뮤지션 사진으로 바꿉니다. (사진이 없으면 템플릿 사진이 그대로 보입니다)
  const photoImg = doc.querySelector('.artist-feature-photo img');
  const photo = lastState?.article?.photo;
  if (photoImg && photo) {
    photoImg.src = `/site/${photo}?v=${encodeURIComponent(lastState.article.photoUpdatedAt || '')}`;
    photoImg.alt = name.nameKo || name.name || article.title;
  }
  // 사진 출처: 입력한 출처로 바꾸고, 비어 있으면 출처 표시를 뺍니다.
  const figure = doc.querySelector('.artist-feature-photo');
  const creditText = $('photo-credit').value.replace(/\s+/g, ' ').trim().replace(/^PHOTO\s*[|:·]?\s*/i, '').trim();
  let caption = figure?.querySelector('.artist-photo-credit');
  if (figure && creditText) {
    if (!caption) {
      caption = doc.createElement('figcaption');
      caption.className = 'artist-photo-credit';
      figure.append(caption);
    }
    caption.textContent = `PHOTO | ${creditText}`;
  } else if (caption) caption.remove();
  const normalizeName = v => v.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const first = normalizeName(sections.intro[0] || '');
  if ([name.name, name.nameKo, `${name.nameKo}${name.name}`, `${name.name}${name.nameKo}`].filter(Boolean).some(v => normalizeName(v) === first)) sections.intro.shift();
  doc.querySelector('.artist-name-main').textContent = name.name || article.title;
  doc.querySelector('.artist-name-sub').textContent = name.nameKo || '';
  doc.querySelector('.artist-feature-lead').textContent = sections.intro.shift() || article.title;
  const copy = doc.querySelector('.artist-copy');
  const paragraphs = sections.intro.map(text => {
    const p = doc.createElement('p'); p.className = 'artist-copy'; p.textContent = text; return p;
  });
  copy.replaceWith(...paragraphs);
  const comment = doc.querySelector('.artist-feature-editor');
  comment.querySelectorAll('p:not(.section-label)').forEach(n => n.remove());
  sections.comment.forEach(text => { const p = doc.createElement('p'); p.textContent = text; comment.append(p); });
  comment.hidden = !sections.comment.length;
  const history = doc.querySelector('.artist-feature-history'); history.replaceChildren();
  // 활동 제목에서 앨범명만 이탤릭(<em>)으로 표시합니다.
  // 규칙: 'N집 앨범명 (연도)', '솔로 앨범명 (연도)', '밴드 – 앨범명 (연도)' 형식일 때 앨범명 부분.
  const ALBUM = /^(.*(?:\d+집|솔로|EP|싱글)\s+|.+\s[–—−-]\s+)(.+?)(\s*\(\d{4}[^)]*\))$/;
  // 활동 항목은 게시(publish.py)와 같은 규칙으로 읽습니다.
  //   한 줄 형식: '제목: 설명'   두 줄 형식: '제목' 다음 줄에 '설명'
  const historyItems = [];
  for (const text of sections.history) {
    const split = text.indexOf(':');
    const last = historyItems[historyItems.length - 1];
    if (split >= 0) historyItems.push({ title: text.slice(0, split).trim(), desc: text.slice(split + 1).trim() });
    else if (last && last.desc === null) last.desc = text;
    else historyItems.push({ title: text, desc: null });
  }
  historyItems.forEach(({ title, desc }) => {
    const li = doc.createElement('li');
    const strong = doc.createElement('strong');
    const album = title.match(ALBUM);
    if (album) {
      const em = doc.createElement('em'); em.textContent = album[2];
      strong.append(album[1], em, album[3]);
    } else strong.textContent = title;
    li.append(strong);
    if (desc) { const p = doc.createElement('p'); p.textContent = desc; li.append(p); }
    history.append(li);
  });
  const tracks = doc.querySelector('.artist-feature-tracks'); tracks.replaceChildren();
  sections.tracks.forEach(text => {
    const li = doc.createElement('li'), link = doc.createElement('a'), label = doc.createElement('span');
    link.href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(text);
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    const parts = text.split(/\s+[–—−-]\s+/);
    const strong = doc.createElement('strong'); strong.textContent = parts.shift();
    label.append(strong);
    if (parts.length) { const small = doc.createElement('small'); small.textContent = parts.join(' – '); label.append(small); }
    const arrow = doc.createElement('span'); arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
    link.append(label, arrow); li.append(link); tracks.append(li);
  });
  // 출처: 템플릿(잭 화이트)의 출처는 비우고, 이 원고의 팩트시트에서
  // '검증됨(VERIFIED)'인 출처만 모아 "SOURCES | 매체 ↗ · 매체 ↗" 형식으로 채웁니다.
  const sourceBox = doc.querySelector('.artist-feature-sources');
  if (sourceBox) {
    const picked = new Map(); // 매체 이름 → 첫 번째 주소 (같은 매체는 한 번만)
    for (const fact of lastState?.factSheet?.facts || []) {
      if (fact.type === 'opinion' || fact.type === 'interpretation') continue;
      const list = Array.isArray(fact.sources) && fact.sources.length ? fact.sources : (fact.source ? [fact.source] : []);
      for (const source of list) {
        if ((source.verificationStatus || fact.verificationStatus) !== 'VERIFIED') continue;
        let url;
        try { url = new URL(source.url); } catch { continue; }
        if (url.protocol !== 'https:') continue;
        // "경향신문 (Khan)" → "경향신문"처럼 괄호 설명은 떼고 표시합니다.
        const label = (source.publisher || url.hostname.replace(/^www\./, '')).split(/\s+[(\-–]/)[0].trim();
        if (!picked.has(label)) picked.set(label, url.href);
      }
    }
    sourceBox.replaceChildren('SOURCES');
    for (const [label, href] of picked) {
      const a = doc.createElement('a');
      a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = `${label} ↗`;
      sourceBox.append(sourceBox.childNodes.length > 1 ? ' · ' : ' | ', a);
    }
    sourceBox.hidden = picked.size === 0; // 검증된 출처가 없으면 줄 자체를 숨깁니다.
  }
  doc.querySelector('.archive-back-link')?.closest('p')?.remove();
  doc.querySelector('.artist-feature > h2').textContent = '오늘의 뮤지션';
  doc.querySelector('.artist-feature > .section-label').textContent = "TODAY'S MUSICIAN";
  doc.title = article.title.trim() + ' — 미리보기';
  const frame = $('preview-frame');
  frame.onload = () => {
    frame._resizeObserver?.disconnect();
    const preview = frame.contentDocument;
    if (!preview) return;
    const fit = () => {
      const main = preview.querySelector('main');
      if (!main) return;
      const height = Math.ceil(main.getBoundingClientRect().bottom + 60);
      if (height > 0 && frame.style.height !== `${height}px`) frame.style.height = `${height}px`;
    };
    frame._resizeObserver = new ResizeObserver(fit);
    frame._resizeObserver.observe(preview.querySelector('main'));
    preview.querySelectorAll('img').forEach(img => img.addEventListener('load', fit, { once: true }));
    preview.fonts.ready.then(fit);
    fit();
  };
  frame.setAttribute('scrolling', 'no');
  frame.srcdoc = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  $('preview-panel').hidden = false;
  $('preview-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('preview-open').addEventListener('click', () => run(async () => {
  await renderPreview();
  message('홈페이지 디자인으로 미리보기를 열었습니다. 저장 전 수정 내용도 반영됩니다.');
}));

$('preview-close').addEventListener('click', () => {
  $('preview-panel').hidden = true;
});

// 서버가 저장된 원고의 승인 상태를 다시 검증한 후에만 내보냅니다.
// 브라우저에 저장된 이전 승인 상태만 믿고 JSON을 만들지 않습니다.
$('export-article').addEventListener('click', () => run(async () => {
  if (hasUnsavedChanges()) throw new Error('현재 수정한 원고를 먼저 저장하고 재검토하세요.');

  const result = await getJson(`/local/publication-export?${artistQuery()}`);

  const blob = new Blob([`${JSON.stringify(result, null, 2)}\n`], {
    type: 'application/json;charset=utf-8'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${currentArtist}-approved.json`;
  link.click();
  URL.revokeObjectURL(url);
  message('승인된 기사 JSON을 내보냈습니다. 실제 게시는 별도 작업입니다.');
}));

// 뮤지션 사진 등록: 고른 파일을 그대로 서버에 보냅니다.
$('photo-file').addEventListener('change', () => run(async () => {
  const input = $('photo-file');
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('사진은 4MB 이하로 올려 주세요. 가로 1600px 정도로 줄이면 충분합니다.');
    message('뮤지션 사진을 저장하고 있습니다…');
    const response = await fetch(`/local/photo?${artistQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF-Token': editorCsrf },
      body: file
    });
    showState(await readJson(response), false);
    message('뮤지션 사진을 등록했습니다. 미리보기와 홈 게시에 이 사진이 쓰입니다.');
  } finally {
    input.value = '';
  }
}));

// 사진 출처: 입력을 마치면(Enter 또는 칸 밖 클릭) 저장합니다. 미리보기와 홈 게시에 'PHOTO | 출처'로 표시됩니다.
$('photo-credit').addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); event.target.blur(); }
});
$('photo-credit').addEventListener('change', () => run(async () => {
  const input = $('photo-credit');
  const credit = input.value.replace(/\s+/g, ' ').trim();
  if (credit === photoCredit(lastState?.article)) return;
  try {
    showState(await post('/local/photo-credit', { credit }), false);
    message(credit
      ? (lastState?.state?.published ? '사진 출처를 저장했습니다. 이미 게시된 기사는 홈 게시를 다시 하면 반영됩니다.' : '사진 출처를 저장했습니다.')
      : '사진 출처를 지웠습니다. 출처 표시 없이 게시됩니다.');
  } catch (error) {
    input.value = photoCredit(lastState?.article);
    throw error;
  }
}));

// 06 홈 게시 버튼의 글자와 색을 상태에 맞게 바꿉니다.
// (켜고 끄는 disabled 처리는 기존 코드가 그대로 담당합니다)
function setPublishLook(mode) {
  const looks = {
    locked: ['홈에 게시', '편집자 승인 후 사용할 수 있습니다.'],
    unsaved: ['홈에 게시', '수정한 원고를 저장하고 다시 승인해야 합니다.'],
    ready: ['홈에 게시 ↗', '오늘의 뮤지션을 이 기사로 바꾸고,\n이전 기사는 아카이브로 옮깁니다.'],
    published: ['게시 완료', '공개 중인 기사입니다.\n다시 누르면 대표 기사로 재게시합니다.'],
    hidden: ['다시 공개 ↗', '이 기사를 대표 기사로 다시 공개합니다. 기존 대표 기사는 아카이브로 옮깁니다.'],
  };
  const [title, note] = looks[mode] || looks.locked;
  $('publish-title').textContent = title;
  $('publish-note').textContent = note;
  $('publish').classList.toggle('is-published', mode === 'published');
}

$('unpublish').addEventListener('click', () => run(async () => {
  if (!confirm('이 기사를 비공개로 전환할까요? 대표 기사라면 직전 공개 기사가 자동 복원됩니다.')) return;
  const data = await post('/local/unpublish');
  showState(data, false);
  message(data.publishResult?.restored ? '비공개 처리했습니다. 직전 공개 기사가 대표 기사로 복원됐습니다.' : '비공개 처리했습니다.');
}));

// 홈에 게시: 서버가 승인 상태를 다시 확인한 뒤 index.html과 아카이브를 바꿉니다.
$('publish').addEventListener('click', () => run(async () => {
  if (hasUnsavedChanges()) throw new Error('현재 수정한 원고를 먼저 저장하고 재검토하세요.');
  if (!lastState?.article?.photo) throw new Error('게시하려면 먼저 뮤지션 사진을 등록하세요.');
  if (!confirm('이 기사를 홈의 오늘의 뮤지션으로 게시할까요?\n지금 홈에 있는 기사는 지난 뮤지션 아카이브로 옮겨집니다.')) return;
  const data = await post('/local/publish');
  showState(data, false);
  const r = data.publishResult || {};
  message(`홈에 게시했습니다.${r.archived ? ` 이전 기사는 ${r.archived}로 옮겼습니다.` : ''} 홈 화면을 새로고침해 확인하세요.`);
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
  const factWorkspace = element('section', '', 'fact-workspace');
  factWorkspace.setAttribute('aria-label', '팩트시트와 검증 출처');
  factWorkspace.tabIndex = 0;
  const editing = document.createElement('div'); editing.className = 'workflow-editing';
  const factResults = document.createElement('section');
  factResults.className = 'panel fact-check-panel';
  const head = document.createElement('div'); head.className = 'panel-head';
  head.append(element('h2', '02 / 팩트체크 · 검증'));
  const count = element('span', '—'); count.id = 'fact-check-count'; head.append(count);
  factResults.append(head);
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
  // 02·03 제목 상자는 한 묶음으로 큰 상자 맨 위에 고정합니다. (CSS .fact-workspace-head)
  const factHead = element('div', '', 'fact-workspace-head');
  // 02·03 아래, 큰 상자 바닥에 항목 전체를 접고 펴는 글자 토글을 둡니다.
  const foldToggle = element('button', '▼ 접기', 'fact-fold-toggle');
  foldToggle.type = 'button';
  foldToggle.setAttribute('aria-expanded', 'true');
  foldToggle.setAttribute('aria-controls', 'fact-pairs');
  foldToggle.addEventListener('click', () => {
    pairs.hidden = !pairs.hidden;
    foldToggle.textContent = pairs.hidden ? '▶ 펼치기' : '▼ 접기';
    foldToggle.setAttribute('aria-expanded', String(!pairs.hidden));
  });
  factHead.append(facts, factResults, foldToggle);
  factWorkspace.append(factHead, pairs);
  factcheck.append(report, factWorkspace);
  // 02 상자 오른쪽 위: '항목 추가'·'사실 검수 갱신' 버튼 자리 (renderFactTools가 채움)
  const controls = element('div', '', 'fact-header-actions'); controls.id = 'fact-header-actions';
  facts.querySelector('.panel-head').append(controls);
  editing.append(editorialPanel);
  // 기존 사실 검수 결과 DOM은 예전 화면 배치와의 호환을 위해 유지한다.
  sourcePanel.hidden = true;
  sourcePanel.classList.add('legacy-review-hidden');
  editing.append(sourcePanel);
  const reviewColumn = element('div', '', 'workflow-review-column');
  reviewColumn.append(factcheck, editing);
  workspace.replaceChildren(writing, reviewColumn);
  matchFactBoxHeight(draft, factWorkspace);
}

// 02+03 상자의 세로 길이를 01 원고 작성 상자와 똑같이 맞춥니다.
// 항목을 접었을 때와 한 열로 쌓이는 좁은 화면에서는 맞추지 않고 내용 높이만큼 줄어듭니다.
function matchFactBoxHeight(draft, box) {
  const narrow = window.matchMedia('(max-width: 750px)');
  const pairs = box.querySelector('.fact-pairs');
  const sync = () => {
    if (narrow.matches || pairs?.hidden) {
      box.style.height = '';
      box.style.maxHeight = '';
    } else {
      box.style.height = `${draft.offsetHeight}px`;
      box.style.maxHeight = 'none';
    }
  };
  new ResizeObserver(sync).observe(draft);
  narrow.addEventListener('change', sync);
  if (pairs) new MutationObserver(sync).observe(pairs, { attributes: true, attributeFilter: ['hidden'] });
  sync();
}

setupEditorialWorkflow();

initialize();


