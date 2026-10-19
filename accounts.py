# 「오늘의 록」 회원가입 · 로그인 · 권한(관리자/기자/사용자) · 좋아요
#
# 권한
#   admin    : 모든 권한. 회원 목록 열람, 사용자 ↔ 기자 전환, 편집실 접근
#   reporter : 편집실 접근 + 사용자 권한
#   user     : 곡 좋아요, 마이페이지에서 좋아요 기록 열람
#
# 맨 처음 가입한 계정은 자동으로 관리자가 됩니다.
# 필요한 테이블(users, sessions, song_likes)은 서버가 처음 요청을 받을 때 자동으로 만듭니다.

import hashlib
import hmac
import logging
import os
import re
import secrets
from datetime import datetime, timedelta

import pymysql
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

router = APIRouter()

COOKIE = "tr_session"
SESSION_DAYS = 14
ROLES = ("admin", "reporter", "user")
ROLE_NAMES = {"admin": "관리자", "reporter": "기자", "user": "사용자"}
EDITOR_ROLES = ("admin", "reporter")
ALLOWED_ORIGINS = ("http://localhost:8000", "http://127.0.0.1:8000")
EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")

_tables_ready = False


# ── DB ────────────────────────────────────────────────
def db():
    return pymysql.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "todays_rock"),
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=5,
        autocommit=True,
    )


def ensure_tables(conn):
    """계정 테이블이 없으면 만든다. song_likes는 songs 테이블에 외래키를 걸지 않는다.
    (db/todays_rock.sql을 다시 실행할 때 songs를 지웠다 만들 수 있게 하기 위해서)"""
    global _tables_ready
    if _tables_ready:
        return
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS users (
              id            INT AUTO_INCREMENT PRIMARY KEY,
              email         VARCHAR(190) NOT NULL UNIQUE,
              nickname      VARCHAR(40)  NOT NULL,
              password_hash VARCHAR(255) NOT NULL,
              role          ENUM('admin','reporter','user') NOT NULL DEFAULT 'user',
              created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
              token_hash CHAR(64) PRIMARY KEY,
              user_id    INT NOT NULL,
              expires_at DATETIME NOT NULL,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) DEFAULT CHARSET=utf8mb4
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS song_likes (
              user_id    INT NOT NULL,
              song_id    INT NOT NULL,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (user_id, song_id),
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            ) DEFAULT CHARSET=utf8mb4
        """)
    _tables_ready = True


def connect():
    conn = db()
    ensure_tables(conn)
    return conn


# ── 비밀번호 · 세션 ─────────────────────────────────────
def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def check_password(password, stored):
    try:
        _, salt, digest = stored.split("$")
        test = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1)
        return hmac.compare_digest(test.hex(), digest)
    except (ValueError, AttributeError):
        return False


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def public_user(row):
    return {
        "id": row["id"],
        "email": row["email"],
        "nickname": row["nickname"],
        "role": row["role"],
        "roleName": ROLE_NAMES[row["role"]],
        "canEdit": row["role"] in EDITOR_ROLES,
    }


def current_user(request: Request):
    """쿠키의 세션으로 로그인한 회원을 찾는다. 없으면 None."""
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                   WHERE s.token_hash = %s AND s.expires_at > NOW()""",
                (token_hash(token),),
            )
            return cur.fetchone()
    finally:
        conn.close()


def require(request: Request, roles=ROLES):
    user = current_user(request)
    if user is None:
        raise HTTPException(401, "로그인이 필요합니다.")
    if user["role"] not in roles:
        raise HTTPException(403, "권한이 없습니다.")
    return user


def check_origin(request: Request):
    # 다른 사이트가 로그인 쿠키를 이용해 요청을 보내는 것을 막는다.
    if request.headers.get("origin") not in ALLOWED_ORIGINS:
        raise HTTPException(403, "허용되지 않은 요청 출처입니다.")


def start_session(user_id):
    token = secrets.token_urlsafe(32)
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM sessions WHERE expires_at < NOW()")
            cur.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (%s, %s, %s)",
                (token_hash(token), user_id, datetime.now() + timedelta(days=SESSION_DAYS)),
            )
    finally:
        conn.close()
    return token


def with_cookie(data, token):
    response = JSONResponse(data)
    response.set_cookie(
        COOKIE, token, max_age=SESSION_DAYS * 86400,
        httponly=True, samesite="lax", path="/",
    )
    return response


async def read_json(request: Request):
    try:
        data = await request.json()
    except ValueError:
        raise HTTPException(400, "올바른 요청이 아닙니다.") from None
    if not isinstance(data, dict):
        raise HTTPException(400, "올바른 요청이 아닙니다.")
    return data


# ── 회원가입 · 로그인 · 로그아웃 ─────────────────────────
@router.post("/api/auth/signup")
async def signup(request: Request):
    check_origin(request)
    data = await read_json(request)
    email = str(data.get("email", "")).strip().lower()
    nickname = str(data.get("nickname", "")).strip()
    password = str(data.get("password", ""))

    if not EMAIL.fullmatch(email) or len(email) > 190:
        raise HTTPException(400, "이메일 형식을 확인해주세요.")
    if not 1 <= len(nickname) <= 20:
        raise HTTPException(400, "닉네임은 1~20자로 입력해주세요.")
    if len(password) < 8:
        raise HTTPException(400, "비밀번호는 8자 이상이어야 해요.")

    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) AS n FROM users")
            role = "admin" if cur.fetchone()["n"] == 0 else "user"  # 첫 가입자는 관리자
            try:
                cur.execute(
                    "INSERT INTO users (email, nickname, password_hash, role) VALUES (%s, %s, %s, %s)",
                    (email, nickname, hash_password(password), role),
                )
            except pymysql.err.IntegrityError:
                raise HTTPException(409, "이미 가입된 이메일이에요.") from None
            user_id = cur.lastrowid
            cur.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            user = cur.fetchone()
    finally:
        conn.close()
    return with_cookie({"user": public_user(user)}, start_session(user_id))


