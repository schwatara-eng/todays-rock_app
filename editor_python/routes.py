import asyncio
import contextvars
from datetime import datetime
import hashlib
import json
import logging
from pathlib import Path
import re
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from . import ai, fact_edit, editorial_edit, storage
from . import publish as publisher
from account_system.security import check_csrf, current_user, require_role

ROOT=Path(__file__).resolve().parent.parent
router=APIRouter()
lock=asyncio.Lock()
# 뮤지션별 기록(draft·sheet·review·editorial·approval)은 Supabase DB에 저장한다. (storage.py)
# {id}는 요청마다 지정된 뮤지션 ID(예: jack-white).
DEFAULT_ARTIST='jack-white'
MAX_NEW_FACTS=60   # 팩트시트를 한 번 만들 때 새로 추가하는 항목 수 상한
ARTIST_ID=re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')
current=contextvars.ContextVar('artist',default=DEFAULT_ARTIST)
CSP="default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self'; frame-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"

def artist_id(value):
    if value is None or value=='':value=DEFAULT_ARTIST
    value=value.strip().lower() if isinstance(value,str) else ''
    if len(value)>50 or not ARTIST_ID.fullmatch(value):raise ai.EditorError('뮤지션 ID는 영문 소문자·숫자·하이픈만 쓸 수 있습니다. 예: jack-white',400)
    return value

def read(key, default=None):return storage.get_doc(key,current.get(),default)

def write(key, value):storage.put_doc(key,current.get(),value)

def read_sheet():
    # 예전 팩트시트의 '해석·평가(interpretation)' 항목을 '평론(opinion)'으로 바꿔 저장합니다.
    # 평론은 사실 검증 대상이 아니므로 검증 상태도 '평론적 표현'이 됩니다.
    sheet=read('sheet')
    if not sheet or not isinstance(sheet.get('facts'),list):return sheet
    changed=False
    for f in sheet['facts']:
        if f.get('type')=='interpretation':
            f['type']='opinion';ai.opinion(f);changed=True
    if changed:write('sheet',sheet)
    return sheet

def valid(a):
    return isinstance(a,dict) and all(isinstance(a.get(k),str) and a[k].strip() and len(a[k])<=limit for k,limit in [('title',300),('body',15000)])

def normalize(a):return {'title':a['title'].strip(),'body':a['body'].strip()}

# 띄어쓰기·문장부호 차이는 무시하고 글자만 비교합니다.
def compact(text):return re.sub(r'[\W_]+','',str(text or ''))

def article_text(a):return a['title'].strip()+'\n'+a['body'].strip()

def fingerprint(a):
    # JS JSON.stringify와 키 순서·UTF-8·줄바꿈을 동일하게 유지한다.
    return hashlib.sha256(json.dumps(normalize(a),ensure_ascii=False,separators=(',',':')).encode('utf-8')).hexdigest()

def state():
    article=read('draft');sheet=read_sheet();review=read('review');editorial=read('editorial');approval=read('approval')
    h=fingerprint(article) if valid(article) else None
    research=bool(h and sheet and sheet.get('articleHash')==h and isinstance(sheet.get('facts'),list))
    verified=bool(research and not sheet.get('truncated') and sheet['facts'] and all(f.get('verificationStatus') in ('VERIFIED','OPINION') for f in sheet['facts']))
    sheet_hash=fact_edit.fingerprint(sheet) if research else None
    review_current=bool(research and review and review.get('articleHash')==h and review.get('researchHash')==sheet['articleHash'] and (review.get('sheetHash')==sheet_hash or not sheet.get('manualRevision') and not review.get('sheetHash')))
    fact=bool(verified and review_current)
    edit=bool(h and editorial and editorial.get('articleHash')==h)
    editorial_hash=editorial_edit.fingerprint(editorial) if edit else None
    remaining=editorial_edit.pending(editorial) if edit else []
    approved=bool(fact and edit and approval and approval.get('articleHash')==h and approval.get('status')=='approved' and (approval.get('sheetHash')==sheet_hash or not sheet.get('manualRevision') and not approval.get('sheetHash')) and (approval.get('editorialHash')==editorial_hash or not editorial.get('manualRevision') and not approval.get('editorialHash')) and not review.get('issues') and not remaining)
    publication=storage.get_archive()
    published=bool(publication.get('current') and publication['current'].get('id')==current.get() or any(a.get('id')==current.get() for a in publication.get('archive',[])))
    hidden=any(a.get('id')==current.get() for a in publication.get('hidden',[]))
    return dict(factSheetHash=sheet_hash,editorialReviewHash=editorial_hash,artistId=current.get(),article=article,factSheet=sheet if research else None,review=review if review_current else None,editorialReview=editorial_edit.present(editorial) if edit else None,approval=approval if approved else None,state=dict(approved=approved,factCurrent=fact,researchCurrent=research,allVerified=verified,editorialCurrent=edit,editorialRemaining=len(remaining) if edit else None,status='approved' if approved else 'draft',published=published,hidden=hidden,isCurrent=bool(publication.get('current') and publication['current'].get('id')==current.get())))

