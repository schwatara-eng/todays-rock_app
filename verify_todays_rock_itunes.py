#!/usr/bin/env python3
"""오늘의 록 곡 풀 iTunes 검증 스크립트 (수정본)

인터넷 되는 컴퓨터에서 CSV와 같은 폴더에 두고 실행:
    python verify_todays_rock_itunes.py

파일: todays_rock_song_candidates.csv 하나를 읽고 같은 파일에 결과를 씁니다.
- 앞쪽 열(번호·시대·구분·아티스트·곡명·검증상태)이 후보 목록입니다. 새 후보는 이 열만 채워 맨 아래에 추가하세요.
- iTunes 열은 이 스크립트가 채웁니다. 이미 확인한 곡(API오류 제외)은 다시 검색하지 않습니다.
- 정리분류·권장조치·재검색어·DB등록·DB번호 열은 사람이 정리한 기록이라 그대로 둡니다.
  (다시 검색한 곡은 iTunes 결과가 바뀔 수 있으니 이 열도 함께 확인하세요.)

변경 사항
- 요청 간격 3.2초(분당 약 19회) + 403/429/5xx 재시도(점점 길게 대기)
- 한국 곡은 KR 스토어로 검색, 결과가 없으면 US 스토어로 한 번 더 검색
- ' - Remastered 2011' 같은 대시 꼬리표도 제거해서 비교
- 같은 점수면 발매일이 가장 이른 버전(원곡에 가까운 것)을 우선
- 아티스트·곡명 둘 다 안 맞는 결과는 정보를 채우지 않음
- 25곡마다 중간 저장, 다시 실행하면 이미 처리한 곡은 건너뜀(이어하기)
"""
import csv, json, re, time, unicodedata, urllib.error, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CSV = ROOT / 'todays_rock_song_candidates.csv'   # 후보 목록 + iTunes 확인 결과 + 정리 기록 (읽고 쓰는 파일 하나)
INPUT = OUTPUT = CSV
BASE = 'https://itunes.apple.com/search?'
DELAY = 3.2          # 초. iTunes Search API 권장 한도(분당 약 20회) 안쪽
MAX_RETRY = 4
SAVE_EVERY = 25
EXTRA = ['iTunes상태', 'iTunes스토어', 'iTunes아티스트', 'iTunes곡명', 'iTunes발매일',
         'iTunes트랙ID', 'iTunes트랙URL', 'iTunes미리듣기URL', '검토메모']
VERSION_WORDS = r'remaster|remastered|live|version|edit|deluxe|feat|mono|stereo|demo|mix'


def norm(s):
    s = unicodedata.normalize('NFKC', s or '').casefold()
    # (Remastered 2011), [Live] 같은 괄호 꼬리표 제거
    s = re.sub(r'[\(\[][^)\]]*(?:' + VERSION_WORDS + r')[^)\]]*[\)\]]', '', s)
    # ' - Remastered 2011', ' - Live at ...' 같은 대시 꼬리표 제거
    s = re.sub(r'\s[-–—]\s.*(?:' + VERSION_WORDS + r').*$', '', s)
    return re.sub(r'[^0-9a-zÀ-ɏ가-힣]', '', s)


def get(term, country):
    q = urllib.parse.urlencode({'term': term, 'entity': 'song', 'media': 'music',
                                'limit': 50, 'country': country})
    req = urllib.request.Request(BASE + q, headers={'User-Agent': 'TODAYS-ROCK-Editorial-Verification/1.1'})
    wait = DELAY
    for attempt in range(MAX_RETRY + 1):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.load(r).get('results', [])
        except urllib.error.HTTPError as e:
            if e.code in (403, 429) or e.code >= 500:
                if attempt == MAX_RETRY:
                    raise
                wait = wait * 2 if attempt else 30   # 첫 차단은 30초 쉬고, 이후 두 배씩
                print(f'  HTTP {e.code} — {wait:.0f}초 대기 후 재시도', flush=True)
                time.sleep(wait)
            else:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == MAX_RETRY:
                raise
            time.sleep(10)


