"""편집실의 뮤지션 사진 등록과 홈 게시를 처리합니다. 저장은 모두 Supabase DB에 합니다. (storage.py)

- 사진: images/artist-<뮤지션ID>.png|jpg|webp 경로로 DB에 저장하고 원고(draft)에 경로를 기록합니다.
- 게시: 승인된 원고로 '오늘의 뮤지션' 기사 본문을 만들어 DB에 저장합니다.
  홈(index.html)과 지난 뮤지션 페이지(artist-<ID>.html)는 요청 때마다
  저장소의 최신 디자인 파일에 DB의 기사 본문을 끼워 넣어 보여 줍니다.
  아카이브 목록(예전 artist-archive.json)도 DB에 기록하고 홈의 script.js가 /artist-archive.json으로 읽어 갑니다.
"""
import html
import json
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlsplit

from . import storage

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / 'artist-jack-white.html'   # 아카이브 페이지의 틀(머리말·꼬리말)로 씁니다.
START = '<div id="artist-current-content">'
END = '<!-- artist-current-content -->'
# Vercel은 요청·응답 크기를 4.5MB로 제한하므로 사진은 4MB까지 받습니다.
MAX_PHOTO = 4 * 1024 * 1024
PHOTO_LIMIT_MESSAGE = '사진은 4MB 이하로 올려 주세요. (큰 사진은 가로 1600px 정도로 줄이면 충분합니다)'
# 활동 제목 중 앨범명: 'N집 앨범명 (연도)', '솔로 앨범명 (연도)', '밴드 – 앨범명 (연도)'
ALBUM = re.compile(r'^(.*(?:\d+집|솔로|EP|싱글)\s+|.+\s[–—−-]\s+)(.+?)(\s*\(\d{4}[^)]*\))$')


class PublishError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


# ── 사진 ───────────────────────────────────────────────────────
def photo_ext(raw):
    """파일 이름이 아니라 실제 내용으로 이미지 종류를 확인합니다."""
    if raw.startswith(b'\x89PNG\r\n\x1a\n'): return 'png'
    if raw.startswith(b'\xff\xd8\xff'): return 'jpg'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP': return 'webp'
    return None


def save_photo(artist_id, raw):
    if not raw: raise PublishError('사진 파일이 비어 있습니다.')
    if len(raw) > MAX_PHOTO: raise PublishError(PHOTO_LIMIT_MESSAGE, 413)
    ext = photo_ext(raw)
    if not ext: raise PublishError('PNG, JPG, WEBP 사진만 등록할 수 있습니다.', 415)
    path = f'images/artist-{artist_id}.{ext}'
    types = {'png': 'image/png', 'jpg': 'image/jpeg', 'webp': 'image/webp'}
    # 같은 뮤지션의 예전 사진(다른 확장자)은 DB에서 지웁니다.
    others = [f'images/artist-{artist_id}.{old}' for old in types if old != ext]
    storage.put_asset(path, raw, types[ext], remove=others)
    return path


def clean_credit(text):
    """입력한 사진 출처를 정리합니다. 앞에 'PHOTO |'를 직접 적었으면 한 번만 붙도록 뺍니다."""
    text = re.sub(r'\s+', ' ', str(text or '')).strip()
    return re.sub(r'^PHOTO\s*[|:·]?\s*', '', text, flags=re.I).strip()


def photo_credit(article, name):
    """편집실에서 입력한 사진 출처. 입력한 적 없는 잭 화이트 원고는 예전 표기를 그대로 씁니다."""
    if 'photoCredit' in article:
        return clean_credit(article.get('photoCredit'))
    return 'AI-generated (OpenAI)' if str(name).strip().lower() == 'jack white' else ''


# ── 원고 → 기사 HTML ───────────────────────────────────────────
def split_sections(body):
    sections = {'intro': [], 'history': [], 'comment': [], 'tracks': []}
    part = 'intro'
    for line in (l.strip() for l in body.splitlines()):
        if not line: continue
        if line == '주요 앨범과 활동': part = 'history'
        elif re.fullmatch(r"(에디터 코멘트|EDITOR['’]S COMMENT)", line, re.I): part = 'comment'
        elif line == '대표곡': part = 'tracks'
        else: sections[part].append(line)
    return sections


def history_items(lines):
    """'제목: 설명' 한 줄 형식과 '제목' 다음 줄 '설명' 형식을 모두 받습니다."""
    items = []
    for text in lines:
        if ':' in text:
            title, desc = text.split(':', 1)
            items.append([title.strip(), desc.strip()])
        elif items and items[-1][1] is None:
            items[-1][1] = text
        else:
            items.append([text, None])
    return items


