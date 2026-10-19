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
    return from_db(lambda: HTMLResponse(editor_storage.home_page(), headers=NO_STORE),
                   lambda: public_file("index.html"))


@app.get("/style.css", include_in_schema=False)
def homepage_css():
    return public_file("style.css", STATIC_CACHE)


@app.get("/script.js", include_in_schema=False)
def homepage_js():
    return public_file("script.js", STATIC_CACHE)


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

    return from_db(load, lambda: public_file(f"artist-{slug}.html"))


@app.get("/artist-archive.json", include_in_schema=False)
def musician_archive():
    return from_db(lambda: JSONResponse(editor_storage.get_archive(), headers=NO_STORE),
                   lambda: public_file("artist-archive.json"))


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