def invalidate():write('approval',dict(status='draft',approved=False,invalidatedAt=ai.now()))

def saved_article(data):
    article=data.get('article')
    if not valid(article):raise ai.EditorError('기사 제목 또는 본문을 확인하세요.',400)
    saved=read('draft')
    if not valid(saved) or fingerprint(saved)!=fingerprint(article):raise ai.EditorError('현재 편집 내용을 먼저 저장하세요.',409)
    return saved

def save_review(article,sheet,result):
    h=fingerprint(article)
    write('review',dict(result,articleHash=h,researchHash=sheet['articleHash'],sheetHash=fact_edit.fingerprint(sheet)))

async def action(name,data,user=None):
    if name=='editorial-edit':
        article=saved_article(data)
        updated,updated_article=editorial_edit.apply(read('editorial'),article,data,user)
        invalidate()
        if fingerprint(updated_article)!=fingerprint(article):write('draft',updated_article)
        write('editorial',updated)
        return state()
    if name=='fact-edit':
        article=saved_article(data);sheet=read_sheet()
        if not sheet or sheet.get('articleHash')!=fingerprint(article):raise ai.EditorError('현재 원고의 팩트시트가 필요합니다. 원고 변경 후에는 웹 출처 조사로 갱신하세요.',409)
        updated=fact_edit.apply(sheet,article,data)
        write('sheet',updated);invalidate()
        return state()
    if name=='artist-delete':
        # 편집실에서 추가한 뮤지션을 기록째 지웁니다. 공개 중인 기사는 먼저 비공개로 돌려야 합니다.
        aid=current.get()
        if data.get('confirm')!=aid:raise ai.EditorError('삭제할 뮤지션을 확인하지 못했습니다. 새로고침한 뒤 다시 시도하세요.',400)
        site=storage.get_archive() or {}
        shown=[site.get('current')]+list(site.get('archive') or [])
        if any(isinstance(a,dict) and a.get('id')==aid for a in shown):
            raise ai.EditorError('홈이나 아카이브에 공개된 기사입니다. 06의 \'비공개로 전환\'을 먼저 누른 뒤 삭제하세요.',409)
        hidden=list(site.get('hidden') or [])
        was_hidden=any(isinstance(a,dict) and a.get('id')==aid for a in hidden)
        archive=dict(site,hidden=[a for a in hidden if not (isinstance(a,dict) and a.get('id')==aid)]) if was_hidden else None
        docs={k:read(k) for k in ('draft','sheet','review','editorial','approval')}
        if not any(docs.values()) and not was_hidden:raise ai.EditorError('저장된 기록이 없는 뮤지션입니다.',404)
        backup=json.dumps(dict(artistId=aid,deletedAt=ai.now(),deletedBy=(user or {}).get('id'),docs=docs,hidden=was_hidden),ensure_ascii=False)
        storage.delete_artist(aid,archive,backup,datetime.now().strftime('%Y%m%d-%H%M%S'))
        return {'deleted':aid,'artists':list_artists()}
    if name=='artist-info':
        # 뮤지션 정보(한국 뮤지션 여부)만 바꿉니다. 원고 내용이 아니므로 검수·승인은 그대로 둡니다.
        if not isinstance(data.get('korean'),bool):raise ai.EditorError('한국 뮤지션 여부를 확인할 수 없습니다.',400)
        old=read('draft')
        if not isinstance(old,dict) or not old.get('artist'):raise ai.EditorError('원고를 먼저 저장한 뒤 바꿔 주세요.',409)
        write('draft',dict(old,artist=dict(old['artist'],korean=data['korean'])))
        storage.set_archive_korean(current.get(),data['korean'])
        return state()
    if name=='photo-credit':
        # 사진 출처만 바꿉니다. 원고 내용이 아니므로 검수·승인은 그대로 둡니다. 빈 값이면 출처 표시를 뺍니다.
        credit=data.get('credit')
        if not isinstance(credit,str):raise ai.EditorError('사진 출처를 확인할 수 없습니다.',400)
        credit=publisher.clean_credit(credit)
        if len(credit)>100:raise ai.EditorError('사진 출처는 100자 이내로 입력하세요.',400)
        old=read('draft')
        if not valid(old):raise ai.EditorError('원고를 먼저 저장한 뒤 사진 출처를 입력하세요.',409)
        write('draft',dict(old,photoCredit=credit))
        return state()
    if name=='generate':raise ai.EditorError('AI 기사 자동 생성은 사용하지 않습니다. 에디터가 초안을 직접 작성하세요.',410)
    if name=='save':
        if not valid(data.get('article')):raise ai.EditorError('기사 제목 또는 본문을 확인하세요.',400)
        old=read('draft',{}) or {}
        info=data.get('artistInfo')
        if isinstance(info,dict) and isinstance(info.get('name'),str) and info['name'].strip():
            artist={'name':info['name'].strip()[:100],'nameKo':str(info.get('nameKo') or '').strip()[:100],'korean':info.get('korean') is True}
        else:artist=old.get('artist')
        if not artist:raise ai.EditorError('새 뮤지션은 이름을 입력해야 저장할 수 있습니다.',400)
        write('draft',dict(old,id=current.get(),artist=artist,**normalize(data['article']),factIds=[],status='draft',reviewed=False))
        invalidate();return state()
    if name=='research':
        article=saved_article(data);h=fingerprint(article);sheet=read_sheet()
        # 예전 방식으로 '일부만 추출' 표시가 붙은 팩트시트는 한 번 다시 맞춰 표시를 바로잡습니다. (검증 결과는 유지)
        # (조사 대기 항목이 남아 있으면 먼저 그것부터 조사하고, 다 끝난 뒤에 다시 맞춥니다. 긴 원고는 이렇게 묶음별로 진행됩니다.)
        stale=not sheet or sheet.get('articleHash')!=h or not isinstance(sheet.get('facts'),list)
        recheck_truncated=not stale and sheet.get('truncated') and not any(f.get('failureType')=='PENDING' for f in sheet['facts'])
        if stale or recheck_truncated:
            extracted=await ai.extract(normalize(article))
            if not extracted.get('claims'):raise ai.EditorError('검증할 사실 주장을 찾지 못했습니다.',422)
            # 원고를 고쳐도 팩트시트를 처음부터 다시 만들지 않습니다.
            # - 이전 팩트 중 근거 문장(excerpt)이 새 원고에 그대로 남아 있는 것은 검증 결과째 유지
            # - 새로 쓰거나 고친 문장에서 나온 주장만 새 항목(PENDING)으로 추가
            # - 지워진 문장의 팩트는 자연히 빠짐
            old_facts=sheet.get('facts') if sheet and isinstance(sheet.get('facts'),list) else []
            old_text=compact(sheet.get('articleText','')) if sheet else ''
            new_text=compact(article_text(article))
            kept=[f for f in old_facts if (f.get('failureType')!='PENDING' or f.get('manuallyEdited')) and compact(f.get('excerpt',''))
                  and compact(f['excerpt']) in new_text]
            kept_excerpts=[compact(f['excerpt']) for f in kept]
            def unchanged(c):
                # 새 주장의 근거 문장이 이전 원고에도 있었고, 유지된 팩트가 그 문장을 다루고 있으면 이미 검증된 부분
                e=compact(c.get('excerpt') or c['claim'])
                if any(e in k for k in kept_excerpts):return True
                return bool(old_text) and e in old_text and any(k in e for k in kept_excerpts)
            excluded=sheet.get('excludedFacts',[]) if sheet else []
            def was_excluded(c):
                return any(compact(c.get('claim'))==compact(r['fact'].get('claim')) and compact(c.get('excerpt') or c['claim'])==compact(r['fact'].get('excerpt')) for r in excluded)
            # '일부만 추출'은 아직 팩트시트에 없는 새 주장이 너무 많아 다 넣지 못했을 때만 표시합니다.
            fresh_all=[c for c in extracted['claims'] if not unchanged(c) and not was_excluded(c)]
            fresh=fresh_all[:MAX_NEW_FACTS]
            truncated=extracted['truncated'] or len(fresh_all)>MAX_NEW_FACTS
            next_no=fact_edit.next_number(sheet)
            facts=list(kept)
            for i,c in enumerate(fresh):
                f=ai.new_fact(c,f'F{next_no+i:03d}')
                if f['type']=='opinion':ai.opinion(f)
                else:f.update(failureType='PENDING',reason='아직 조사하지 않았습니다.')
                facts.append(f)
            manual={k:sheet[k] for k in ('excludedFacts','manualHistory','manualRevision') if sheet and k in sheet}
            sheet=dict(**manual,artist={'name':'기사 기반 자료'},articleHash=h,articleText=article_text(article),facts=facts,truncated=truncated,generatedAt=ai.now(),
                       note=f'같은 대상을 다루는 주장끼리 묶어 조사합니다. 이전 검증 {len(kept)}개 유지, 새 항목 {len(fresh)}개.')
            write('sheet',sheet);invalidate()
            # 바뀐 사실이 하나도 없으면 바로 사실 검수 보고서를 다시 만듭니다.
            if not any(f.get('failureType')=='PENDING' for f in facts):save_review(article,sheet,await ai.review(article,sheet))
            return state()
        first=next((f for f in sheet['facts'] if f.get('failureType')=='PENDING'),None)
        if first is None:
            # 의견만 있는 원고도 사실 검토를 완료할 수 있도록 한다.
            save_review(article,sheet,await ai.review(article,sheet));invalidate();return state()
        batch=[f for f in sheet['facts'] if f.get('failureType')=='PENDING' and (f['id']==first['id'] or first.get('group') and f.get('group')==first['group'])][:8]
        results=await ai.verify(batch,[f['id'] for f in batch],[],normalize(article))
        by_id={f['id']:f for f in results}
        for f in batch:
            if f['id'] not in by_id:by_id[f['id']]=dict(f,failureType='SEARCH_FAILED',checkedAt=ai.now(),reason='조사 응답에서 항목이 누락되었습니다. 재검색하세요.')
        sheet['facts']=[dict(f,**by_id[f['id']]) if f['id'] in by_id else f for f in sheet['facts']];sheet['generatedAt']=ai.now()
        write('sheet',sheet);invalidate()
        if not any(f.get('failureType')=='PENDING' for f in sheet['facts']):save_review(article,sheet,await ai.review(article,sheet))
        return state()
    if name=='research-one':
        article=saved_article(data);sheet=read_sheet()
        if not valid(article) or not sheet or sheet.get('articleHash')!=fingerprint(article):raise ai.EditorError('현재 저장된 원고의 팩트시트가 필요합니다.',409)
        if data.get('expectedSheetHash') and data['expectedSheetHash']!=fact_edit.fingerprint(sheet):raise ai.EditorError('팩트시트가 변경됐습니다. 새로고침한 뒤 다시 검증하세요.',409)
        old=next((f for f in sheet['facts'] if f['id']==data.get('factId')),None)
        if not old:raise ai.EditorError('검증 항목을 찾지 못했습니다.',404)
        if old.get('type')=='opinion' or old.get('verificationStatus')=='OPINION':raise ai.EditorError('이 항목은 개별 재검색 대상이 아닙니다.',409)
        sources=old.get('sources') or [];attempts=old.get('attempts') or []
        excluded=list(dict.fromkeys(s['url'] for s in sources+[s for a in attempts for s in a.get('sources',[])] if s.get('url')))[:50]
        result=dict(old,**(await ai.verify([old],[old['id']],excluded,normalize(article)))[0])
        result['sources']=sources+[s for s in result['sources'] if s['url'] not in {o['url'] for o in sources}]
        result['attempts']=attempts+[{k:old.get(k) for k in ('checkedAt','verificationStatus','failureType','reason','sources')}]
        if old.get('verificationStatus')=='VERIFIED' and result['verificationStatus']!='VERIFIED':
            for k in ('verificationStatus','source','evidence','reason','suggestion','failureType'):result[k]=old.get(k)
        sheet['facts']=[result if f['id']==old['id'] else f for f in sheet['facts']];sheet['generatedAt']=ai.now()
        write('sheet',sheet);invalidate();save_review(article,sheet,await ai.review(article,sheet));return state()
    if name in ('review','editorial','recheck'):
        article=saved_article(data);h=fingerprint(article)
        if name in ('review','recheck'):
            sheet=read_sheet()
            if not sheet or sheet.get('articleHash')!=h:raise ai.EditorError('먼저 현재 원고로 팩트시트 생성 및 웹 검증을 진행하세요.',409)
            save_review(article,sheet,await ai.review(article,sheet))
        if name in ('editorial','recheck'):write('editorial',editorial_edit.prepare(await ai.editorial(normalize(article)),h,read('editorial')))
        invalidate();return state()
    if name=='approve':
        if data.get('confirmSources') is not True:raise ai.EditorError('실제 출처 확인 및 최종 검토 확인이 필요합니다.',400)
        article=saved_article(data);s=state()
        if not all(s['state'][k] for k in ('factCurrent','allVerified','editorialCurrent')):raise ai.EditorError(approval_blocker(s),409)
        if s['review'].get('issues') or editorial_edit.pending(read('editorial')):raise ai.EditorError('미처리 검토 지적이 남아 있습니다. 사실 검수와 편집 의견 처리를 완료하세요.',409)
        write('approval',dict(articleId=current.get(),articleHash=fingerprint(article),status='approved',approved=True,confirmedSources=True,sheetHash=fact_edit.fingerprint(s['factSheet']),editorialHash=s['editorialReviewHash'],approvedAt=ai.now(),published=False));return state()
    if name=='unpublish':
        result=publisher.unpublish(current.get(),ai.now())
        return dict(state(),publishResult=result)
    if name=='publish':
        # 서버에 저장된 승인 상태를 다시 확인한 뒤에만 홈에 게시합니다.
        s=state()
        if not s['state']['approved']:raise ai.EditorError('승인된 원고만 홈에 게시할 수 있습니다.',409)
        result=publisher.publish(current.get(),s['article'],s['factSheet'],ai.now())
        write('approval',dict(read('approval'),published=True,publishedAt=ai.now()))
        return dict(state(),publishResult=result)
    raise ai.EditorError('지원하지 않는 기능입니다.',404)