def verified_sources(sheet):
    """팩트시트에서 '검증 완료(VERIFIED)' 출처만, 매체별로 한 번씩 고릅니다."""
    picked = {}
    for fact in (sheet or {}).get('facts') or []:
        if fact.get('type') in ('opinion','interpretation'): continue
        sources = fact.get('sources') or ([fact['source']] if fact.get('source') else [])
        for source in sources:
            if (source.get('verificationStatus') or fact.get('verificationStatus')) != 'VERIFIED': continue
            url = str(source.get('url') or '')
            parts = urlsplit(url)
            if parts.scheme != 'https' or not parts.hostname: continue
            label = re.split(r'\s+[(\-–]', source.get('publisher') or parts.hostname.removeprefix('www.'))[0].strip()
            picked.setdefault(label, url)
    return picked


def render_feature(article, photo, sheet):
    """홈과 아카이브가 같이 쓰는 기사 본문(사진·소개·코멘트·활동·대표곡·출처)을 만듭니다."""
    e = html.escape                                   # 속성값용
    t = lambda v: html.escape(v, quote=False)        # 본문 글자용 (작은따옴표를 그대로 둠)
    artist = article.get('artist') or {}
    name, name_ko = artist.get('name') or article['title'], artist.get('nameKo') or ''
    s = split_sections(article['body'])
    norm = lambda v: re.sub(r'[\W_]+', '', v or '').lower()
    if s['intro'] and norm(s['intro'][0]) in {norm(name), norm(name_ko), norm(name_ko + name), norm(name + name_ko)}:
        s['intro'].pop(0)                         # 첫 줄이 뮤지션 이름이면 빼고 시작합니다.
    lead = s['intro'].pop(0) if s['intro'] else article['title']
    credit = photo_credit(article, name)

    out = ['     <div class="artist-editorial-grid">',
           '      <div class="artist-editorial-left">',
           '       <figure class="artist-feature-photo">',
           f'        <img src="{e(photo)}" alt="{e(name_ko or name)}" loading="lazy" />',
           *([f'        <figcaption class="artist-photo-credit">PHOTO | {t(credit)}</figcaption>'] if credit else []),
           '       </figure>',
           '      </div>',
           '      <div class="artist-editorial-right">',
           '       <div class="artist-feature-header">',
           '        <h3>',
           f'         <span lang="en" class="artist-name-main">{t(name)}</span>',
           f'         <span lang="ko" class="artist-name-sub">{t(name_ko)}</span>',
           '        </h3>',
           f'        <p class="artist-feature-lead">{t(lead)}</p>',
           '       </div>']
    out += [f'       <p class="artist-copy">{t(p)}</p>' for p in s['intro']]
    if s['comment']:
        out += ['       <div class="artist-feature-editor">',
                '        <p class="section-label">EDITOR\'S COMMENT</p>']
        out += [f'        <p>{t(p)}</p>' for p in s['comment']]
        out += ['       </div>']
    if s['history']:
        out += ['       <h4 class="artist-feature-subtitle">주요 앨범과 활동</h4>',
                '       <ul class="artist-feature-history">']
        for title, desc in history_items(s['history']):
            m = ALBUM.match(title)                # 앨범명만 이탤릭
            head = f'{t(m[1])}<em>{t(m[2])}</em>{t(m[3])}' if m else t(title)
            out.append(f'        <li><strong>{head}</strong>' + (f'<p>{t(desc)}</p>' if desc else '') + '</li>')
        out += ['       </ul>']
    if s['tracks']:
        out += ['       <div class="artist-feature-track-group">',
                '        <h4 class="artist-feature-subtitle">대표곡</h4>',
                '        <ol class="artist-feature-tracks">']
        for text in s['tracks']:
            parts = re.split(r'\s+[–—−-]\s+', text)
            song, singer = parts[0], ' – '.join(parts[1:])
            link = 'https://www.youtube.com/results?search_query=' + quote(text, safe='')
            out += ['         <li>',
                    f'          <a href="{e(link)}" target="_blank" rel="noopener noreferrer">',
                    f'           <span><strong>{t(song)}</strong>' + (f'<small>{t(singer)}</small>' if singer else '') + '</span>',
                    '           <span aria-hidden="true">↗</span>',
                    '          </a>',
                    '         </li>']
        out += ['        </ol>', '       </div>']
    out += ['      </div>', '     </div>']
    sources = verified_sources(sheet)
    if sources:
        links = ' · '.join(f'<a href="{e(u)}" target="_blank" rel="noopener noreferrer">{t(l)} ↗</a>' for l, u in sources.items())
        out.append(f'     <div class="artist-feature-sources">SOURCES {"|" if str(name).strip().lower() == "jack white" else "·"} {links}</div>')
    return '\n'.join(out)


# ── 게시 ───────────────────────────────────────────────────────
def load_archive():
    return storage.get_archive()


def splice_home(page, start, end, block):
    """index.html의 '오늘의 뮤지션' 표시 영역 안쪽을 block으로 바꿉니다."""
    return page[:start] + START + '\n' + block + '\n    </div>\n    ' + page[end:]


def home_block(page):
    """index.html에서 현재 '오늘의 뮤지션' 본문(표시 영역 안쪽)을 잘라 옵니다."""
    start, end = page.find(START), page.find(END)
    if start < 0 or end < 0 or end < start:
        raise PublishError('index.html에서 오늘의 뮤지션 영역 표시를 찾지 못했습니다.', 500)
    inner = page[start + len(START):end]
    close = inner.rfind('</div>')                 # 표시 영역 자신의 닫는 태그는 빼고 가져옵니다.
    return start, end, inner[:close].strip('\n')


