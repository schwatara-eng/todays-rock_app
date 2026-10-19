import asyncio
import contextvars
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import tempfile
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from . import ai, fact_edit
from . import publish as publisher
from account_system.security import check_csrf, current_user, require_role

ROOT=Path(__file__).resolve().parent.parent
router=APIRouter()
lock=asyncio.Lock()
# 뮤지션별로 파일을 나눠 저장한다. {id}는 요청마다 지정된 뮤지션 ID(예: jack-white).
PATHS={'draft':'articles/drafts/{id}.json','sheet':'articles/research/{id}.json','review':'articles/reviews/{id}.json','editorial':'articles/reviews/{id}-editorial.json','approval':'articles/approvals/{id}.json'}
DEFAULT_ARTIST='jack-white'
ARTIST_ID=re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*')
current=contextvars.ContextVar('artist',default=DEFAULT_ARTIST)
CSP="default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self'; frame-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"

def artist_id(value):
    if value is None or value=='':value=DEFAULT_ARTIST
    value=value.strip().lower() if isinstance(value,str) else ''
    if len(value)>50 or not ARTIST_ID.fullmatch(value):raise ai.EditorError('뮤지션 ID는 영문 소문자·숫자·하이픈만 쓸 수 있습니다. 예: jack-white',400)
    return value

def path_for(key):return ROOT/PATHS[key].format(id=current.get())

def read(key, default=None):
    try:return json.loads(path_for(key).read_text(encoding='utf-8-sig'))
    except FileNotFoundError:return default