def approval_blocker(s):
    """승인을 막는 조건을 하나씩 확인해, 무엇을 하면 되는지 알려 줍니다."""
    st=s['state'];reasons=[]
    if not st['researchCurrent']:
        reasons.append('팩트시트가 지금 원고와 맞지 않습니다(팩트시트를 만든 뒤 원고가 바뀜). 01의 \'팩트시트 생성 + 웹 출처 검증\'을 다시 누르세요.')
    elif not st['allVerified']:
        sheet=read_sheet() or {}
        left=[f.get('id','?') for f in sheet.get('facts',[]) if f.get('verificationStatus') not in ('VERIFIED','OPINION')]
        if sheet.get('truncated'):reasons.append('팩트시트에 \'일부만 추출\' 표시가 있습니다. 01의 \'팩트시트 생성 + 웹 출처 검증\'을 한 번 더 누르면 기존 검증 결과는 그대로 두고 다시 맞춥니다. 그래도 남으면 원고가 너무 길어 새 주장을 다 넣지 못한 것이니 원고를 줄여 주세요.')
        if left:reasons.append(f'검증되지 않은 사실 항목 {len(left)}개가 남아 있습니다({", ".join(left[:8])}{" 등" if len(left)>8 else ""}). 출처 재검색·항목 수정·제외로 정리하세요.')
    elif not st['factCurrent']:
        reasons.append('팩트시트를 고친 뒤(항목 수정·추가·제외) 사실 검수 보고서가 갱신되지 않았습니다. 02 상자 오른쪽 위의 \'사실 검수 갱신\'을 누르세요.')
    if not st['editorialCurrent']:
        reasons.append('편집 검토가 지금 원고와 맞지 않습니다(편집 검토 뒤 원고가 바뀜). 04의 \'AI 편집 검토\'를 다시 실행하세요.')
    return '승인할 수 없습니다. ' + ' / '.join(reasons or ['사실 검수와 편집 검토를 모두 완료해야 합니다.'])

