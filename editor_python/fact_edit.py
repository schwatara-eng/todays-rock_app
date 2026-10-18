"""팩트시트의 추출 오류를 항목별로 수정한다. AI 호출과 판정 승격은 하지 않는다."""
import copy
import hashlib
import json
import re
from . import ai


def fingerprint(sheet):
    fields={key:sheet.get(key) for key in ('articleHash','facts','excludedFacts','manualRevision','truncated')}
    return hashlib.sha256(json.dumps(fields,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')).hexdigest()


def next_number(sheet):
    facts=list((sheet or {}).get('facts',[]))+[r['fact'] for r in (sheet or {}).get('excludedFacts',[])]
    for event in (sheet or {}).get('manualHistory',[]):
        facts.extend(f for f in (event.get('before'),event.get('after')) if f)
    return max([int(f['id'][1:]) for f in facts if re.fullmatch(r'F\d+',str(f.get('id','')))]+[0])+1


def anchor(excerpt, field, article):
    normalize=lambda value:re.sub(r'\s+',' ',value).strip()
    return bool(excerpt and normalize(excerpt) in normalize(article[field]))


def content(data, article):
    result={}
    for key, limit in (('claim',1500),('excerpt',6000)):
        value=data.get(key)
        if not isinstance(value,str) or not value.strip() or len(value)>limit:
            raise ai.EditorError('검증할 주장과 원고 근거 문장을 입력하세요. 길이는 각각 1,500자·6,000자 이하여야 합니다.',400)
        result[key]=value.strip()
    if data.get('type') not in ('fact','opinion'):
        raise ai.EditorError('분류는 사실 또는 평론만 선택하세요.',400)
    if data.get('field') not in ('title','body'):
        raise ai.EditorError('원고 위치는 제목 또는 본문을 선택하세요.',400)
    result.update(type=data['type'],field=data['field'])
    if not anchor(result['excerpt'],result['field'],article):
        raise ai.EditorError('근거 문장은 선택한 원고 위치에서 그대로 복사하세요. 원고에 없는 문장으로 연결할 수 없습니다.',400)
    keywords=data.get('keywords',[])
    if not isinstance(keywords,list) or len(keywords)>12 or any(not isinstance(k,str) or len(k)>100 for k in keywords):
        raise ai.EditorError('검색어는 100자 이하의 단어를 최대 12개까지 입력하세요.',400)
    result['keywords']=list(dict.fromkeys(k.strip() for k in keywords if k.strip()))
    return result


def reset(claim, identifier):
    fact=ai.new_fact(claim,identifier)
    fact.update(manuallyEdited=True,editedAt=ai.now())
    # 수동 항목은 단독으로 검증한다. 기존의 부정확한 주장 묶음에 다시 합치지 않는다.
    fact['group']='manual-'+identifier
    if fact['type']=='opinion':
        ai.opinion(fact)
        fact.update(source=None,sources=[],evidence='',suggestion='')
    else:
        fact.update(failureType='PENDING',reason='추출 항목을 수정했습니다. 이 항목만 검증하세요.')
    return fact


def apply(sheet, article, data):
    if data.get('expectedSheetHash')!=fingerprint(sheet):
        raise ai.EditorError('팩트시트가 다른 작업에서 변경됐습니다. 새로고침한 뒤 다시 수정하세요.',409)
    operation=data.get('operation')
    if operation not in ('edit','add','exclude','restore'):
        raise ai.EditorError('지원하지 않는 항목 수정 방식입니다.',400)
    reason=data.get('reason','')
    if not isinstance(reason,str) or len(reason)>600:
        raise ai.EditorError('변경 사유는 600자 이하로 입력하세요.',400)
    reason=reason.strip()
    if operation=='exclude' and not reason:
        raise ai.EditorError('검증에서 제외하는 이유를 입력하세요.',400)
    result=copy.deepcopy(sheet)
    facts=result['facts'];excluded=result.setdefault('excludedFacts',[])
    previous=None;new=None
    if operation=='add':
        item=content(data,article)
        number=next_number(result)
        new=reset(item,f'F{number:03d}');facts.append(new)
    elif operation=='restore':
        record=next((r for r in excluded if r['fact'].get('id')==data.get('factId')),None)
        if record is None:raise ai.EditorError('제외된 항목을 찾지 못했습니다.',404)
        previous=record['fact']
        if not anchor(previous.get('excerpt',''),previous.get('field','body'),article):
            raise ai.EditorError('이 항목의 근거 문장이 현재 원고에 없습니다. 항목 추가로 다시 입력하세요.',409)
        if any(f['id']==previous['id'] for f in facts):raise ai.EditorError('동일한 항목 ID가 이미 사용 중입니다.',409)
        new=reset(previous,previous['id'])
        facts.insert(min(record.get('position',len(facts)),len(facts)),new);excluded.remove(record)
    else:
        index=next((i for i,f in enumerate(facts) if f.get('id')==data.get('factId')),None)
        if index is None:raise ai.EditorError('수정할 항목을 찾지 못했습니다.',404)
        previous=facts[index]
        if operation=='exclude':
            excluded.append(dict(fact=previous,reason=reason,excludedAt=ai.now(),position=index));facts.pop(index)
        else:
            item=content(data,article)
            if all(item[key]==previous.get(key,[] if key=='keywords' else '') for key in item):
                raise ai.EditorError('변경된 내용이 없습니다.',400)
            new=reset(item,previous['id']);facts[index]=new
    result['manualRevision']=int(result.get('manualRevision',0))+1
    result['generatedAt']=ai.now()
    result.setdefault('manualHistory',[]).append(dict(operation=operation,reason=reason or '추출 항목 수정',at=ai.now(),before=previous,after=new))
    return result