def write(key, value):
    path=path_for(key);path.parent.mkdir(parents=True,exist_ok=True)
    # 같은 폴더의 임시 파일을 교체해 불완전한 JSON이 남지 않게 한다.
    fd,tmp=tempfile.mkstemp(prefix=path.stem+'.',suffix='.tmp',dir=path.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n')
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

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
    approved=bool(fact and edit and approval and approval.get('articleHash')==h and approval.get('status')=='approved' and (approval.get('sheetHash')==sheet_hash or not sheet.get('manualRevision') and not approval.get('sheetHash')) and not review.get('issues') and not editorial.get('issues'))
    return dict(factSheetHash=sheet_hash,artistId=current.get(),article=article,factSheet=sheet if research else None,review=review if review_current else None,editorialReview=editorial if edit else None,approval=approval if approved else None,state=dict(approved=approved,factCurrent=fact,researchCurrent=research,allVerified=verified,editorialCurrent=edit,status='approved' if approved else 'draft',published=False))

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

async def action(name,data):
    if name=='fact-edit':
        article=saved_article(data);sheet=read_sheet()
        if not sheet or sheet.get('articleHash')!=fingerprint(article):raise ai.EditorError('현재 원고의 팩트시트가 필요합니다. 원고 변경 후에는 웹 출처 조사로 갱신하세요.',409)
        updated=fact_edit.apply(sheet,article,data)
        write('sheet',updated);invalidate()
        return state()
    if name=='generate':raise ai.EditorError('AI 기사 자동 생성은 사용하지 않습니다. 에디터가 초안을 직접 작성하세요.',410)
    if name=='save':
        if not valid(data.get('article')):raise ai.EditorError('기사 제목 또는 본문을 확인하세요.',400)
        old=read('draft',{}) or {}
        info=data.get('artistInfo')
        if isinstance(info,dict) and isinstance(info.get('name'),str) and info['name'].strip():
            artist={'name':info['name'].strip()[:100],'nameKo':str(info.get('nameKo') or '').strip()[:100]}
        else:artist=old.get('artist')
        if not artist:raise ai.EditorError('새 뮤지션은 이름을 입력해야 저장할 수 있습니다.',400)
        write('draft',dict(old,id=current.get(),artist=artist,**normalize(data['article']),factIds=[],status='draft',reviewed=False))
        invalidate();return state()
    if name=='research':
        article=saved_article(data);h=fingerprint(article);sheet=read_sheet()
        if not sheet or sheet.get('articleHash')!=h or not isinstance(sheet.get('facts'),list):
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
            fresh=[c for c in extracted['claims'] if not unchanged(c) and not was_excluded(c)]
            next_no=fact_edit.next_number(sheet)
            facts=list(kept)
            for i,c in enumerate(fresh):
                f=ai.new_fact(c,f'F{next_no+i:03d}')
                if f['type']=='opinion':ai.opinion(f)
                else:f.update(failureType='PENDING',reason='아직 조사하지 않았습니다.')
                facts.append(f)
            manual={k:sheet[k] for k in ('excludedFacts','manualHistory','manualRevision') if sheet and k in sheet}
            sheet=dict(**manual,artist={'name':'기사 기반 자료'},articleHash=h,articleText=article_text(article),facts=facts,truncated=extracted['truncated'],generatedAt=ai.now(),
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
        if name in ('editorial','recheck'):write('editorial',dict(await ai.editorial(normalize(article)),articleHash=h))
        invalidate();return state()
    if name=='approve':
        if data.get('confirmSources') is not True:raise ai.EditorError('실제 출처 확인 및 최종 검토 확인이 필요합니다.',400)
        article=saved_article(data);s=state()
        if not all(s['state'][k] for k in ('factCurrent','allVerified','editorialCurrent')):raise ai.EditorError('저장된 기사 버전의 사실 검수와 편집 검토를 모두 완료해야 합니다.',409)
        if s['review'].get('issues') or s['editorialReview'].get('issues'):raise ai.EditorError('검토 지적 사항이 남아 있습니다. 수정 후 재검수하세요.',409)
        write('approval',dict(articleId=current.get(),articleHash=fingerprint(article),status='approved',approved=True,confirmedSources=True,sheetHash=fact_edit.fingerprint(s['factSheet']),approvedAt=ai.now(),published=False));return state()
    if name=='publish':
        # 서버에 저장된 승인 상태를 다시 확인한 뒤에만 홈에 게시합니다.
        s=state()
        if not s['state']['approved']:raise ai.EditorError('승인된 원고만 홈에 게시할 수 있습니다.',409)
        result=publisher.publish(current.get(),s['article'],s['factSheet'],ai.now())
        write('approval',dict(read('approval'),published=True,publishedAt=ai.now()))
        return dict(state(),publishResult=result)
    raise ai.EditorError('지원하지 않는 기능입니다.',404)

def list_artists():
    found=[]
    for f in sorted((ROOT/'articles/drafts').glob('*.json')):
        if not ARTIST_ID.fullmatch(f.stem):continue
        try:artist=json.loads(f.read_text(encoding='utf-8-sig')).get('artist') or {}
        except (ValueError,OSError):artist={}
        found.append({'id':f.stem,'name':artist.get('name') or f.stem,'nameKo':artist.get('nameKo') or ''})
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
                    if len(raw)>publisher.MAX_PHOTO:raise ai.EditorError('사진은 8MB 이하로 올려 주세요.',413)
                path=publisher.save_photo(current.get(),bytes(raw))
                write('draft',dict(draft,photo=path,photoUpdatedAt=ai.now()))
                return reply(state())
            raw=bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw)>(100000 if name in ('fact-edit','research-one') else 50000):raise ai.EditorError('요청이 너무 큽니다.',413)
            try:data=json.loads(raw or b'{}')
            except (ValueError,UnicodeDecodeError):raise ai.EditorError('올바른 JSON 요청이 아닙니다.',400) from None
            if not isinstance(data,dict):raise ai.EditorError('JSON 객체가 필요합니다.',400)
            current.set(artist_id(data.get('artist')))
            return reply(await action(name,data))
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
    if asset not in ('app.js','style.css','fonts/Galmuri9.woff2'):return reply({'error':'파일 없음'},404)
    return await static(request,ROOT/'fonts/Galmuri9.woff2' if asset.startswith('fonts/') else ROOT/'admin'/asset)

@router.get('/site/{asset:path}')
async def preview(asset:str,request:Request):
    allowed=asset in ('index.html','artist-jack-white.html','style.css') or re.fullmatch(r"(images|fonts)/[\w가-힣 .'-]+\.(png|jpe?g|webp|woff2?|otf)",asset,re.I)
    if not allowed:return reply({'error':'허용되지 않은 파일입니다.'},404)
    path=(ROOT/asset).resolve()
    if not path.is_relative_to(ROOT.resolve()):return reply({'error':'파일 없음'},404)
    return await static(request,path)


