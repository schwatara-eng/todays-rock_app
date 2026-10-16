const $ = id => document.getElementById(id);
let lastSaved = { title: '', body: '' };
function msg(text) { $('status').textContent = text; }
function clear(el) { el.replaceChildren(); }
function textNode(tag, text, cls) { const e = document.createElement(tag); e.textContent = text; if (cls)
    e.className = cls; return e; }
function renderFacts(sheet) { const root = $('facts'); clear(root); const facts = sheet.facts || []; $('fact-count').textContent = `${facts.filter(f => f.verificationStatus === 'verified').length} VERIFIED`; for (const f of facts) {
    const box = textNode('div', '', 'fact');
    box.append(textNode('div', `${f.id} · ${f.verificationStatus}`, 'fact-id'));
    box.append(textNode('p', f.claim));
    if (f.source?.url?.startsWith('https://')) {
        const a = document.createElement('a');
        a.href = f.source.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = f.source.publisher || '출처 보기';
        box.append(a);
    }
    root.append(box);
} }
function renderReview(r) { const root = $('review-result'); clear(root); if (!r) {
    root.append(textNode('p', '검수 결과가 없습니다.'));
    $('issue-count').textContent = '—';
    return;
} const issues = Array.isArray(r.issues) ? r.issues : []; $('issue-count').textContent = `${issues.length} ISSUES`; if (!issues.length)
    root.append(textNode('p', 'AI가 지적한 문제가 없습니다. 편집자 검토는 여전히 필요합니다.', 'ok')); for (const i of issues) {
    const box = textNode('div', '', 'issue');
    box.append(textNode('strong', `${i.field} · ${i.verdict}`));
    box.append(textNode('p', i.text));
    box.append(textNode('p', `사유: ${i.reason}`));
    box.append(textNode('p', `수정 제안: ${i.suggestion}`));
    root.append(box);
} root.append(textNode('p', '게시 상태: 미게시 / 편집자 승인 전', 'notice')); }
function current() { return { title: $('title').value, body: $('body').value }; }
function showArticle(a) { $('title').value = a?.title || ''; $('body').value = a?.body || ''; lastSaved = current(); }
async function request(url, payload) { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const d = await r.json(); if (!r.ok)
    throw Error(d.error || `HTTP ${r.status}`); return d; }
async function busy(task) { const buttons = [...document.querySelectorAll('button')]; buttons.forEach(b => b.disabled = true); try {
    await task();
}
catch (e) {
    msg(`오류: ${e.message}`);
}
finally {
    buttons.forEach(b => b.disabled = false);
} }
async function init() { try {
    const r = await fetch('/local/data');
    const d = await r.json();
    if (!r.ok)
        throw Error(d.error);
    renderFacts(d.factSheet);
    showArticle(d.article);
    renderReview(d.review);
    msg('로컬 기사 파일을 불러왔습니다.');
}
catch (e) {
    msg(`불러오기 실패: ${e.message}`);
} }
$('generate').addEventListener('click', () => busy(async () => { if ((current().title !== lastSaved.title || current().body !== lastSaved.body) && !confirm('편집 중인 내용이 사라질 수 있습니다. AI 초안으로 덮어쓸까요?'))
    return; msg('AI가 기사를 생성하고 검수하고 있습니다…'); const d = await request('/local/generate', {}); showArticle(d.article); renderReview(d.review); msg('AI 초안 생성 및 검수 완료. 로컬 파일에 저장됐습니다.'); }));
$('review').addEventListener('click', () => busy(async () => { msg('현재 편집 내용을 AI가 검수하고 있습니다…'); const d = await request('/local/review', { article: current() }); renderReview(d.review); msg('AI 재검수 완료. 편집 중인 글은 아직 저장되지 않았습니다.'); }));
$('save').addEventListener('click', () => busy(async () => { const d = await request('/local/save', { article: current() }); showArticle(d.article); renderReview(null); msg('초안을 저장했습니다. 검수 결과는 수정 전 것일 수 있으므로 재검수하세요.'); }));
init();

