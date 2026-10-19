"""사람의 편집 검토 처리. AI 의견은 보존하고 원고 수정·패스·재검토를 기록한다."""
import copy
import hashlib
import json
import uuid
from . import ai


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def fingerprint(review):
    return digest(review)


def article_hash(article):
    value = {key: article[key].strip() for key in ('title', 'body')}
    return hashlib.sha256(json.dumps(value, ensure_ascii=False,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def review_id(review):
    return review.get('reviewId') or 'legacy-' + digest({
        'articleHash': review.get('articleHash'), 'issues': review.get('issues', [])})


def issue_hash(issue):
    return digest({key: issue.get(key) for key in ('field', 'category', 'text', 'reason', 'suggestion')})


def issues(review):
    return [dict(item, id=f'E{index + 1:03d}')
            for index, item in enumerate((review or {}).get('issues', []))]


def decision_for(review, issue):
    decision = review.get('decisions', {}).get(issue['id'])
    if (isinstance(decision, dict) and decision.get('status') in ('edited', 'passed')
            and decision.get('reviewId') == review_id(review)
            and decision.get('issueHash') == issue_hash(issue)):
        return decision
    return None


def pending(review):
    return [issue for issue in issues(review) if not decision_for(review, issue)]


def present(review):
    result = copy.deepcopy(review)
    result['issues'] = [dict(issue, decision=decision_for(review, issue),
                            currentText=review.get('anchors', {}).get(issue['id'], issue.get('text', '')))
                        for issue in issues(review)]
    return result


def prepare(result, article_fingerprint, previous=None):
    """AI 재검토는 새 회차로 시작하되, 이전 사람의 처리 이력은 남긴다."""
    return dict(result, reviewId=uuid.uuid4().hex, articleHash=article_fingerprint,
                aiArticleHash=article_fingerprint, generatedAt=ai.now(),
                decisions={}, anchors={}, manualRevision=0,
                manualHistory=copy.deepcopy((previous or {}).get('manualHistory', [])))


def occurrences(text, excerpt):
    positions = []
    start = 0
    while excerpt:
        position = text.find(excerpt, start)
        if position < 0:
            break
        positions.append(position)
        start = position + len(excerpt)
    return positions


def apply(review, article, data, user):
    if not user or user.get('role') not in ('admin', 'reporter') or not user.get('id'):
        raise ai.EditorError('편집실 권한이 있는 계정만 편집 의견을 처리할 수 있습니다.', 403)
    if not review or review.get('articleHash') != article_hash(article):
        raise ai.EditorError('현재 저장된 원고의 편집 검토가 필요합니다.', 409)
    if data.get('expectedReviewHash') != fingerprint(review):
        raise ai.EditorError('편집 검토가 다른 작업에서 변경됐습니다. 새로고침한 뒤 다시 처리하세요.', 409)
    operation = data.get('operation')
    if operation not in ('edit', 'pass', 'reopen'):
        raise ai.EditorError('지원하지 않는 편집 처리 방식입니다.', 400)
    issue = next((item for item in issues(review) if item['id'] == data.get('issueId')), None)
    if not issue:
        raise ai.EditorError('처리할 편집 의견을 찾지 못했습니다.', 404)
    previous = decision_for(review, issue)
    if operation == 'reopen' and not previous:
        raise ai.EditorError('이미 검토 대기 중인 항목입니다.', 409)
    if operation != 'reopen' and previous:
        raise ai.EditorError('이미 처리한 항목입니다. 다시 검토로 돌린 뒤 변경하세요.', 409)
    reason = data.get('reason', '')
    if not isinstance(reason, str) or len(reason) > 600:
        raise ai.EditorError('처리 사유는 600자 이하로 입력하세요.', 400)
    reason = reason.strip()
    if operation != 'reopen' and not reason:
        raise ai.EditorError('수정 또는 패스 사유를 입력하세요.', 400)
    result = copy.deepcopy(review)
    result['reviewId'] = review_id(review)
    result.setdefault('aiArticleHash', review['articleHash'])
    result.setdefault('decisions', {})
    result.setdefault('anchors', {})
    updated_article = copy.deepcopy(article)
    event = dict(operation=operation, issueId=issue['id'], issue=copy.deepcopy(issue),
                 reviewId=result['reviewId'], reason=reason or '편집자가 다시 검토 요청',
                 at=ai.now(), actor=dict(id=user['id'],
                     displayName=user.get('display_name') or user.get('displayName') or '편집자', role=user['role']),
                 before=copy.deepcopy(previous), articleHashBefore=article_hash(article))
    if operation == 'edit':
        field = issue.get('field')
        original = data.get('text')
        replacement = data.get('replacement')
        if field not in ('title', 'body'):
            raise ai.EditorError('원고 위치를 확인할 수 없습니다. 원고에서 수정하고 AI 편집 검토를 다시 실행하세요.', 400)
        if not isinstance(original, str) or not original.strip() or len(original) > 6000:
            raise ai.EditorError('현재 원고에서 바꿀 부분을 6,000자 이내로 복사하세요.', 400)
        if not isinstance(replacement, str) or len(replacement) > 15000 or replacement == original:
            raise ai.EditorError('원문과 다른 수정문을 15,000자 이내로 입력하세요.', 400)
        positions = occurrences(article[field], original)
        if not positions:
            raise ai.EditorError('바꿀 부분이 현재 원고에 없습니다. 해당 부분을 원고에서 그대로 복사하세요.', 409)
        occurrence = data.get('occurrence', 0 if len(positions) == 1 else None)
        if type(occurrence) is not int or not 0 <= occurrence < len(positions):
            raise ai.EditorError('같은 문구가 여러 곳에 있습니다. 수정할 위치를 선택하세요.', 400)
        position = positions[occurrence]
        updated_article[field] = (article[field][:position] + replacement + article[field][position + len(original):]).strip()
        if any(not updated_article[key].strip() or len(updated_article[key]) > limit
               for key, limit in (('title', 300), ('body', 15000))):
            raise ai.EditorError('수정 후 제목은 1~300자, 본문은 1~15,000자여야 합니다.', 400)
        if article_hash(updated_article) == article_hash(article):
            raise ai.EditorError('저장되는 원고 내용에 변경이 없습니다.', 400)
        updated_article.update(factIds=[], status='draft', reviewed=False)
        result['anchors'][issue['id']] = replacement
        result['articleHash'] = article_hash(updated_article)
        event.update(field=field, original=original, replacement=replacement, occurrence=occurrence)
    if operation == 'reopen':
        result['decisions'].pop(issue['id'], None)
        event['after'] = None
    else:
        decision = dict(status='edited' if operation == 'edit' else 'passed',
                        reviewId=result['reviewId'], issueHash=issue_hash(issue),
                        actor=event['actor'], reason=reason, at=event['at'])
        result['decisions'][issue['id']] = decision
        event['after'] = copy.deepcopy(decision)
    event['articleHashAfter'] = article_hash(updated_article)
    result['manualRevision'] = int(result.get('manualRevision', 0)) + 1
    result.setdefault('manualHistory', []).append(event)
    return result, updated_article