def display_name(name, name_ko, korean=False):
    """한국 뮤지션은 '한글 (영문)', 그 밖에는 '영문 (한글)'."""
    if korean and name_ko:
        return f'{name_ko} ({name})' if name and name != name_ko else name_ko
    return f'{name} ({name_ko})' if name_ko else name


def archive_page(template, block, name, name_ko, korean=False):
    """아카이브 틀에 기사 본문을 넣어 지난 뮤지션 페이지를 만듭니다."""
    start = template.find('<div class="artist-editorial-grid">')
    back = template.find('archive-back-link')
    stop = template.rfind('<p', 0, back) if back >= 0 else -1
    if start < 0 or stop < start:
        raise PublishError('아카이브 틀(artist-jack-white.html)의 구조를 찾지 못했습니다.', 500)
    line_start = template.rfind('\n', 0, start) + 1
    page = template[:line_start] + block.rstrip() + '\n    ' + template[stop:]
    title = display_name(name, name_ko, korean) + ' — TODAY’S ROCK'
    return re.sub(r'<title>.*?</title>', f'<title>{html.escape(title)}</title>', page, count=1, flags=re.S)


def publish(artist_id, article, sheet, now):
    photo = article.get('photo')
    if not photo or not storage.asset_exists(photo):
        raise PublishError('게시하려면 먼저 뮤지션 사진을 등록하세요.', 409)
    artist = article.get('artist') or {}
    entry = {'id': artist_id, 'name': artist.get('name') or artist_id, 'nameKo': artist.get('nameKo') or '',
             'korean': artist.get('korean') is True}
    data = load_archive()
    data.setdefault('hidden', [])
    data['hidden'] = [a for a in data['hidden'] if a.get('id') != artist_id]
    old_data = json.dumps(data, ensure_ascii=False)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    features, history, moved = {}, [('archive', 'artist-archive.json', old_data)], None

    # 지금 홈에 걸린 기사 본문: DB에 게시한 적이 있으면 DB에서, 아니면 index.html 파일에서 가져옵니다.
    outgoing = data.get('current')
    old_block = storage.get_feature(outgoing['id']) if outgoing else None
    if outgoing and not old_block:
        old_block = home_block((ROOT / 'index.html').read_text(encoding='utf-8'))[2]
    if old_block:
        history.append(('feature', outgoing['id'] if outgoing else 'home', old_block))

    # 1) 홈에서 내려가는 뮤지션은 지난 뮤지션 목록으로 옮깁니다. (같은 뮤지션을 다시 게시하면 건너뜀)
    if outgoing and outgoing.get('id') != artist_id:
        features[outgoing['id']] = old_block
        name = f"artist-{outgoing['id']}.html"
        data['archive'] = [a for a in data.get('archive', []) if a.get('id') != outgoing['id']]
        data['archive'].insert(0, dict(outgoing, url=name))   # 최신 순
        moved = name

    # 2) 새 기사 본문을 만들어 '현재'로 둡니다. 게시한 뮤지션은 지난 목록에서 뺍니다.
    features[artist_id] = render_feature(article, photo, sheet)
    data['archive'] = [a for a in data.get('archive', []) if a.get('id') != artist_id]
    data['current'] = dict(entry, publishedAt=now, lastActivatedAt=now)

    # 3) 한 번에 저장합니다. (실패하면 아무것도 바뀌지 않음, 직전 상태는 site_history에 백업)
    storage.save_publication(data, features, history, stamp)
    return {'published': artist_id, 'archived': moved, 'backup': stamp}


def unpublish(artist_id, now):
    """공개 기사만 내리고 직전 아카이브 기사를 자동 복원합니다."""
    data = load_archive()
    outgoing = data.get('current')
    archive = list(data.get('archive') or [])
    hidden = list(data.get('hidden') or [])
    target = outgoing if outgoing and outgoing.get('id') == artist_id else next(
        (a for a in archive if a.get('id') == artist_id), None)
    if not target:
        raise PublishError('공개된 기사를 찾지 못했습니다.', 409)
    entry = dict(target, unpublishedAt=now)
    entry.pop('url', None)
    hidden = [a for a in hidden if a.get('id') != artist_id]
    hidden.insert(0, entry)
    archive = [a for a in archive if a.get('id') != artist_id]
    restored = None
    if outgoing and outgoing.get('id') == artist_id:
        restored = archive.pop(0) if archive else None
        if restored:
            restored = dict(restored)
            restored.pop('url', None)
            restored['lastActivatedAt'] = now
        data['current'] = restored
    data['archive'] = archive
    data['hidden'] = hidden
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    storage.save_publication(data, {}, [('archive', 'artist-archive.json', json.dumps(load_archive(), ensure_ascii=False))], stamp)
    return {'unpublished': artist_id, 'restored': restored['id'] if restored else None}
