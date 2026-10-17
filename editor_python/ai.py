"""Python 구현: 기존 JSON 스키마·프롬프트와 출처 본문 대조를 유지한다."""
import asyncio
import html
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import unicodedata
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, urljoin, unquote
import httpx

CONFIG = json.loads(Path(__file__).with_name('prompts.json').read_text(encoding='utf-8'))

class EditorError(Exception):
    def __init__(self, message, status=422):
        super().__init__(message)
        self.status = status

def now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

async def response(instructions, payload, schema, name, tokens=6500, search=False):
    key = os.getenv('OPENAI_API_KEY')
    if not key:
        raise EditorError('OpenAI API 키가 설정되지 않았습니다.', 503)
    body = dict(model=os.getenv('OPENAI_MODEL') or 'gpt-5-mini', reasoning={'effort': 'low'},
                instructions=instructions, input=json.dumps(payload, ensure_ascii=False), max_output_tokens=tokens,
                text={'format': {'type': 'json_schema', 'name': name, 'strict': True, 'schema': schema}})
    if search:
        body.update(tools=[{'type': 'web_search', 'search_context_size': 'medium'}],
                    include=['web_search_call.action.sources'], tool_choice='required')
    try:
        async with httpx.AsyncClient(timeout=180, trust_env=False) as client:
            result = await client.post('https://api.openai.com/v1/responses',
                headers={'Authorization': 'Bearer '+key}, json=body)
            if result.status_code != 200:
                raise EditorError(f'OpenAI 요청 실패 (HTTP {result.status_code}). 키·사용량·모델 설정을 확인하세요.', 502)
            raw = result.json()
    except httpx.HTTPError:
        raise EditorError('OpenAI 연결 실패 또는 응답 시간 초과입니다.', 502) from None
    if raw.get('status') != 'completed':
        raise EditorError('AI 응답이 완료되지 않았습니다. ('+str((raw.get('incomplete_details') or {}).get('reason',raw.get('status')))+')',502)
    text = ''.join(p.get('text','') for o in raw.get('output',[]) for p in o.get('content',[]) if p.get('type')=='output_text')
    try:
        parsed = json.loads(text)
        if not isinstance(parsed, dict):
            raise ValueError()
    except (ValueError, TypeError):
        raise EditorError('AI 응답 JSON을 해석하지 못했습니다.',502) from None
    return parsed, raw

async def structured(kind, payload, schema, tokens=6500):
    parsed, _ = await response(CONFIG[kind],payload,CONFIG[schema],kind,tokens)
    return parsed

def canonical(raw):
    try:
        u=urlsplit(raw)
        host=u.hostname or ''
        if u.scheme!='https' or not host or '.' not in host or u.username or u.password or u.port not in (None,443) or host.endswith('.local'):
            raise ValueError()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError()
        query=urlencode([(k,v) for k,v in parse_qsl(u.query,keep_blank_values=True) if not re.match(r'utm_|fbclid$|gclid$',k,re.I)])
        return urlunsplit(('https',host,u.path or '/',query,''))
    except (ValueError,TypeError):
        raise EditorError('허용되지 않는 출처 URL') from None

def match_key(raw):
    u=urlsplit(canonical(raw)); host=re.sub(r'^www\.', '',u.hostname)
    host=host.replace('.m.wikipedia.org','.wikipedia.org')
    return host+(u.path.rstrip('/') or '/')+('?' + u.query if u.query else '')

class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, address):
        super().__init__(host, timeout=15, context=ssl.create_default_context())
        self.address=address
    def connect(self):
        sock=socket.create_connection((self.address,443),self.timeout)
        self.sock=self._context.wrap_socket(sock,server_hostname=self.host)

def safe_get(raw, redirects=0):
    url=canonical(raw); u=urlsplit(url)
    addresses=list(dict.fromkeys(x[4][0] for x in socket.getaddrinfo(u.hostname,443,type=socket.SOCK_STREAM)))
    if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
        raise EditorError('사설망 주소 차단')
    # 검사한 IP로 고정해 연결하되 TLS 인증서와 SNI는 원래 호스트로 검증한다.
    conn=PinnedHTTPS(u.hostname, addresses[0])
    try:
        conn.request('GET',urlunsplit(('', '',u.path,u.query,'')),headers={'User-Agent':'TodaysRockEditorialResearch/2.0','Accept':'text/html, text/plain, application/json','Accept-Encoding':'identity'})
        r=conn.getresponse()
        if r.status in (301,302,303,307,308) and r.getheader('Location'):
            if redirects>=3: raise EditorError('출처 페이지 리다이렉트 초과')
            return safe_get(urljoin(url,r.getheader('Location')), redirects+1)
        if r.status!=200: raise EditorError(f'출처 페이지 HTTP {r.status}')
        content_type=r.getheader('Content-Type','')
        return r.read(2_000_000).decode('utf-8',errors='replace'),content_type
    finally:
        conn.close()

