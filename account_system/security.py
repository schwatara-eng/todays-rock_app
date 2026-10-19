"""비밀번호 해시, 서버 세션, 요청 위조 방지 및 공통 권한 검사."""
import hashlib
import hmac
import os
import secrets
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

from .database import database

COOKIE_NAME = "tr_session"
SESSION_SECONDS = 7 * 24 * 60 * 60
ROLES = {"user": "사용자", "reporter": "기자", "admin": "관리자"}


def trusted_origins():
    configured = os.getenv("APP_ORIGIN", "").strip().rstrip("/")
    return {configured} if configured else {"http://localhost:8000", "http://127.0.0.1:8000"}


def secure_cookie():
    return os.getenv("APP_ORIGIN", "").strip().startswith("https://")


def check_origin(request: Request):
    # Host 헤더로 허용 출처를 결정하지 않습니다. 로그인/가입에도 동일하게 적용합니다.
    if request.headers.get("origin", "") not in trusted_origins():
        raise HTTPException(403, "허용되지 않은 요청입니다. 원래 페이지에서 다시 시도해 주세요.")


def hash_password(password: str):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=32768, r=8, p=3,
                            dklen=32, maxmem=64 * 1024 * 1024)
    return f"scrypt$32768$8$3${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str):
    try:
        method, n, r, p, salt, expected = encoded.split("$")
        if method != "scrypt" or (int(n), int(r), int(p)) != (32768, 8, 3):
            return False
        digest = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt),
                                n=int(n), r=int(r), p=int(p), dklen=32, maxmem=64 * 1024 * 1024)
        return hmac.compare_digest(digest.hex(), expected)
    except (ValueError, TypeError):
        return False


def token_hash(token: str):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def public_user(row):
    return {"id": row["id"], "email": row["email"], "displayName": row["display_name"],
            "role": row["role"], "roleLabel": ROLES[row["role"]],
            "canEdit": row["role"] in ("admin", "reporter"), "isAdmin": row["role"] == "admin"}


def current_user(request: Request):
    if hasattr(request.state, "account"):
        return request.state.account
    token = request.cookies.get(COOKIE_NAME, "")
    if len(token) != 43 or not all(c.isascii() and (c.isalnum() or c in "-_") for c in token):
        request.state.account = None
        return None
    with database() as connection, connection.cursor() as cursor:
        # 권한은 쿠키에 저장하지 않습니다. 승격/강등/정지는 다음 요청부터 반영됩니다.
        cursor.execute("""SELECT u.id, u.email, u.display_name, u.role, s.csrf_token
                          FROM account_sessions s JOIN account_users u ON u.id = s.user_id
                          WHERE s.token_hash = %s AND s.expires_at > UTC_TIMESTAMP()
                          AND u.is_active = 1""", (token_hash(token),))
        user = cursor.fetchone()
    request.state.account = user
    return user


def require_user(request: Request):
    user = current_user(request)
    if not user:
        raise HTTPException(401, "로그인이 필요합니다.")
    return user


def require_role(request: Request, *roles):
    user = require_user(request)
    if user["role"] not in roles:
        raise HTTPException(403, "이 기능을 사용할 권한이 없습니다.")
    return user


def check_csrf(request: Request, user=None):
    check_origin(request)
    user = user or require_user(request)
    supplied = request.headers.get("x-csrf-token", "")
    if len(supplied) != 43 or not supplied.isascii() or not hmac.compare_digest(supplied, user["csrf_token"]):
        raise HTTPException(403, "로그인 상태를 확인한 뒤 다시 시도해 주세요.")


def new_session(cursor, user_id):
    token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    cursor.execute("DELETE FROM account_sessions WHERE expires_at <= UTC_TIMESTAMP()")
    cursor.execute("""INSERT INTO account_sessions (token_hash, user_id, csrf_token, expires_at)
                      VALUES (%s, %s, %s, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))""",
                   (token_hash(token), user_id, csrf))
    return token, csrf


def set_session_cookie(response, token):
    response.set_cookie(COOKIE_NAME, token, max_age=SESSION_SECONDS, httponly=True,
                        secure=secure_cookie(), samesite="lax", path="/")


def delete_session_cookie(response):
    response.delete_cookie(COOKIE_NAME, path="/", secure=secure_cookie(), httponly=True, samesite="lax")


def allowed_hosts():
    return list({urlsplit(origin).hostname for origin in trusted_origins()})