def list_artists():
    found=[]
    for key,draft in storage.list_drafts().items():
        if not ARTIST_ID.fullmatch(key):continue
        artist=(draft.get('artist') if isinstance(draft,dict) else None) or {}
        found.append({'id':key,'name':artist.get('name') or key,'nameKo':artist.get('nameKo') or '','korean':artist.get('korean') is True})
    return found

def reply(data,status=200):return JSONResponse(data,status_code=status,headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})

@router.api_route('/local/{name}',methods=['GET','POST'])
async def endpoint(name:str,request:Request):
    user=require_role(request,'admin','reporter')
    if request.method=='POST':check_csrf(request,user)
    try:
        # 요청별 변경을 직렬화: 조사 중 저장/승인 경합으로 잘못된 버전이 승인되는 것을 막는다.
        async with lock:
            if request.method=='GET':
                if name=='artists':return reply({'artists':list_artists()})
                current.set(artist_id(request.query_params.get('artist')))
                if name=='data':return reply(state())
                if name=='publication-export':
                    s=state()
                    if not s['state']['approved']:raise ai.EditorError('현재 저장된 원고의 승인과 두 검토가 필요합니다.',409)
                    article=s['article'];return reply(dict({k:article.get(k) for k in ('id','artist','title','body','factIds')},editorialStatus='approved',published=False,approvedAt=s['approval']['approvedAt']))
                raise ai.EditorError('경로를 찾지 못했습니다.',404)
            if name=='photo':
                # 사진은 JSON이 아니라 파일 내용 그대로 받습니다. 뮤지션 ID는 주소의 ?artist= 로 받습니다.
                current.set(artist_id(request.query_params.get('artist')))
                draft=read('draft')
                if not valid(draft):raise ai.EditorError('원고를 먼저 저장한 뒤 사진을 등록하세요.',409)
                raw=bytearray()
                async for chunk in request.stream():
                    raw.extend(chunk)
                    if len(raw)>publisher.MAX_PHOTO:raise ai.EditorError(publisher.PHOTO_LIMIT_MESSAGE,413)
                path=publisher.save_photo(current.get(),bytes(raw))
                write('draft',dict(draft,photo=path,photoUpdatedAt=ai.now()))
                return reply(state())
            raw=bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw)>(150000 if name=='editorial-edit' else 100000 if name in ('fact-edit','research-one') else 50000):raise ai.EditorError('요청이 너무 큽니다.',413)
            try:data=json.loads(raw or b'{}')
            except (ValueError,UnicodeDecodeError):raise ai.EditorError('올바른 JSON 요청이 아닙니다.',400) from None
            if not isinstance(data,dict):raise ai.EditorError('JSON 객체가 필요합니다.',400)
            current.set(artist_id(data.get('artist')))
            return reply(await action(name,data,user))
    except ai.EditorError as e:return reply({'error':str(e)},e.status)
    except publisher.PublishError as e:return reply({'error':str(e)},e.status)
    except Exception:
        logging.exception('편집실 처리 실패')
        return reply({'error':'편집실 처리에 실패했습니다. 서버 터미널을 확인하세요.'},500)

