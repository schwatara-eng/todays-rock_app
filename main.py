import html
import re
import xml.etree.ElementTree as ET

import httpx
import logging
import os
from pathlib import Path

import pymysql
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, RedirectResponse

load_dotenv(Path(__file__).parent / ".env")

app = FastAPI(title="TODAY'S ROCK API")
from editor_bridge import router as editor_router
app.include_router(editor_router)

@app.get("/api/songs")
def get_songs():
    connection = None

    try:
        connection = pymysql.connect(
            host=os.getenv("DB_HOST", "127.0.0.1"),
            port=int(os.getenv("DB_PORT", "3306")),
            user=os.getenv("DB_USER", "root"),
            password=os.getenv("DB_PASSWORD", ""),
            database=os.getenv("DB_NAME", "todays_rock"),
            charset="utf8mb4",
            cursorclass=pymysql.cursors.DictCursor,
            connect_timeout=5,
        )

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

    except pymysql.MySQLError:
        logging.exception("MySQL 곡 조회 실패")
        raise HTTPException(
            status_code=500,
            detail="MySQL에서 곡을 가져오지 못했습니다.",
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


@app.get("/artist-jack-white.html", include_in_schema=False)
def musician_article():
    return public_file("artist-jack-white.html")


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


@app.get("/admin/", include_in_schema=False)
@app.get("/admin/index.html", include_in_schema=False)
def legacy_editor():
    return RedirectResponse("/editor/")