def match(artist, title, items):
    a, t = norm(artist), norm(title)
    ranked = []
    for x in items:
        if x.get('kind') != 'song':
            continue
        xa, xt = norm(x.get('artistName', '')), norm(x.get('trackName', ''))
        artist_ok = xa == a or (len(a) > 5 and a in xa) or (len(xa) > 5 and xa in a)
        title_ok = xt == t or (len(t) > 6 and xt.startswith(t))
        if not (artist_ok or title_ok):
            continue
        score = (3 if xa == a else 1 if artist_ok else 0) + (4 if xt == t else 1 if title_ok else 0)
        ranked.append((score, x, artist_ok, title_ok))
    if not ranked:
        return None
    # 점수 높은 순 → 미리듣기 있는 것 → 발매일 이른 것
    ranked.sort(key=lambda v: (-v[0], not v[1].get('previewUrl'), v[1].get('releaseDate') or '9999'))
    return ranked[0]


def search(row):
    a, t = row['아티스트'], row['곡명']
    stores = ['KR', 'US'] if row.get('구분') == '한국' else ['US']
    best, used = None, stores[0]
    for i, c in enumerate(stores):
        if i:
            time.sleep(DELAY)
        cand = match(a, t, get(f'{a} {t}', c))
        if cand and (best is None or cand[0] > best[0]):
            best, used = cand, c
        if best and best[2] and best[3]:
            break
    return best, used


def save(rows, fieldnames):
    tmp = OUTPUT.with_suffix('.tmp')
    with tmp.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)
    tmp.replace(OUTPUT)


def main():
    with INPUT.open(encoding='utf-8-sig', newline='') as f:
        rows = list(csv.DictReader(f))
    base_fields = list(rows[0].keys())
    fieldnames = base_fields + [k for k in EXTRA if k not in base_fields]

    # 이어하기: 이전 결과 중 API오류가 아닌 것은 재사용
    done = {}
    if OUTPUT.exists():
        with OUTPUT.open(encoding='utf-8-sig', newline='') as f:
            for r in csv.DictReader(f):
                if r.get('iTunes상태') and r['iTunes상태'] != 'API오류':
                    done[(r['아티스트'], r['곡명'])] = r
        print(f'이전 결과 {len(done)}곡 재사용', flush=True)

    for i, row in enumerate(rows, 1):
        for k in EXTRA:
            row.setdefault(k, '')
        key = (row['아티스트'], row['곡명'])
        if key in done:
            row.update({k: done[key].get(k, '') for k in EXTRA})
            continue
        try:
            best, store = search(row)
            if best:
                score, x, artist_ok, title_ok = best
                row.update({
                    'iTunes상태': '매칭후보_확인' if artist_ok and title_ok else '수동검토_필요',
                    'iTunes스토어': store,
                    'iTunes아티스트': x.get('artistName', ''),
                    'iTunes곡명': x.get('trackName', ''),
                    'iTunes발매일': (x.get('releaseDate') or '')[:10],
                    'iTunes트랙ID': x.get('trackId', ''),
                    'iTunes트랙URL': x.get('trackViewUrl', ''),
                    'iTunes미리듣기URL': x.get('previewUrl', ''),
                })
                yr, decade = row['iTunes발매일'][:4], row['시대'][:4]
                if yr.isdigit() and decade.isdigit() and int(yr) // 10 != int(decade) // 10:
                    row['검토메모'] = 'iTunes 발매일이 후보 시대와 다름; 원곡 최초 발매연도 별도 확인'
                else:
                    row['검토메모'] = 'iTunes는 원곡 최초 발매연도 증빙이 아님'
                if not (artist_ok and title_ok):
                    row['검토메모'] += '; 아티스트 또는 곡명 표기 불일치'
            else:
                row.update({'iTunes상태': '검색결과없음',
                            'iTunes스토어': '/'.join(['KR', 'US'] if row.get('구분') == '한국' else ['US']),
                            '검토메모': '다른 표기(영문·한글)로 수동 검색 필요'})
        except Exception as e:
            row.update({'iTunes상태': 'API오류', '검토메모': f'{type(e).__name__}: {str(e)[:140]}'})
        print(f'{i}/{len(rows)} {row["아티스트"]} - {row["곡명"]}: {row["iTunes상태"]}', flush=True)
        if i % SAVE_EVERY == 0:
            save(rows, fieldnames)
        time.sleep(DELAY)

    save(rows, fieldnames)
    from collections import Counter
    print('완료:', dict(Counter(r['iTunes상태'] for r in rows)))
    print('저장:', OUTPUT)


if __name__ == '__main__':
    main()
