import html
import re
import xml.etree.ElementTree as ET

import httpx
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.middleware.trustedhost import TrustedHostMiddleware

load_dotenv(Path(__file__).parent / ".env")

app = FastAPI(title="TODAY'S ROCK API")
from account_system.routes import router as account_router
from account_system.security import allowed_hosts, current_user
from account_system.database import DatabaseError, connect as connect_db
from editor_python import storage as editor_storage
app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts())
app.include_router(account_router)
from editor_bridge import router as editor_router
app.include_router(editor_router)

@app.get("/api/songs")
def get_songs():
    # 접속 정보(.env의 DATABASE_URL 또는 DB_*)는 회원 기능과 같은 설정을 씁니다.
    connection = None

    try:
        connection = connect_db()

        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM v_songs ORDER BY id")
            songs = cursor.fetchall()

        for song in songs:
            song["moods"] = (
                song["moods"].split(",") if song["moods"] else []
            )
            song["weathers"] = (
                song["weathers"].split(",") if song["weathers"] else []
            )
            song["lyricsUrl"] = song.pop("lyrics_url")

        return JSONResponse(songs, headers={"Cache-Control": SONGS_CACHE})

    except DatabaseError:
        logging.exception("PostgreSQL 곡 조회 실패")
        raise HTTPException(
            status_code=500,
            detail="DB에서 곡을 가져오지 못했습니다.",
        ) from None

    finally:
        if connection is not None:
            connection.close()


def clean_news_text(text):
    text = re.sub(r"<[^>]*>", " ", text or "")
    return " ".join(html.unescape(text).split())


@app.get("/api/news")
async def get_news():
    async with httpx.AsyncClient(
        timeout=20,
        follow_redirects=True,
    ) as client:
        # NME RSS에서 최신 뉴스 3개 수집
        try:
            response = await client.get(
                "https://www.nme.com/news/music/feed"
            )
            response.raise_for_status()
            root = ET.fromstring(response.content)

            articles = [
                {
                    "title": clean_news_text(item.findtext("title")),
                    "description": clean_news_text(
                        item.findtext("description")
                    )[:160],
                    "link": html.unescape(item.findtext("link") or ""),
                    "pubDate": item.findtext("pubDate") or "",
                }
                for item in root.findall("./channel/item")[:3]
            ]

            if not articles:
                raise ValueError("RSS 기사 목록이 없습니다.")

        except (httpx.HTTPError, ET.ParseError, ValueError):
            logging.warning("뉴스 RSS 수집 실패")
            raise HTTPException(
                status_code=502,
                detail="뉴스를 가져오지 못했습니다.",
            ) from None

        # 제목과 설명을 한 번에 한국어로 번역
        api_key = os.getenv("GOOGLE_TRANSLATE_API_KEY")
        translated_ok = False

        if api_key:
            texts = [
                text
                for article in articles
                for text in (article["title"], article["description"])
            ]

            try:
                response = await client.post(
                    "https://translation.googleapis.com/language/translate/v2",
                    headers={"X-Goog-Api-Key": api_key},
                    json={
                        "q": texts,
                        "source": "en",
                        "target": "ko",
                        "format": "text",
                    },
                )
                response.raise_for_status()

                translations = response.json()["data"]["translations"]
                translated = [
                    html.unescape(item["translatedText"])
                    for item in translations
                ]

                if len(translated) != len(texts):
                    raise ValueError("번역 결과 개수가 다릅니다.")

                for index, article in enumerate(articles):
                    article["title"] = translated[index * 2]
                    article["description"] = translated[index * 2 + 1]

                translated_ok = True

            except (
                httpx.HTTPError,
                KeyError,
                ValueError,
                TypeError,
            ):
                logging.warning("뉴스 번역 실패: 영문 원문 유지")
        else:
            logging.warning("Google 번역 API 키가 없습니다.")

        # 번역된 뉴스는 CDN에 15분 저장해, 그 사이 방문자는 NME·번역을 기다리지 않습니다.
        return JSONResponse(articles, headers={"Cache-Control": NEWS_CACHE if translated_ok else NEWS_FALLBACK_CACHE})


# 홈페이지·공개 자산만 제공한다. 프로젝트 전체를 정적 폴더로 노출하지 않는다.
ROOT = Path(__file__).resolve().parent


