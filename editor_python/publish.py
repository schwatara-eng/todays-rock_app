"""편집실의 뮤지션 사진 등록과 홈 게시를 처리합니다.

- 사진: images/artist-<뮤지션ID>.png|jpg|webp 로 저장하고 원고(draft)에 경로를 기록합니다.
- 게시: 승인된 원고로 index.html의 '오늘의 뮤지션' 본문을 바꾸고,
  홈에서 내려가는 기사는 artist-<뮤지션ID>.html 아카이브 페이지로 옮깁니다.
  아카이브 목록은 artist-archive.json에 기록하고 홈의 script.js가 읽어 갑니다.
"""
import html
import json
import re
import shutil
from datetime import datetime
from pathlib import Path
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_JSON = ROOT / 'artist-archive.json'
HOME = ROOT / 'index.html'
TEMPLATE = ROOT / 'artist-jack-white.html'   # 아카이브 페이지의 틀(머리말·꼬리말)로 씁니다.
START = '<div id="artist-current-content">'
END = '<!-- artist-current-content -->'
MAX_PHOTO = 8 * 1024 * 1024


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
    if len(raw) > MAX_PHOTO: raise PublishError('사진은 8MB 이하로 올려 주세요.', 413)
    ext = photo_ext(raw)
    if not ext: raise PublishError('PNG, JPG, WEBP 사진만 등록할 수 있습니다.', 415)
    folder = ROOT / 'images'
    folder.mkdir(exist_ok=True)
    for old in ('png', 'jpg', 'webp'):            # 같은 뮤지션의 예전 사진은 지웁니다.
        (folder / f'artist-{artist_id}.{old}').unlink(missing_ok=True)
    (folder / f'artist-{artist_id}.{ext}').write_bytes(raw)
    return f'images/artist-{artist_id}.{ext}'


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

    out = ['     <div class="artist-editorial-grid">',
           '      <div class="artist-editorial-left">',
           '       <figure class="artist-feature-photo">',
           f'        <img src="{e(photo)}" alt="{e(name_ko or name)}" loading="lazy" />',
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
            out.append(f'        <li><strong>{t(title)}</strong>' + (f'<p>{t(desc)}</p>' if desc else '') + '</li>')
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
        out.append(f'     <div class="artist-feature-sources">SOURCES · {links}</div>')
    return '\n'.join(out)


# ── 게시 ───────────────────────────────────────────────────────
def load_archive():
    try:
        return json.loads(ARCHIVE_JSON.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {'current': None, 'archive': []}


def home_block(page):
    """index.html에서 현재 '오늘의 뮤지션' 본문(표시 영역 안쪽)을 잘라 옵니다."""
    start, end = page.find(START), page.find(END)
    if start < 0 or end < 0 or end < start:
        raise PublishError('index.html에서 오늘의 뮤지션 영역 표시를 찾지 못했습니다.', 500)
    inner = page[start + len(START):end]
    close = inner.rfind('</div>')                 # 표시 영역 자신의 닫는 태그는 빼고 가져옵니다.
    return start, end, inner[:close].strip('\n')


def archive_page(template, block, name, name_ko):
    """아카이브 틀에 기사 본문을 넣어 지난 뮤지션 페이지를 만듭니다."""
    start = template.find('<div class="artist-editorial-grid">')
    back = template.find('archive-back-link')
    stop = template.rfind('<p', 0, back) if back >= 0 else -1
    if start < 0 or stop < start:
        raise PublishError('아카이브 틀(artist-jack-white.html)의 구조를 찾지 못했습니다.', 500)
    line_start = template.rfind('\n', 0, start) + 1
    page = template[:line_start] + block.rstrip() + '\n    ' + template[stop:]
    title = f'{name}' + (f' ({name_ko})' if name_ko else '') + ' — TODAY’S ROCK'
    return re.sub(r'<title>.*?</title>', f'<title>{html.escape(title)}</title>', page, count=1, flags=re.S)


def backup(path, stamp):
    if path.exists():
        folder = ROOT / 'articles' / 'backups'
        folder.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, folder / f'{stamp}-{path.name}')


def publish(artist_id, article, sheet, now):
    photo = article.get('photo')
    if not photo or not (ROOT / photo).is_file():
        raise PublishError('게시하려면 먼저 뮤지션 사진을 등록하세요.', 409)
    artist = article.get('artist') or {}
    entry = {'id': artist_id, 'name': artist.get('name') or artist_id, 'nameKo': artist.get('nameKo') or ''}
    data = load_archive()
    page = HOME.read_text(encoding='utf-8')
    start, end, old_block = home_block(page)
    template = TEMPLATE.read_text(encoding='utf-8')
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    moved = None

    # 1) 홈에서 내려가는 뮤지션은 아카이브 페이지로 옮깁니다. (같은 뮤지션을 다시 게시하면 건너뜀)
    outgoing = data.get('current')
    if outgoing and outgoing.get('id') != artist_id:
        target = ROOT / f"artist-{outgoing['id']}.html"
        backup(target, stamp)
        target.write_text(archive_page(template, old_block, outgoing.get('name', ''), outgoing.get('nameKo', '')), encoding='utf-8')
        data['archive'] = [a for a in data.get('archive', []) if a.get('id') != outgoing['id']]
        data['archive'].insert(0, dict(outgoing, url=target.name))   # 최신 순
        moved = target.name

    # 2) 새 기사로 홈 본문을 바꿉니다.
    backup(HOME, stamp)
    block = render_feature(article, photo, sheet)
    page = page[:start] + START + '\n' + block + '\n    </div>\n    ' + page[end:]
    HOME.write_text(page, encoding='utf-8')

    # 3) 목록 갱신: 게시한 뮤지션은 아카이브 목록에서 빼고 '현재'로 둡니다.
    data['archive'] = [a for a in data.get('archive', []) if a.get('id') != artist_id]
    data['current'] = dict(entry, publishedAt=now)
    ARCHIVE_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'published': artist_id, 'archived': moved, 'backup': stamp}
