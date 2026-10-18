import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import tempfile
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from . import ai

ROOT=Path(__file__).resolve().parent.parent
router=APIRouter()
lock=asyncio.Lock()
ARTIST={'name':'Jack White','nameKo':'잭 화이트'}
PATHS={'draft':'articles/drafts/jack-white.json','sheet':'articles/research/jack-white.json','review':'articles/reviews/jack-white.json','editorial':'articles/reviews/jack-white-editorial.json','approval':'articles/approvals/jack-white.json'}
CSP="default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; connect-src 'self'; frame-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'"

def read(key, default=None):
    try:return json.loads((ROOT/PATHS[key]).read_text(encoding='utf-8-sig'))
    except FileNotFoundError:return default

def write(key, value):
    path=ROOT/PATHS[key];path.parent.mkdir(parents=True,exist_ok=True)
    # 같은 폴더의 임시 파일을 교체해 불완전한 JSON이 남지 않게 한다.
    fd,tmp=tempfile.mkstemp(prefix=path.stem+'.',suffix='.tmp',dir=path.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as f:json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n')
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def valid(a):
    return isinstance(a,dict) and all(isinstance(a.get(k),str) and a[k].strip() and len(a[k])<=limit for k,limit in [('title',300),('body',15000)])

def normalize(a):return {'title':a['title'].strip(),'body':a['body'].strip()}

def fingerprint(a):
    # JS JSON.stringify와 키 순서·UTF-8·줄바꿈을 동일하게 유지한다.
    return hashlib.sha256(json.dumps(normalize(a),ensure_ascii=False,separators=(',',':')).encode('utf-8')).hexdigest()

def state():
    article=read('draft');sheet=read('sheet');review=read('review');editorial=read('editorial');approval=read('approval')
    h=fingerprint(article) if valid(article) else None
    research=bool(h and sheet and sheet.get('articleHash')==h and isinstance(sheet.get('facts'),list))
    verified=bool(research and not sheet.get('truncated') and sheet['facts'] and all(f.get('verificationStatus') in ('VERIFIED','OPINION') for f in sheet['facts']))
    fact=bool(verified and review and review.get('articleHash')==h and review.get('researchHash')==sheet['articleHash'])
    edit=bool(h and editorial and editorial.get('articleHash')==h)
    approved=bool(fact and edit and approval and approval.get('articleHash')==h and approval.get('status')=='approved' and not review.get('issues') and not editorial.get('issues'))
    return dict(article=article,factSheet=sheet if research else None,review=review if research and review and review.get('articleHash')==h else None,editorialReview=editorial if edit else None,approval=approval if approved else None,state=dict(approved=approved,factCurrent=fact,researchCurrent=research,allVerified=verified,editorialCurrent=edit,status='approved' if approved else 'draft',published=False))

def invalidate():write('approval',dict(status='draft',approved=False,invalidatedAt=ai.now()))

def saved_article(data):
    article=data.get('article')
    if not valid(article):raise ai.EditorError('기사 제목 또는 본문을 확인하세요.',400)
    saved=read('draft')
    if not valid(saved) or fingerprint(saved)!=fingerprint(article):raise ai.EditorError('현재 편집 내용을 먼저 저장하세요.',409)
    return saved

def save_review(article,sheet,result):
    h=fingerprint(article)
    write('review',dict(result,articleHash=h,researchHash=sheet['articleHash']))

async def action(name,data):
    if name=='generate':raise ai.EditorError('AI 기사 자동 생성은 사용하지 않습니다. 에디터가 초안을 직접 작성하세요.',410)
    if name=='save':
        if not valid(data.get('article')):raise ai.EditorError('기사 제목 또는 본문을 확인하세요.',400)
        old=read('draft',{}) or {}
        write('draft',dict(old,id='jack-white',artist=ARTIST,**normalize(data['article']),factIds=[],status='draft',reviewed=False))
        invalidate();return state()
    if name=='research':
        article=saved_article(data);h=fingerprint(article);sheet=read('sheet')
        if not sheet or sheet.get('articleHash')!=h or not isinstance(sheet.get('facts'),list):
            extracted=await ai.extract(normalize(article))
            if not extracted.get('claims'):raise ai.EditorError('검증할 사실 주장을 찾지 못했습니다.',422)
            facts=[]
            for i,c in enumerate(extracted['claims']):
                f=ai.new_fact(c,f'F{i+1:03d}')
                if f['type']=='opinion':ai.opinion(f)
                else:f.update(failureType='PENDING',reason='아직 조사하지 않았습니다.')
                facts.append(f)
            sheet=dict(artist={'name':'기사 기반 자료'},articleHash=h,facts=facts,truncated=extracted['truncated'],generatedAt=ai.now(),note='같은 대상을 다루는 주장끼리 묶어 조사합니다.')
            write('sheet',sheet);invalidate();return state()
        first=next((f for f in sheet['facts'] if f.get('failureType')=='PENDING'),None)
        if first is None:
            # 의견만 있는 원고도 사실 검토를 완료할 수 있도록 한다.
            save_review(article,sheet,await ai.review(article,sheet));invalidate();return state()
        batch=[f for f in sheet['facts'] if f.get('failureType')=='PENDING' and (f['id']==first['id'] or first.get('group') and f.get('group')==first['group'])][:8]
        results=await ai.verify(batch,[f['id'] for f in batch],[],normalize(article))
        by_id={f['id']:f for f in results}
        for f in batch:
            if f['id'] not in by_id:by_id[f['id']]=dict(f,failureType='SEARCH_FAILED',checkedAt=ai.now(),reason='조사 응답에서 항목이 누락되었습니다. 재검색하세요.')
        sheet['facts']=[by_id.get(f['id'],f) for f in sheet['facts']];sheet['generatedAt']=ai.now()
        write('sheet',sheet);invalidate()
        if not any(f.get('failureType')=='PENDING' for f in sheet['facts']):save_review(article,sheet,await ai.review(article,sheet))
        return state()
    if name=='research-one':
        article=read('draft');sheet=read('sheet')
        if not valid(article) or not sheet or sheet.get('articleHash')!=fingerprint(article):raise ai.EditorError('현재 저장된 원고의 팩트시트가 필요합니다.',409)
        old=next((f for f in sheet['facts'] if f['id']==data.get('factId')),None)
        if not old:raise ai.EditorError('검증 항목을 찾지 못했습니다.',404)
        if old.get('failureType')=='PENDING' or old.get('verificationStatus')=='OPINION':raise ai.EditorError('이 항목은 개별 재검색 대상이 아닙니다.',409)
        sources=old.get('sources') or [];attempts=old.get('attempts') or []
        excluded=list(dict.fromkeys(s['url'] for s in sources+[s for a in attempts for s in a.get('sources',[])] if s.get('url')))[:50]
        result=(await ai.verify([old],[old['id']],excluded,normalize(article)))[0]
        result['sources']=sources+[s for s in result['sources'] if s['url'] not in {o['url'] for o in sources}]
        result['attempts']=attempts+[{k:old.get(k) for k in ('checkedAt','verificationStatus','failureType','reason','sources')}]
        if old.get('verificationStatus')=='VERIFIED' and result['verificationStatus']!='VERIFIED':
            for k in ('verificationStatus','source','evidence','reason','suggestion','failureType'):result[k]=old.get(k)
        sheet['facts']=[result if f['id']==old['id'] else f for f in sheet['facts']];sheet['generatedAt']=ai.now()
        write('sheet',sheet);invalidate();save_review(article,sheet,await ai.review(article,sheet));return state()
    if name in ('review','editorial','recheck'):
        article=saved_article(data);h=fingerprint(article)
        if name in ('review','recheck'):
            sheet=read('sheet')
            if not sheet or sheet.get('articleHash')!=h:raise ai.EditorError('먼저 현재 원고로 팩트시트 생성 및 웹 검증을 진행하세요.',409)
            save_review(article,sheet,await ai.review(article,sheet))
        if name in ('editorial','recheck'):write('editorial',dict(await ai.editorial(normalize(article)),articleHash=h))
        invalidate();return state()
    if name=='approve':
        if data.get('confirmSources') is not True:raise ai.EditorError('실제 출처 확인 및 최종 검토 확인이 필요합니다.',400)
        article=saved_article(data);s=state()
        if not all(s['state'][k] for k in ('factCurrent','allVerified','editorialCurrent')):raise ai.EditorError('저장된 기사 버전의 사실 검수와 편집 검토를 모두 완료해야 합니다.',409)
        if s['review'].get('issues') or s['editorialReview'].get('issues'):raise ai.EditorError('검토 지적 사항이 남아 있습니다. 수정 후 재검수하세요.',409)
        write('approval',dict(articleId='jack-white',articleHash=fingerprint(article),status='approved',approved=True,confirmedSources=True,approvedAt=ai.now(),published=False));return state()
    raise ai.EditorError('지원하지 않는 기능입니다.',404)

def local_host(request):
    return request.headers.get('host','').lower() in ('localhost:8000','127.0.0.1:8000')

def reply(data,status=200):return JSONResponse(data,status_code=status,headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})