def html_text(body):
    main=re.search(r'<article\b[\s\S]*</article>',body,re.I) or re.search(r'<main\b[\s\S]*</main>',body,re.I)
    if main and len(main[0])>2000: body=main[0]
    body=re.sub(r'<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[^>]*>[\s\S]*?</\1>',' ',body,flags=re.I)
    body=re.sub(r'<!--[\s\S]*?-->',' ',body)
    body=re.sub(r'<(?:br|/p|/div|/li|/h[1-6]|/tr|/section)\b[^>]*>','\n',body,flags=re.I)
    body=html.unescape(re.sub(r'<[^>]+>',' ',body))
    return re.sub(r'\s*\n\s*','\n',re.sub(r'[ \t\f\v]+',' ',body)).strip()

def page_text(url):
    u=urlsplit(canonical(url)); wiki=re.fullmatch(r'([a-z-]+)\.(?:m\.)?wikipedia\.org',u.hostname)
    if wiki and u.path.startswith('/wiki/'):
        target='https://'+wiki[1]+'.wikipedia.org/w/api.php?'+urlencode(dict(action='query',prop='extracts',explaintext='1',redirects='1',format='json',formatversion='2',titles=unquote(u.path[6:])))
        body,_=safe_get(target)
        pages=json.loads(body).get('query',{}).get('pages',[])
        text=pages[0].get('extract','') if pages else ''
    else:
        if u.path.lower().endswith('.pdf'): raise EditorError('PDF 출처는 직접 확인해 주세요.')
        body,typ=safe_get(url)
        if 'pdf' in typ or not re.search(r'text/html|text/plain|xhtml',typ,re.I): raise EditorError('텍스트 페이지가 아닙니다.')
        text=body if 'text/plain' in typ else html_text(body)
    if len(re.sub(r'\s+',' ',text))<150: raise EditorError('읽을 수 있는 본문이 거의 없습니다.')
    return text

def passages(text, keywords, limit=14000):
    text=re.sub(r'[ \t]+',' ',text)
    if len(text)<=limit: return text
    terms={str(k).lower().strip() for k in keywords if len(str(k).strip())>=2}
    parts=[]
    for p in re.split(r'\n+',text):
        if len(p)<=1200: parts.append(p); continue
        buf=''
        for sentence in re.split(r'(?<=[.!?])\s+',p):
            if len(buf+sentence)>1000 and buf: parts.append(buf); buf=''
            buf+=(' ' if buf else '')+sentence
        if buf: parts.append(buf)
    ranked=sorted(range(len(parts)),key=lambda i: (-(sum((2 if len(t)>=5 else 1) for t in terms if t in parts[i].lower())+(i<3)),i))
    chosen=[];used=0
    for i in ranked:
        if used+len(parts[i])+1>limit: continue
        chosen.append(i);used+=len(parts[i])+1
    return '\n'.join(parts[i] for i in sorted(chosen))[:limit] or text[:limit]

def evidence(text, quote):
    def norm(v): return ''.join(c for c in unicodedata.normalize('NFKC',str(v)).lower() if c.isalnum())
    q=norm(quote)
    if len(q)<8:return ''
    chars=[];positions=[]
    for i,c in enumerate(text):
        for unit in norm(c): chars.append(unit);positions.append(i)
    at=''.join(chars).find(q)
    return text[positions[at]:positions[at+len(q)-1]+1].strip() if at>=0 else ''

async def extract(article):
    result=await structured('extract',{'article':article},'claimSchema',14000)
    claims=[];seen=set()
    for c in result.get('claims',[]):
        key=re.sub(r'\s+','',c.get('claim','')).lower()
        if not key or key in seen: continue
        seen.add(key)
        claims.append(dict(claim=c['claim'].strip(),field='title' if c.get('field')=='title' else 'body',excerpt=c.get('excerpt') or c['claim'],type=c.get('type') if c.get('type') in ('fact','interpretation','opinion') else 'fact',group=str(c.get('group') or 'G1')[:20],keywords=[str(k).strip() for k in c.get('keywords',[]) if str(k).strip()][:12]))
    return {'claims':claims[:40],'truncated':len(claims)>40}

