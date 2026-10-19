"""외부 AI 호출 없이 사람의 편집 처리와 승인 버전 검사를 검증한다."""
import asyncio
import copy
import pytest
from editor_python import ai, editorial_edit, fact_edit, routes


USER = {'id': 7, 'display_name': '테스트 에디터', 'role': 'reporter'}


@pytest.fixture
def article():
    return dict(id='jack-white', artist={'name': 'Test Artist'}, title='검토할 제목',
                body='첫 문장입니다. 반복 문구. 둘째 문장입니다. 반복 문구.')


@pytest.fixture
def review(article):
    return dict(type='editorial', articleHash=routes.fingerprint(article), approved=False,
                issues=[dict(field='title', category='title', text='검토할 제목', reason='제목 표현', suggestion='제목을 다듬으세요.'),
                        dict(field='body', category='repetition', text='반복 문구.', reason='중복', suggestion='반복을 줄이세요.')])


def payload(review, operation='pass', issue_id='E001', **extra):
    return dict(expectedReviewHash=editorial_edit.fingerprint(review), operation=operation,
                issueId=issue_id, reason='에디터가 문맥과 편집 의도를 확인했습니다.', **extra)


def test_pass_is_audited_without_rewriting_ai_or_article(article, review):
    original = copy.deepcopy(review)
    updated, draft = editorial_edit.apply(review, article, payload(review), USER)
    assert review == original and draft == article
    assert updated['issues'] == original['issues']
    assert len(editorial_edit.pending(updated)) == 1
    decision = updated['decisions']['E001']
    assert decision['status'] == 'passed' and decision['actor']['id'] == USER['id']
    assert updated['manualHistory'][0]['issue']['text'] == '검토할 제목'
    assert updated['manualHistory'][0]['articleHashBefore'] == updated['manualHistory'][0]['articleHashAfter']
    assert editorial_edit.present(updated)['issues'][0]['decision'] == decision


@pytest.mark.parametrize('role', ['user', None])
def test_non_editors_cannot_record_decisions(article, review, role):
    with pytest.raises(ai.EditorError) as error:
        editorial_edit.apply(review, article, payload(review), dict(USER, role=role))
    assert error.value.status == 403


def test_pass_requires_reason_and_latest_review(article, review):
    data = payload(review); data['reason'] = ' '
    with pytest.raises(ai.EditorError) as error:
        editorial_edit.apply(review, article, data, USER)
    assert error.value.status == 400
    changed, _ = editorial_edit.apply(review, article, payload(review), USER)
    with pytest.raises(ai.EditorError) as error:
        editorial_edit.apply(changed, article, payload(review, issue_id='E002'), USER)
    assert error.value.status == 409
    with pytest.raises(ai.EditorError) as error:
        editorial_edit.apply(review, dict(article, body=article['body'] + ' 변경'), payload(review), USER)
    assert error.value.status == 409


def test_edit_changes_only_the_selected_occurrence(article, review):
    data = payload(review, 'edit', 'E002', text='반복 문구.', replacement='다듬은 문구.', occurrence=1)
    updated, draft = editorial_edit.apply(review, article, data, USER)
    assert draft['body'] == '첫 문장입니다. 반복 문구. 둘째 문장입니다. 다듬은 문구.'
    assert draft['artist'] == article['artist'] and draft['title'] == article['title']
    assert updated['articleHash'] == routes.fingerprint(draft) == editorial_edit.article_hash(draft)
    assert updated['aiArticleHash'] == routes.fingerprint(article)
    assert updated['issues'] == review['issues']
    assert updated['manualHistory'][0]['original'] == '반복 문구.'
    assert updated['manualHistory'][0]['replacement'] == '다듬은 문구.'


@pytest.mark.parametrize('extra,status', [
    ({'text': '반복 문구.', 'replacement': '수정'}, 400),
    ({'text': '없는 문구', 'replacement': '수정'}, 409),
    ({'text': '반복 문구.', 'replacement': '반복 문구.', 'occurrence': 0}, 400),
    ({'text': '반복 문구.', 'replacement': '수정', 'occurrence': True}, 400),
])
def test_invalid_edits_are_rejected(article, review, extra, status):
    with pytest.raises(ai.EditorError) as error:
        editorial_edit.apply(review, article, payload(review, 'edit', 'E002', **extra), USER)
    assert error.value.status == status