async def static(request,path,csp=False):
    require_role(request,'admin','reporter')
    if not path.is_file():return reply({'error':'파일 없음'},404)
    headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
    if csp:headers['Content-Security-Policy']=CSP
    return FileResponse(path,headers=headers)

@router.get('/editor')
async def redirect():return RedirectResponse('/editor/')

@router.get('/editor/')
async def home(request:Request):
    user=current_user(request)
    if not user:return RedirectResponse('/login?next=%2Feditor%2F',status_code=303)
    if user['role'] not in ('admin','reporter'):
        return FileResponse(ROOT/'accounts/forbidden.html',status_code=403,headers={'Cache-Control':'no-store'})
    return await static(request,ROOT/'admin/index.html',True)

@router.get('/editor/{asset:path}')
async def editor_asset(asset:str,request:Request):
    if asset not in ('app.js','style.css','fonts/Galmuri9.woff2','stamp-approved.svg','stamp-critique.svg'):return reply({'error':'파일 없음'},404)
    return await static(request,ROOT/'fonts/Galmuri9.woff2' if asset.startswith('fonts/') else ROOT/'admin'/asset)

@router.get('/site/{asset:path}')
async def preview(asset:str,request:Request):
    allowed=asset in ('index.html','artist-jack-white.html','style.css') or re.fullmatch(r"(images|fonts)/[\w가-힣 .'-]+\.(png|jpe?g|webp|woff2?|otf)",asset,re.I)
    if not allowed:return reply({'error':'허용되지 않은 파일입니다.'},404)
    path=(ROOT/asset).resolve()
    if not path.is_relative_to(ROOT.resolve()):return reply({'error':'파일 없음'},404)
    headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
    if asset=='index.html':
        require_role(request,'admin','reporter')
        return HTMLResponse(storage.home_page(),headers=headers)   # DB에 게시된 현재 기사 포함
    if asset.startswith('images/'):
        require_role(request,'admin','reporter')
        found=storage.get_asset(asset)                              # 편집실에서 올린 사진은 DB에 있음
        if not found:return reply({'error':'파일 없음'},404)
        return Response(found[0],media_type=found[1],headers=headers)
    return await static(request,path)