# ── 30초 미리듣기 (iTunes Search API) ─────────────────────────
# 브라우저가 iTunes에 직접 요청하면 아이폰 등에서 실패하는 경우가 있어 서버가 대신 찾습니다.
# 결과는 CDN에 하루 저장되므로 같은 곡은 iTunes에 다시 묻지 않습니다.
PREVIEW_UNWANTED = re.compile(r"live|remaster|demo|karaoke|instrumental|inst\.|\bmr\b|acoustic|remix|version|ver\.", re.I)


def preview_normalize(text):
    return re.sub(r"[^0-9a-z가-힣]", "", str(text or "").lower())


def preview_is_ascii(text):
    """영문·숫자·기호로만 된 이름/제목인지. 한글 등이 섞여 있으면 스토어에 다른 표기로 등록됐을 수 있습니다."""
    return str(text or "").isascii()


def preview_best_match(results, artist, title):
    """검색 결과 중 아티스트·제목이 맞는 곡을 고르고, 라이브·리마스터가 아닌 원곡을 우선합니다."""
    # preview-player.js의 pickBestMatch와 같은 규칙입니다. 한쪽을 고치면 다른 쪽도 같이 고칩니다.
    a, t = preview_normalize(artist), preview_normalize(title)

    def artist_matches(name):
        # 한글·영문·숫자가 없는 이름(예: 일본어)은 빈 값이 되어 아무 가수와나 일치하므로 제외합니다.
        return bool(a and name and (a in name or name in a))

    matches = [
        r for r in results
        if r.get("previewUrl")
        and artist_matches(preview_normalize(r.get("artistName")))
        and preview_normalize(r.get("trackName")).startswith(t)
    ]
    if not matches and not preview_is_ascii(artist):
        # 가수 이름이 다른 언어로 등록된 경우(예: 한국 스토어의 '자우림'이 'Jaurim'): 검색어에 가수 이름이
        # 이미 들어가 있으므로 제목으로 고릅니다. 정확히 같은 제목 → '샤이닝 (Shining)'처럼 제목이 포함된 곡 순서.
        # 영문 가수 이름(예: The Voidz)은 표기가 바뀔 일이 없으므로, 제목만 같은 다른 가수의 곡을 고르지 않습니다.
        with_preview = [r for r in results if r.get("previewUrl")]
        matches = [r for r in with_preview if preview_normalize(r.get("trackName")) == t]
        if not matches and t:
            matches = [r for r in with_preview if t in preview_normalize(r.get("trackName"))]
    for r in matches:
        if not PREVIEW_UNWANTED.search(str(r.get("trackName", "")).replace(title, "")):
            return r
    return matches[0] if matches else None


def preview_pick_by_artist(results, artist_ids):
    """가수 번호가 같은 곡 중 검색 순위가 가장 높은 곡. 라이브·리마스터 등은 뒤로 미룹니다."""
    candidates = [r for r in results if r.get("previewUrl") and r.get("artistId") in artist_ids]
    for r in candidates:
        if not PREVIEW_UNWANTED.search(str(r.get("trackName", ""))):
            return r
    return candidates[0] if candidates else None


