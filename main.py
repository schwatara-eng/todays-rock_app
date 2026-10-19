import html
import re
import xml.etree.ElementTree as ET

import httpx
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

load_dotenv(Path(__file__).parent / ".env")

app = FastAPI(title="TODAY'S ROCK API")
from account_system.routes import router as account_router
from account_system.security import allowed_hosts, current_user
from account_system.database import DatabaseError, connect as connect_db
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

        return songs

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

            except (
                httpx.HTTPError,
                KeyError,
                ValueError,
                TypeError,
            ):
                logging.warning("뉴스 번역 실패: 영문 원문 유지")
        else:
            logging.warning("Google 번역 API 키가 없습니다.")

        return articles


# 홈페이지·공개 자산만 제공한다. 프로젝트 전체를 정적 폴더로 노출하지 않는다.
ROOT = Path(__file__).resolve().parent


def public_file(asset: str):
    path = (ROOT / asset).resolve()
    if not path.is_relative_to(ROOT) or not path.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")
    return FileResponse(path, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
def homepage():
    return public_file("index.html")


@app.get("/style.css", include_in_schema=False)
def homepage_css():
    return public_file("style.css")


@app.get("/script.js", include_in_schema=False)
def homepage_js():
    return public_file("script.js")


# 지난 뮤지션 아카이브 페이지(artist-<뮤지션ID>.html)와 아카이브 목록
@app.get("/artist-{slug}.html", include_in_schema=False)
def musician_article(slug: str):
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", slug):
        raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")
    return public_file(f"artist-{slug}.html")


@app.get("/artist-archive.json", include_in_schema=False)
def musician_archive():
    return public_file("artist-archive.json")


@app.get("/images/{asset:path}", include_in_schema=False)
def image_asset(asset: str):
    if any(part.startswith(".") for part in Path(asset).parts) or Path(asset).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".mp4", ".webm"}:
        raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")
    path = (ROOT / "images" / asset).resolve()
    if not path.is_relative_to(ROOT / "images"):
        raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")
    return public_file("images/" + asset)


@app.get("/fonts/{asset:path}", include_in_schema=False)
def font_asset(asset: str):
    if any(part.startswith(".") for part in Path(asset).parts) or Path(asset).suffix.lower() not in {".woff", ".woff2", ".otf", ".ttf"}:
        raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")
    path = (ROOT / "fonts" / asset).resolve()
    if not path.is_relative_to(ROOT / "fonts"):
        raise HTTPException(status_code=404, detail="파일을 찾지 못했습니다.")
    return public_file("fonts/" + asset)


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
    return public_file("accounts/" + asset)