def test_reopen_keeps_current_draft_and_prior_history(article, review):
    updated, draft = editorial_edit.apply(review, article, payload(review, 'edit', text=article['title'], replacement='다듬은 제목'), USER)
    reopened, same_draft = editorial_edit.apply(updated, draft, payload(updated, 'reopen'), USER)
    assert same_draft == draft and len(editorial_edit.pending(reopened)) == 2
    assert editorial_edit.present(reopened)['issues'][0]['currentText'] == '다듬은 제목'
    assert len(reopened['manualHistory']) == 2
    assert reopened['manualHistory'][1]['before']['status'] == 'edited'


def test_ai_rerun_clears_active_decisions_and_preserves_audit(article, review):
    passed, _ = editorial_edit.apply(review, article, payload(review), USER)
    fresh = editorial_edit.prepare(dict(type='editorial', issues=review['issues']), routes.fingerprint(article), passed)
    assert len(editorial_edit.pending(fresh)) == 2 and fresh['manualRevision'] == 0
    assert fresh['manualHistory'] == passed['manualHistory']
    assert fresh['reviewId'] != editorial_edit.review_id(passed)
    with pytest.raises(ai.EditorError) as error:
        editorial_edit.apply(fresh, article, payload(passed, issue_id='E002'), USER)
    assert error.value.status == 409


@pytest.fixture
def saved_state(tmp_path, monkeypatch, article, review):
    # 편집 기록은 원래 DB에 저장됩니다. 테스트는 실제 DB(Supabase)를 건드리지 않도록 메모리에만 저장합니다.
    memory = {}
    monkeypatch.setattr(routes.storage, 'get_doc', lambda kind, artist, default=None: memory.get((kind, artist), default))
    monkeypatch.setattr(routes.storage, 'put_doc', lambda kind, artist, data: memory.__setitem__((kind, artist), data))
    monkeypatch.setattr(routes, 'ROOT', tmp_path)
    token = routes.current.set('jack-white')
    routes.write('draft', article); routes.write('editorial', review)
    sheet = dict(articleHash=routes.fingerprint(article), facts=[dict(id='F001', verificationStatus='VERIFIED')], truncated=False)
    routes.write('sheet', sheet)
    routes.write('review', dict(articleHash=routes.fingerprint(article), researchHash=routes.fingerprint(article), sheetHash=fact_edit.fingerprint(sheet), issues=[]))
    yield
    routes.current.reset(token)


def act(name, **data):
    return asyncio.run(routes.action(name, data, USER))


def test_human_pass_allows_approval_and_reopen_revokes_it(saved_state, article):
    for issue_id in ['E001', 'E002']:
        review = routes.read('editorial')
        act('editorial-edit', article=article, **payload(review, issue_id=issue_id))
    approved = act('approve', article=article, confirmSources=True)
    assert approved['state']['approved'] and approved['state']['editorialRemaining'] == 0
    old_approval = routes.read('approval')
    review = routes.read('editorial')
    act('editorial-edit', article=article, **payload(review, 'reopen'))
    assert not routes.state()['state']['approved']
    # 승인 파일이 오래된 버전으로 돌아와도 리뷰 버전 비교가 재사용을 막는다.
    routes.write('approval', old_approval)
    assert not routes.state()['state']['approved']


def test_edit_requires_fresh_fact_check_and_cannot_approve(saved_state, article):
    review = routes.read('editorial')
    edited = act('editorial-edit', article=article, **payload(review, 'edit', text=article['title'], replacement='다듬은 제목'))
    assert edited['state']['editorialCurrent'] and not edited['state']['factCurrent']
    with pytest.raises(ai.EditorError) as error:
        act('approve', article=edited['article'], confirmSources=True)
    assert error.value.status == 409


def test_unresolved_fact_issues_remain_blocking(saved_state, article):
    for issue_id in ['E001', 'E002']:
        review = routes.read('editorial')
        act('editorial-edit', article=article, **payload(review, issue_id=issue_id))
    fact_review = routes.read('review'); fact_review['issues'] = [{'reason': '출처와 불일치'}]
    routes.write('review', fact_review)
    with pytest.raises(ai.EditorError):
        act('approve', article=article, confirmSources=True)


def test_unsaved_or_wrong_artist_draft_is_rejected(saved_state, article):
    review = routes.read('editorial')
    with pytest.raises(ai.EditorError) as error:
        act('editorial-edit', article=dict(article, title='미저장 수정'), **payload(review))
    assert error.value.status == 409
    token = routes.current.set('another-artist')
    try:
        with pytest.raises(ai.EditorError):
            act('editorial-edit', article=article, **payload(review))
    finally:
        routes.current.reset(token)