@app.get("/api/preview")
async def get_preview(artist: str, title: str, track_id: str = ""):
    artist, title, track_id = artist.strip()[:200], title.strip()[:200], track_id.strip()[:20]
    if not artist or not title or (track_id and not track_id.isdigit()):
        raise HTTPException(status_code=400, detail="곡 정보가 올바르지 않습니다.")

    found, failed = None, False
    guesses = []  # 제목이 맞는 곡이 없었던 나라의 검색 결과 (2단계에서 사용)
    async with httpx.AsyncClient(timeout=6, follow_redirects=True) as client:
        # 1단계: 모든 나라(KR → US)에서 제목이 맞는 곡을 먼저 찾습니다.
        # 예전에는 한국 스토어에 그 곡이 없으면 같은 가수의 다른 곡을 바로 골라, 미국 스토어에 있는
        # 진짜 곡을 찾기 전에 엉뚱한 곡이 재생됐습니다. (예: The Voidz 'Human Sadness')
        for country in ("KR", "US"):
            try:
                if track_id:
                    response = await client.get("https://itunes.apple.com/lookup", params={"id": track_id, "country": country})
                    response.raise_for_status()
                    found = next((r for r in response.json().get("results", []) if r.get("previewUrl")), None)
                if not found:
                    response = await client.get("https://itunes.apple.com/search", params={
                        "term": f"{artist} {title}", "country": country,
                        "media": "music", "entity": "song", "limit": 15,
                    })
                    response.raise_for_status()
                    results = response.json().get("results", [])
                    found = preview_best_match(results, artist, title)
                    if not found and results and not preview_is_ascii(title):
                        # 4단계 후보: 제목이 한글 등이라 스토어에 영문 제목으로 등록됐을 수 있는 곡만.
                        # 영문 제목(예: 'Human Sadness')을 못 찾았으면 같은 가수의 다른 곡을 대신 틀지 않습니다.
                        guesses.append((country, results))
            except (httpx.HTTPError, ValueError):
                failed = True
                logging.warning("iTunes 미리듣기 조회 실패: %s - %s (%s)", artist, title, country)
            if found:
                break
        # 2단계: 어느 나라에서도 제목이 맞는 곡이 없을 때만, 제목이 영문 등으로 달리 등록된 경우
        # (예: '샤이닝'이 'Shining')로 보고 가수의 iTunes 번호로 그 가수의 곡 중 검색 결과 맨 위의 곡을 고릅니다.
        for country, results in guesses if not found else ():
            try:
                response = await client.get("https://itunes.apple.com/search", params={
                    "term": artist, "country": country,
                    "media": "music", "entity": "musicArtist", "limit": 3,
                })
                response.raise_for_status()
                artist_ids = {a.get("artistId") for a in response.json().get("results", []) if a.get("artistId")}
                found = preview_pick_by_artist(results, artist_ids)
            except (httpx.HTTPError, ValueError):
                failed = True
                logging.warning("iTunes 가수 번호 조회 실패: %s (%s)", artist, country)
            if found:
                break

    if not found:
        # 조회 자체가 실패했으면 브라우저가 직접 다시 시도하도록 502, 정말 없는 곡이면 null을 하루 저장
        if failed:
            raise HTTPException(status_code=502, detail="미리듣기를 조회하지 못했습니다.")
        return JSONResponse({"previewUrl": None}, headers={"Cache-Control": PREVIEW_MISS_CACHE})

    return JSONResponse({
        "previewUrl": found["previewUrl"],
        "trackId": found.get("trackId"),
        "trackName": found.get("trackName"),
        "collectionName": found.get("collectionName"),
    }, headers={"Cache-Control": PREVIEW_CACHE})


# ── 캐시 규칙 ────────────────────────────────────────────────
# s-maxage: Vercel CDN(한국 근처 서버)이 이 시간 동안 저장해 두고 Python 서버를 거치지 않고 바로 보냅니다.
#           새로 배포하면 Vercel이 CDN 저장분을 모두 비우므로 디자인 수정은 배포 즉시 반영됩니다.
# max-age:  방문자 브라우저가 저장해 두는 시간. 디자인 수정이 늦게 보이지 않도록 짧게 둡니다.
# stale-while-revalidate: 기한이 지나도 일단 저장분을 보내고 뒤에서 새로 받아 둡니다.
STATIC_CACHE = "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800"   # CSS·JS·폰트·영상·기본 이미지
PHOTO_CACHE = "public, max-age=60, s-maxage=60, stale-while-revalidate=600"            # 편집실에서 올린 뮤지션 사진
SONGS_CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"       # 곡 500개 (SQL로만 바뀜)
NEWS_CACHE = "public, max-age=300, s-maxage=900, stale-while-revalidate=3600"          # 번역된 뉴스 15분
NEWS_FALLBACK_CACHE = "public, max-age=60, s-maxage=60"                                # 번역 실패 시 짧게
PREVIEW_CACHE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800"  # 곡별 미리듣기 주소 (하루)
PREVIEW_MISS_CACHE = "public, max-age=300, s-maxage=3600"                               # 못 찾은 곡은 짧게 (1시간)


def public_file(asset: str, cache: str = "no-store"):
    path = (ROOT / asset).resolve()
    if not path.is_relative_to(ROOT) or not path.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")
    return FileResponse(path, headers={"Cache-Control": cache, "X-Content-Type-Options": "nosniff"})


NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}


def from_db(load, fallback):
    """편집실에서 게시한 내용(DB)을 먼저 보여 주고, DB에 연결하지 못하면 저장소 파일을 그대로 보여 줍니다."""
    try:
        return load()
    except DatabaseError:
        logging.exception("게시 내용 조회 실패 — 저장소 파일로 대신 표시")
        return fallback()


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def homepage():
    # index.html 디자인은 저장소 파일, '오늘의 뮤지션' 기사는 DB의 최근 게시본
    try:
        return HTMLResponse(editor_storage.home_page(), headers=NO_STORE)
    except DatabaseError:
        logging.exception('현재 뮤지션 공개 상태 조회 실패')
        raise HTTPException(status_code=503, detail='홈 게시 상태를 확인할 수 없습니다.')


