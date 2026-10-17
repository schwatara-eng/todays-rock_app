"""FastAPI 편집실 연결. 기존 검수·저장 로직은 로컬 Node 작업자가 실행한다."""
import asyncio
import atexit
import os
from contextlib import asynccontextmanager
from pathlib import Path
import shutil
import subprocess

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

ROOT = Path(__file__).resolve().parent
WORKER_PORT = 4178
BASE = f"http://127.0.0.1:{WORKER_PORT}"
_process = None
_lock = asyncio.Lock()


def stop_worker():
    global _process
    if _process is not None and _process.poll() is None:
        _process.terminate()
        try:
            _process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _process.kill()
            _process.wait()
    _process = None


atexit.register(stop_worker)


@asynccontextmanager
async def editor_lifespan(app):
    try:
        yield
    finally:
        stop_worker()


router = APIRouter(lifespan=editor_lifespan)


async def ensure_worker():
    global _process
    async with _lock:
        if _process is not None and _process.poll() is None:
            return
        if not os.getenv("ADMIN_SECRET"):
            raise RuntimeError(".env에 ADMIN_SECRET을 설정한 뒤 FastAPI를 다시 실행하세요.")
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js 실행 파일을 찾을 수 없습니다.")
        env = os.environ.copy()
        env["ADMIN_PORT"] = str(WORKER_PORT)
        # 이미 다른 서버가 포트를 사용하는 경우 연결하지 않는다.
        import socket
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", WORKER_PORT)) == 0:
                raise RuntimeError("4178 포트가 사용 중입니다. 기존 작업자를 종료하세요.")
        _process = subprocess.Popen(
            [node, str(ROOT / "scripts" / "admin-local-fastapi.mjs")],
            cwd=ROOT, env=env,
        )
        async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
            for _ in range(50):
                if _process.poll() is not None:
                    raise RuntimeError("편집실 작업자 실행 실패. 터미널 오류를 확인하세요.")
                try:
                    result = await client.get(BASE + "/local/data")
                    if result.status_code == 200:
                        return
                    raise RuntimeError("편집실 데이터 로드 실패. 기존 JSON 파일을 확인하세요.")
                except httpx.TransportError:
                    await asyncio.sleep(0.1)
        stop_worker()
        raise RuntimeError("편집실 작업자 응답 시간이 초과됐습니다.")


async def forward(request, target):
    # 쓰기 요청은 같은 FastAPI 편집실 화면에서만 허용한다.
    if request.method == "POST":
        origin = request.headers.get("origin")
        allowed = {"http://localhost:8000", "http://127.0.0.1:8000"}
        if origin not in allowed:
            return JSONResponse({"error": "localhost:8000/editor/에서 실행하세요."}, 403)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 50000:
            return JSONResponse({"error": "요청이 너무 큽니다."}, 413)
    try:
        await ensure_worker()
        async with httpx.AsyncClient(timeout=600, trust_env=False) as client:
            upstream = await client.request(
                request.method, BASE + target,
                content=bytes(body),
                headers={"Content-Type": request.headers.get("content-type", "application/json"), "Origin": BASE},
            )
        headers = {
            name: value for name, value in upstream.headers.items()
            if name in {"content-type", "cache-control", "content-security-policy", "x-content-type-options", "allow"}
        }
        return Response(upstream.content, status_code=upstream.status_code, headers=headers)
    except (RuntimeError, httpx.HTTPError) as error:
        # 접속 정보나 키가 포함될 수 있는 내부 예외를 그대로 출력하지 않는다.
        message = str(error) if isinstance(error, RuntimeError) else "편집실 내부 서버 연결 실패"
        return JSONResponse({"error": message}, 503)


@router.get("/editor/")
async def editor_home(request: Request):
    return await forward(request, "/")


@router.get("/editor")
async def editor_redirect():
    from fastapi.responses import RedirectResponse
    return RedirectResponse("/editor/")


@router.get("/editor/{asset:path}")
async def editor_asset(asset: str, request: Request):
    if asset not in {"app.js", "style.css", "fonts/Galmuri9.woff2"}:
        return JSONResponse({"error": "파일 없음"}, 404)
    return await forward(request, "/" + asset)


@router.api_route("/local/{action}", methods=["GET", "POST"])
async def editor_action(action: str, request: Request):
    allowed = {"data", "publication-export", "save", "generate", "research", "research-one", "review", "editorial", "recheck", "approve"}
    if action not in allowed:
        return JSONResponse({"error": "지원하지 않는 기능입니다."}, 404)
    return await forward(request, "/local/" + action)


@router.get("/site/{asset:path}")
async def site_asset(asset: str, request: Request):
    # 작업자에서 허용된 미리보기 파일만 제공한다.
    from urllib.parse import quote
    return await forward(request, "/site/" + quote(asset, safe="/"))


@router.get("/app.js", include_in_schema=False)
async def absolute_app(request: Request):
    return await forward(request, "/app.js")


@router.get("/style.css", include_in_schema=False)
async def absolute_style(request: Request):
    return await forward(request, "/style.css")


@router.get("/fonts/Galmuri9.woff2", include_in_schema=False)
async def editor_font(request: Request):
    return await forward(request, "/fonts/Galmuri9.woff2")