async def search_sources(claims, excluded):
    instructions='음악 기사 출처 조사자입니다. 영어권 대상은 영어로 검색하세요. 공식 사이트·음반사·시상식 기관, 신뢰할 만한 음악 매체를 우선하세요. PDF·로그인 페이지를 피하고 제외 목록에 없는 실제 검색 결과 URL만 최대 5개 선정하세요. URL을 지어내거나 수정하지 마세요.'
    proposed,raw=await response(instructions,{'claims':claims,'excludeUrls':excluded},CONFIG['searchSchema'],'source_candidates',6000,True)
    discovered={}
    for item in raw.get('output',[]):
        sources=(item.get('action') or {}).get('sources',[]) if item.get('type')=='web_search_call' else []
        sources+= [a for p in item.get('content',[]) for a in p.get('annotations',[])]
        for s in sources:
            try: discovered[match_key(s.get('url'))]=s
            except EditorError: pass
    excluded_keys=set()
    for u in excluded:
        try: excluded_keys.add(match_key(u))
        except EditorError: pass
    results=[];seen=set()
    for candidate in proposed.get('sources',[])+list(discovered.values()):
        try:
            k=match_key(candidate.get('url'));found=discovered.get(k)
            if not found or k in excluded_keys or k in seen:continue
            seen.add(k);url=canonical(found['url'])
            results.append({'url':url,'publisher':candidate.get('publisher') or urlsplit(url).hostname})
        except EditorError:continue
        if len(results)>=5: break
    return results

def new_fact(c, identifier):
    return dict(id=identifier,claim=c['claim'],field=c.get('field','body'),excerpt=c.get('excerpt') or c['claim'],type=c.get('type','fact'),group=c.get('group'),keywords=c.get('keywords',[]),verificationStatus='NOT CHECKED',source=None,sources=[],evidence='',reason='',suggestion='',checkedAt=None,failureType=None)

def opinion(f):
    f.update(verificationStatus='OPINION',failureType=None,checkedAt=now(),reason='평론적 표현입니다. 사실 검증 대상이 아니며, 표현의 적절성은 편집자가 판단합니다.')

async def verify(claims, ids, excluded, article):
    facts=[new_fact(c,i) for c,i in zip(claims,ids)]
    targets=[]
    for f in facts:
        if f['type']=='opinion': opinion(f)
        else:targets.append(f)
    if not targets:return facts
    try: candidates=await search_sources(targets,excluded)
    except EditorError as e:
        if e.status==503:raise
        candidates=[]
    readable=0
    for candidate in candidates:
        pending=[f for f in targets if f['verificationStatus']!='VERIFIED']
        if not pending or readable>=3:break
        try: content=await asyncio.to_thread(page_text,candidate['url'])
        except Exception:
            for f in pending:f['sources'].append(dict(**candidate,verificationStatus='NOT CHECKED',evidence='',reason='출처 본문 접근 실패. 링크를 직접 확인하세요.',failureType='SOURCE_ACCESS_FAILED'))
            continue
        readable+=1
        try:
            result=await structured('verdict',dict(claims=[{k:f[k] for k in ('id','type','claim','excerpt')} for f in pending],articleContext=(article['title']+'\n'+article['body'])[:3500],sourceText=passages(content,[k for f in pending for k in f['keywords']+f['claim'].split()])), 'groupVerdictSchema')
            by_id={v['id']:v for v in reversed(result.get('results',[]))}
        except EditorError:
            for f in pending:f['sources'].append(dict(**candidate,verificationStatus='NOT CHECKED',evidence='',reason='판정 AI 오류',failureType='VERIFY_FAILED'))
            continue
        for f in pending:
            v=by_id.get(f['id'],dict(verdict='INSUFFICIENT',reason='판정 결과 누락',evidence='',suggestion=''))
            anchored=evidence(content,v.get('evidence',''))
            status=v.get('verdict','INSUFFICIENT')
            reason=v.get('reason','')
            if status not in ('VERIFIED','CONTRADICTED','INSUFFICIENT'):status='INSUFFICIENT'
            if status!='INSUFFICIENT' and not anchored:
                status='INSUFFICIENT';reason='AI 인용문을 실제 출처 본문에서 찾지 못했습니다. '+reason
            s=dict(**candidate,verificationStatus=status,evidence=anchored,reason=reason,suggestion=v.get('suggestion',''))
            f['sources'].append(s)
            if status=='VERIFIED':
                f.update(verificationStatus='VERIFIED',source=candidate.copy(),evidence=anchored,reason=reason,suggestion=v.get('suggestion',''))
    for f in targets:
        sources=[s for s in f['sources'] if not s.get('failureType')]
        yes=[s for s in sources if s['verificationStatus']=='VERIFIED'];no=[s for s in sources if s['verificationStatus']=='CONTRADICTED']
        f['checkedAt']=now()
        if yes and no:f.update(verificationStatus='INSUFFICIENT',failureType='CONFLICTING_EVIDENCE',reason='출처 사이에 내용이 엇갈립니다. '+' / '.join(s['reason'] for s in sources),suggestion='출처를 직접 비교해 주세요.')
        elif yes:f['failureType']=None
        elif no:
            s=no[0];f.update(verificationStatus='CONTRADICTED',failureType='SOURCE_CONTRADICTS',source={k:s[k] for k in ('url','publisher')},evidence=s['evidence'],reason=s['reason'],suggestion=s.get('suggestion') or '출처와 원고를 대조해 주세요.')
        elif sources:f.update(verificationStatus='INSUFFICIENT',failureType='EVIDENCE_INSUFFICIENT',reason=' / '.join(s['publisher']+': '+s['reason'] for s in sources),suggestion='출처 재검색 또는 원문 확인이 필요합니다.')
        elif f['sources']:f.update(verificationStatus='NOT CHECKED',failureType='SOURCE_ACCESS_FAILED',reason='찾은 출처 본문을 확인하지 못했습니다.',suggestion='브라우저에서 출처를 직접 확인하거나 재검색하세요.')
        else:f.update(verificationStatus='NOT CHECKED',failureType='SEARCH_FAILED',reason='웹 검색에서 출처 후보를 확보하지 못했습니다.',suggestion='재검색하세요. 검색 실패는 사실이 틀렸다는 뜻이 아닙니다.')
    return facts