@app.get("/style.css", include_in_schema=False)
def homepage_css():
    return public_file("style.css", STATIC_CACHE)


@app.get("/script.js", include_in_schema=False)
def homepage_js():
    return public_file("script.js", STATIC_CACHE)


@app.get("/preview-player.js", include_in_schema=False)
def preview_player_js():
    return public_file("preview-player.js", STATIC_CACHE)


# 지난 뮤지션 아카이브 페이지(artist-<뮤지션ID>.html)와 아카이브 목록
@app.get("/artist-{slug}.html", include_in_schema=False)
def musician_article(slug: str):
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
        raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")

    def load():
        page = editor_storage.archive_page(slug)
        if page is None:
            raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")
        return HTMLResponse(page, headers=NO_STORE)

    # DB 장애 시 정적 파일로 우회하면 비공개 기사가 노출될 수 있어 차단합니다.
    try:
        return load()
    except DatabaseError:
        logging.exception('기사 공개 상태 조회 실패')
        raise HTTPException(status_code=503, detail='기사 공개 상태를 확인할 수 없습니다.')


@app.get("/artist-archive.json", include_in_schema=False)
def musician_archive():
    try:
        return JSONResponse(editor_storage.public_archive(), headers=NO_STORE)
    except DatabaseError:
        raise HTTPException(status_code=503, detail='아카이브 공개 상태를 확인할 수 없습니다.')


@app.get("/images/{asset:path}", include_in_schema=False)
def image_asset(asset: str):
    if any(part.startswith(".") for part in Path(asset).parts) or Path(asset).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".mp4", ".webm"}:
        raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")
    path = (ROOT / "images" / asset).resolve()
    if not path.is_relative_to(ROOT / "images"):
        raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")

    def load():
        # 편집실에서 올린 뮤지션 사진은 DB에, 나머지 이미지·영상은 저장소 파일에 있습니다.
        if not asset.startswith("artist-"):
            return public_file("images/" + asset, STATIC_CACHE)
        found = editor_storage.get_asset("images/" + asset)
        if not found:
            raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")
        return Response(found[0], media_type=found[1], headers={"Cache-Control": PHOTO_CACHE, "X-Content-Type-Options": "nosniff"})

    if not asset.startswith("artist-"):          # 배경 영상·기본 이미지는 DB를 거치지 않습니다.
        return public_file("images/" + asset, STATIC_CACHE)
    return from_db(load, lambda: public_file("images/" + asset, PHOTO_CACHE))


@app.get("/fonts/{asset:path}", include_in_schema=False)
def font_asset(asset: str):
    if any(part.startswith(".") for part in Path(asset).parts) or Path(asset).suffix.lower() not in {".woff", ".woff2", ".otf", ".ttf"}:
        raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")
    path = (ROOT / "fonts" / asset).resolve()
    if not path.is_relative_to(ROOT / "fonts"):
        raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")
    return public_file("fonts/" + asset, STATIC_CACHE)


def account_page(request, filename, role=None):
    user = current_user(request)
    if not user:
        from urllib.parse import quote
        return RedirectResponse("/login?next=" + quote(request.url.path, safe=""), status_code=303)
    if role and user["role"] != role:
        return FileResponse(ROOT / "accounts/forbidden.html", status_code=403,
                            headers={"Cache-Control": "no-store"})
    return FileResponse(ROOT / "accounts" / filename, headers={"Cache-Control": "no-store"})


@app.get("/login", include_in_schema=False)
@app.get("/signup", include_in_schema=False)
def account_login():
    return FileResponse(ROOT / "accounts/auth.html", headers={"Cache-Control": "no-store"})


@app.get("/mypage", include_in_schema=False)
@app.get("/mypage/", include_in_schema=False)
def mypage(request: Request):
    return account_page(request, "mypage.html")


@app.get("/admin", include_in_schema=False)
@app.get("/admin/", include_in_schema=False)
@app.get("/admin/index.html", include_in_schema=False)
def admin_page(request: Request):
    return account_page(request, "manage.html", "admin")


@app.get("/account-assets/{asset}", include_in_schema=False)
def account_asset(asset: str):
    if asset not in {"common.js", "page.js", "style.css"}:
        raise HTTPException(404, "파일을 찾지 못했습니다.")
    return public_file("accounts/" + asset, STATIC_CACHE)