@router.post("/api/auth/login")
async def login(request: Request):
    check_origin(request)
    data = await read_json(request)
    email = str(data.get("email", "")).strip().lower()
    password = str(data.get("password", ""))

    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE email = %s", (email,))
            user = cur.fetchone()
    finally:
        conn.close()
    if user is None or not check_password(password, user["password_hash"]):
        raise HTTPException(401, "이메일 또는 비밀번호가 맞지 않아요.")
    return with_cookie({"user": public_user(user)}, start_session(user["id"]))


@router.post("/api/auth/logout")
async def logout(request: Request):
    check_origin(request)
    token = request.cookies.get(COOKIE)
    if token:
        conn = connect()
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM sessions WHERE token_hash = %s", (token_hash(token),))
        finally:
            conn.close()
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE, path="/")
    return response


@router.get("/api/auth/me")
def me(request: Request):
    user = current_user(request)
    return {"user": public_user(user) if user else None}


# ── 좋아요 ─────────────────────────────────────────────
@router.get("/api/likes/ids")
def liked_ids(request: Request):
    user = current_user(request)
    if user is None:
        return {"ids": []}
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT song_id FROM song_likes WHERE user_id = %s", (user["id"],))
            return {"ids": [row["song_id"] for row in cur.fetchall()]}
    finally:
        conn.close()


@router.post("/api/likes/{song_id}")
def toggle_like(song_id: int, request: Request):
    """누를 때마다 좋아요 ↔ 취소가 바뀐다."""
    check_origin(request)
    user = require(request)
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM songs WHERE id = %s", (song_id,))
            if cur.fetchone() is None:
                raise HTTPException(404, "곡을 찾지 못했어요.")
            removed = cur.execute(
                "DELETE FROM song_likes WHERE user_id = %s AND song_id = %s", (user["id"], song_id)
            )
            if not removed:
                cur.execute(
                    "INSERT INTO song_likes (user_id, song_id) VALUES (%s, %s)", (user["id"], song_id)
                )
    finally:
        conn.close()
    return {"songId": song_id, "liked": not removed}


@router.get("/api/me/likes")
def my_likes(request: Request):
    user = require(request)
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT s.id, s.title, s.artist, s.year, s.genre, s.lyrics_url AS lyricsUrl,
                          l.created_at AS likedAt
                   FROM song_likes l JOIN songs s ON s.id = l.song_id
                   WHERE l.user_id = %s ORDER BY l.created_at DESC""",
                (user["id"],),
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    for row in rows:
        row["likedAt"] = row["likedAt"].isoformat()
    return {"likes": rows}


# ── 관리자: 회원 목록 · 권한 변경 ──────────────────────────
@router.get("/api/admin/users")
def list_users(request: Request):
    require(request, ("admin",))
    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT u.id, u.email, u.nickname, u.role, u.created_at,
                          (SELECT COUNT(*) FROM song_likes l WHERE l.user_id = u.id) AS likes
                   FROM users u ORDER BY FIELD(u.role, 'admin', 'reporter', 'user'), u.created_at"""
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    for row in rows:
        row["roleName"] = ROLE_NAMES[row["role"]]
        row["createdAt"] = row.pop("created_at").isoformat()
    return {"users": rows}


@router.post("/api/admin/users/{user_id}/role")
async def change_role(user_id: int, request: Request):
    """관리자는 사용자를 기자로 승격하거나, 기자를 사용자로 되돌릴 수 있다.
    관리자 권한 자체는 화면에서 주거나 뺏을 수 없다(실수로 관리자가 사라지는 것을 막기 위해)."""
    check_origin(request)
    admin = require(request, ("admin",))
    role = (await read_json(request)).get("role")
    if role not in ("reporter", "user"):
        raise HTTPException(400, "기자 또는 사용자로만 바꿀 수 있어요.")
    if user_id == admin["id"]:
        raise HTTPException(400, "내 권한은 바꿀 수 없어요.")

    conn = connect()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT role FROM users WHERE id = %s", (user_id,))
            target = cur.fetchone()
            if target is None:
                raise HTTPException(404, "회원을 찾지 못했어요.")
            if target["role"] == "admin":
                raise HTTPException(400, "관리자 권한은 여기서 바꿀 수 없어요.")
            cur.execute("UPDATE users SET role = %s WHERE id = %s", (role, user_id))
    finally:
        conn.close()
    return {"id": user_id, "role": role, "roleName": ROLE_NAMES[role]}


# ── 편집실 보호 ─────────────────────────────────────────
EDITOR_PREFIXES = ("/editor", "/local/", "/site/", "/admin/")


def is_editor_path(path):
    return path.startswith(EDITOR_PREFIXES)


def editor_gate(request: Request):
    """편집실 경로에 기자·관리자만 들어오게 한다.
    통과면 None, 막아야 하면 (상태코드, 메시지)를 돌려준다."""
    try:
        user = current_user(request)
    except pymysql.MySQLError:
        logging.exception("편집실 권한 확인 실패")
        return 503, "회원 DB에 연결하지 못했어요."
    if user is None:
        return 401, "로그인이 필요합니다."
    if user["role"] not in EDITOR_ROLES:
        return 403, "편집실은 기자와 관리자만 들어갈 수 있어요."
    return None