@router.api_route('/local/{name}',methods=['GET','POST'])
async def endpoint(name:str,request:Request):
    if not local_host(request):return reply({'error':'로컬 접근만 허용합니다.'},403)
    if not os.getenv('ADMIN_SECRET'):return reply({'error':'.env에 ADMIN_SECRET을 설정하고 서버를 다시 실행하세요.'},503)
    if request.method=='POST' and request.headers.get('origin') not in ('http://localhost:8000','http://127.0.0.1:8000'):return reply({'error':'허용되지 않은 요청 출처입니다.'},403)
    try:
        # 요청별 변경을 직렬화: 조사 중 저장/승인 경합으로 잘못된 버전이 승인되는 것을 막는다.
        async with lock:
            if request.method=='GET':
                if name=='data':return reply(state())
                if name=='publication-export':
                    s=state()
                    if not s['state']['approved']:raise ai.EditorError('현재 저장된 원고의 승인과 두 검토가 필요합니다.',409)
                    article=s['article'];return reply(dict({k:article.get(k) for k in ('id','artist','title','body','factIds')},editorialStatus='approved',published=False,approvedAt=s['approval']['approvedAt']))
                raise ai.EditorError('경로를 찾지 못했습니다.',404)
            raw=bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw)>50000:raise ai.EditorError('요청이 너무 큽니다.',413)
            try:data=json.loads(raw or b'{}')
            except (ValueError,UnicodeDecodeError):raise ai.EditorError('올바른 JSON 요청이 아닙니다.',400) from None
            if not isinstance(data,dict):raise ai.EditorError('JSON 객체가 필요합니다.',400)
            return reply(await action(name,data))
    except ai.EditorError as e:return reply({'error':str(e)},e.status)
    except Exception:
        logging.exception('편집실 처리 실패')
        return reply({'error':'편집실 처리에 실패했습니다. 서버 터미널을 확인하세요.'},500)

async def static(request,path,csp=False):
    if not local_host(request):return reply({'error':'로컬 접근만 허용합니다.'},403)
    if not path.is_file():return reply({'error':'파일 없음'},404)
    headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}
    if csp:headers['Content-Security-Policy']=CSP
    return FileResponse(path,headers=headers)

@router.get('/editor')
async def redirect():return RedirectResponse('/editor/')

@router.get('/editor/')
async def home(request:Request):return await static(request,ROOT/'admin/index.html',True)

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