def label(facts):
    states=[f.get('verificationStatus') for f in facts]
    if 'CONTRADICTED' in states:return '사실 불일치'
    if any(f.get('failureType')=='CONFLICTING_EVIDENCE' for f in facts):return '출처 충돌'
    check=[f for f in facts if f.get('verificationStatus')!='OPINION']
    if not check:return '평론적 표현'
    if any(f.get('verificationStatus')=='NOT CHECKED' for f in check):return '미검증'
    if any(f.get('verificationStatus')!='VERIFIED' for f in check):return '일부 확인' if 'VERIFIED' in states else '근거 부족'
    if len(check)<len(facts):return '확인 + 평가'
    return '해석 (출처 확인)' if all(f.get('type')=='interpretation' for f in check) else '확인'

async def review(article,sheet):
    facts=sheet['facts']
    issues=[dict(field=f.get('field','body'),text=f.get('excerpt') or f['claim'],verdict=f.get('verificationStatus','NOT CHECKED'),reason=f.get('reason') or '출처 본문에서 직접 확인하지 못했습니다.',suggestion=f.get('suggestion') or '원출처를 직접 확인하세요.',factIds=[f['id']]) for f in facts if f.get('verificationStatus') not in ('VERIFIED','OPINION')]
    report=None
    if facts and not any(f.get('failureType')=='PENDING' for f in facts):
        try:
            result=await structured('report',{'article':article,'facts':facts},'reportSchema')
            by_id={f['id']:f for f in facts};used=set();rows=[]
            for row in result.get('rows',[]):
                ids=list(dict.fromkeys(i for i in row.get('factIds',[]) if i in by_id and i not in used))
                if not ids:continue
                used.update(ids);refs=[by_id[i] for i in ids];verdict=label(refs)
                if row.get('needsWording') and verdict in ('확인','확인 + 평가','해석 (출처 확인)'):verdict+=' · 표현 보완'
                rows.append(dict(text=row['text'],factIds=ids,verdict=verdict,note=row['note'],sources=[f['source'] for f in refs if f.get('source')]))
            for f in facts:
                if f['id'] not in used:rows.append(dict(text=f.get('excerpt') or f['claim'],factIds=[f['id']],verdict=label([f]),note=f.get('reason',''),sources=[f['source']] if f.get('source') else []))
            order={f['id']:i for i,f in enumerate(facts)};rows.sort(key=lambda r:min(order[i] for i in r['factIds']))
            corrections=[]
            for c in result.get('corrections',[]):
                refs=[by_id[i] for i in c.get('factIds',[]) if i in by_id]
                if not refs or any(f.get('verificationStatus')!='VERIFIED' or f.get('suggestion') for f in refs):corrections.append(c)
            report=dict(overall=result['overall'],rows=rows,corrections=corrections,generatedAt=now())
        except EditorError:pass
    return dict(articleId=article.get('id','jack-white'),status='needs_review',issues=issues,report=report,approved=False,note='외부 출처 기반 AI 보조 검수입니다. 사람의 원출처 확인이 필요합니다.')

async def editorial(article):
    r=await structured('editorial',{'article':article},'editorialSchema')
    if not isinstance(r.get('issues'),list):raise EditorError('편집 검토 결과 형식 오류',502)
    return dict(type='editorial',issues=r['issues'][:5],approved=False,note='AI 편집 의견입니다. 사실 검수 및 편집자 승인을 대체하지 않습니다.')
