"""가입/로그인, 본인 프로필/좋아요, 관리자 회원 운영 API."""
from datetime import datetime, timezone
import hashlib
import re
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
import pymysql

from .database import database
from .security import (COOKIE_NAME, ROLES, check_csrf, check_origin, current_user,
                       delete_session_cookie, hash_password, new_session, public_user,
                       require_role, require_user, set_session_cookie, token_hash, verify_password)

router = APIRouter(prefix="/api", tags=["accounts"])
# 존재하지 않는 이메일도 같은 비용으로 비밀번호를 검사합니다.
DUMMY_HASH = hash_password("dummy-password-not-used-by-any-account")


def iso_date(value):
    return value.replace(tzinfo=timezone.utc).isoformat() if isinstance(value, datetime) else value


def reply(data, status=200):
    return JSONResponse(data, status_code=status, headers={"Cache-Control": "no-store"})


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


def clean_email(value):
    value = value.strip().lower()
    if not value.isascii() or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}", value):
        raise ValueError("올바른 이메일 주소를 입력하세요.")
    return value


def clean_name(value):
    value = value.strip()
    if len(value) < 2 or any(ord(c) < 32 for c in value):
        raise ValueError("닉네임은 2~40자로 입력하세요.")
    return value


class LoginData(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)
    _email = field_validator("email")(clean_email)


class SignupData(LoginData):
    display_name: str = Field(min_length=2, max_length=40)
    password: str = Field(min_length=10, max_length=128)
    _name = field_validator("display_name")(clean_name)

    @field_validator("password")
    @classmethod
    def password_not_blank(cls, value):
        if not value.strip():
            raise ValueError("공백만으로 비밀번호를 만들 수 없습니다.")
        return value


class ProfileData(StrictModel):
    display_name: str = Field(min_length=2, max_length=40)
    _name = field_validator("display_name")(clean_name)


class PasswordData(StrictModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=10, max_length=128)

    @field_validator("new_password")
    @classmethod
    def not_blank(cls, value):
        if not value.strip():
            raise ValueError("공백만으로 비밀번호를 만들 수 없습니다.")
        return value


class MemberUpdate(StrictModel):
    role: Literal["user", "reporter", "admin"]
    is_active: bool


def rate_limit(request, action, email=""):
    """DB에 횟수를 저장해 서버 재시작/여러 작업자에서도 로그인 제한을 유지합니다."""
    client = request.client.host if request.client else "unknown"
    buckets = [(f"{action}:ip:{client}", 10 if action == "signup" else 40)]
    if email:
        buckets.append((f"{action}:email:{email}", 15))
    blocked = False
    with database() as connection, connection.cursor() as cursor:
        cursor.execute("DELETE FROM account_auth_limits WHERE window_start < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)")
        for key, limit in buckets:
            digest = hashlib.sha256(key.encode()).hexdigest()
            cursor.execute("""INSERT INTO account_auth_limits (bucket_hash, attempts, window_start)
                              VALUES (%s, 1, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE
                              attempts = IF(window_start < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE), 1, attempts + 1),
                              window_start = IF(window_start < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE), UTC_TIMESTAMP(), window_start)""", (digest,))
            cursor.execute("SELECT attempts FROM account_auth_limits WHERE bucket_hash = %s", (digest,))
            blocked = blocked or cursor.fetchone()["attempts"] > limit
    if blocked:
        raise HTTPException(429, "시도 횟수가 많습니다. 15분 뒤 다시 시도해 주세요.")


def forget_old_session(cursor, request):
    token = request.cookies.get(COOKIE_NAME, "")
    if len(token) == 43 and token.isascii():
        cursor.execute("DELETE FROM account_sessions WHERE token_hash = %s", (token_hash(token),))


def login_response(user, token, csrf, status=200):
    response = reply({"user": public_user(user), "csrfToken": csrf}, status)
    set_session_cookie(response, token)
    return response


@router.get("/auth/me")
def me(request: Request):
    user = current_user(request)
    return reply({"user": public_user(user) if user else None,
                  "csrfToken": user["csrf_token"] if user else None})


@router.post("/auth/signup")
def signup(data: SignupData, request: Request):
    check_origin(request)
    rate_limit(request, "signup")
    password = hash_password(data.password)
    with database() as connection, connection.cursor() as cursor:
        try:
            cursor.execute("""INSERT INTO account_users (email, display_name, password_hash, role, created_at, updated_at)
                              VALUES (%s, %s, %s, 'user', UTC_TIMESTAMP(), UTC_TIMESTAMP())""",
                           (data.email, data.display_name, password))
        except pymysql.IntegrityError as error:
            if error.args[0] == 1062:
                raise HTTPException(409, "이미 사용 중인 이메일입니다.") from None
            raise
        user = {"id": cursor.lastrowid, "email": data.email, "display_name": data.display_name, "role": "user"}
        forget_old_session(cursor, request)
        token, csrf = new_session(cursor, user["id"])
    return login_response(user, token, csrf, 201)


@router.post("/auth/login")
def login(data: LoginData, request: Request):
    check_origin(request)
    rate_limit(request, "login", data.email)
    with database() as connection, connection.cursor() as cursor:
        cursor.execute("SELECT * FROM account_users WHERE email = %s", (data.email,))
        user = cursor.fetchone()
        valid = verify_password(data.password, user["password_hash"] if user else DUMMY_HASH)
        if not user or not valid or not user["is_active"]:
            raise HTTPException(401, "이메일 또는 비밀번호를 확인하세요. 정지된 계정은 로그인할 수 없습니다.")
        # 비밀번호/상태가 검사 중 변경되었으면 이전 비밀번호로 새 세션을 만들지 않습니다.
        cursor.execute("SELECT * FROM account_users WHERE id = %s FOR UPDATE", (user["id"],))
        locked = cursor.fetchone()
        if not locked or not locked["is_active"] or locked["password_hash"] != user["password_hash"]:
            raise HTTPException(401, "계정 정보가 변경되었습니다. 다시 로그인하세요.")
        user = locked
        forget_old_session(cursor, request)
        token, csrf = new_session(cursor, user["id"])
        cursor.execute("UPDATE account_users SET last_login_at = UTC_TIMESTAMP() WHERE id = %s", (user["id"],))
    return login_response(user, token, csrf)


@router.post("/auth/logout")
def logout(request: Request):
    user = require_user(request)
    check_csrf(request, user)
    with database() as connection, connection.cursor() as cursor:
        forget_old_session(cursor, request)
    response = reply({"ok": True})
    delete_session_cookie(response)
    return response


@router.patch("/me/profile")
def update_profile(data: ProfileData, request: Request):
    user = require_user(request)
    check_csrf(request, user)
    with database() as connection, connection.cursor() as cursor:
        cursor.execute("UPDATE account_users SET display_name = %s, updated_at = UTC_TIMESTAMP() WHERE id = %s",
                       (data.display_name, user["id"]))
    return reply({"user": public_user(dict(user, display_name=data.display_name))})


@router.put("/me/password")
def change_password(data: PasswordData, request: Request):
    user = require_user(request)
    check_csrf(request, user)
    rate_limit(request, "password", user["email"])
    encoded = hash_password(data.new_password)
    with database() as connection, connection.cursor() as cursor:
        cursor.execute("SELECT password_hash, is_active FROM account_users WHERE id = %s FOR UPDATE", (user["id"],))
        stored = cursor.fetchone()
        if not stored or not stored["is_active"]:
            raise HTTPException(401, "계정 상태가 변경되었습니다. 다시 로그인하세요.")
        if not verify_password(data.current_password, stored["password_hash"]):
            raise HTTPException(400, "현재 비밀번호가 맞지 않습니다.")
        cursor.execute("UPDATE account_users SET password_hash = %s, updated_at = UTC_TIMESTAMP() WHERE id = %s", (encoded, user["id"]))
        cursor.execute("DELETE FROM account_sessions WHERE user_id = %s", (user["id"],))
        token, csrf = new_session(cursor, user["id"])
    return login_response(user, token, csrf)


@router.get("/me/like-ids")
def like_ids(request: Request):
    user = require_user(request)
    with database() as connection, connection.cursor() as cursor:
        cursor.execute("SELECT l.song_id FROM account_likes l JOIN songs s ON s.id = l.song_id WHERE l.user_id = %s", (user["id"],))
        ids = [row["song_id"] for row in cursor.fetchall()]
    return reply({"songIds": ids})


@router.get("/me/likes")
def likes(request: Request, page: int = Query(1, ge=1, le=10000)):
    user = require_user(request)
    page_size = 15
    with database() as connection, connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) AS total FROM account_likes l JOIN songs s ON s.id = l.song_id WHERE l.user_id = %s", (user["id"],))
        total = cursor.fetchone()["total"]
        cursor.execute("""SELECT s.id, s.title, s.artist, s.year, s.genre, s.lyrics_url, l.created_at AS liked_at
                          FROM account_likes l JOIN songs s ON s.id = l.song_id WHERE l.user_id = %s
                          ORDER BY l.created_at DESC, l.song_id DESC LIMIT %s OFFSET %s""", (user["id"], page_size, (page - 1) * page_size))
        items = cursor.fetchall()
    for item in items:
        item["liked_at"] = iso_date(item["liked_at"])
    return reply({"items": items, "total": total, "page": page, "pageSize": page_size})


@router.put("/me/likes/{song_id}")
def like_song(song_id: int, request: Request):
    user = require_user(request)
    check_csrf(request, user)
    with database() as connection, connection.cursor() as cursor:
        cursor.execute("SELECT id FROM songs WHERE id = %s", (song_id,))
        if not cursor.fetchone():
            raise HTTPException(404, "곡을 찾지 못했습니다.")
        cursor.execute("INSERT IGNORE INTO account_likes (user_id, song_id, created_at) VALUES (%s, %s, UTC_TIMESTAMP())", (user["id"], song_id))
    return reply({"songId": song_id, "liked": True})


@router.delete("/me/likes/{song_id}")
def unlike_song(song_id: int, request: Request):
    user = require_user(request)
    check_csrf(request, user)
    with database() as connection, connection.cursor() as cursor:
        cursor.execute("DELETE FROM account_likes WHERE user_id = %s AND song_id = %s", (user["id"], song_id))
    return reply({"songId": song_id, "liked": False})


def member_json(row):
    return dict(public_user(row), isActive=bool(row["is_active"]), createdAt=iso_date(row["created_at"]),
                lastLoginAt=iso_date(row["last_login_at"]))


@router.get("/admin/members")
def members(request: Request, q: str = Query("", max_length=100), page: int = Query(1, ge=1, le=10000)):
    require_role(request, "admin")
    # LIKE 검색에서 %, _를 입력해도 문자 자체로 취급합니다.
    pattern = "%" + q.strip().replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"
    where = " WHERE email LIKE %s ESCAPE '!' OR display_name LIKE %s ESCAPE '!'"
    with database() as connection, connection.cursor() as cursor:
        cursor.execute("SELECT COUNT(*) AS total FROM account_users" + where, (pattern, pattern))
        total = cursor.fetchone()["total"]
        cursor.execute("SELECT id, email, display_name, role, is_active, created_at, last_login_at FROM account_users" + where + " ORDER BY created_at DESC, id DESC LIMIT 30 OFFSET %s", (pattern, pattern, (page - 1) * 30))
        users = cursor.fetchall()
        cursor.execute("""SELECT COUNT(*) AS total, SUM(role = 'reporter' AND is_active = 1) AS reporters,
                          SUM(role = 'admin' AND is_active = 1) AS admins,
                          SUM(is_active = 0) AS suspended FROM account_users""")
        stats = {key: int(value or 0) for key, value in cursor.fetchone().items()}
    return reply({"items": [member_json(u) for u in users], "total": total, "page": page, "pageSize": 30, "stats": stats})


@router.patch("/admin/members/{member_id}")
def update_member(member_id: int, data: MemberUpdate, request: Request):
    actor = require_role(request, "admin")
    check_csrf(request, actor)
    if actor["id"] == member_id and (data.role != "admin" or not data.is_active):
        raise HTTPException(409, "자신의 관리자 권한을 없애거나 자신의 계정을 정지할 수 없습니다.")
    with database() as connection, connection.cursor() as cursor:
        # 관리자 변경을 직렬화해 두 관리자가 동시에 서로를 강등시키는 상황을 막습니다.
        cursor.execute("SELECT id FROM account_users WHERE role = 'admin' AND is_active = 1 ORDER BY id FOR UPDATE")
        admins = [row["id"] for row in cursor.fetchall()]
        if actor["id"] not in admins:
            raise HTTPException(403, "관리자 권한이 변경되었습니다. 다시 로그인하세요.")
        cursor.execute("SELECT * FROM account_users WHERE id = %s FOR UPDATE", (member_id,))
        target = cursor.fetchone()
        if not target:
            raise HTTPException(404, "회원을 찾지 못했습니다.")
        if target["id"] in admins and (data.role != "admin" or not data.is_active) and len(admins) <= 1:
            raise HTTPException(409, "마지막 관리자 계정은 유지해야 합니다.")
        cursor.execute("UPDATE account_users SET role = %s, is_active = %s, updated_at = UTC_TIMESTAMP() WHERE id = %s", (data.role, data.is_active, member_id))
        if not data.is_active:
            cursor.execute("DELETE FROM account_sessions WHERE user_id = %s", (member_id,))
        for action, old, new in (("role", target["role"], data.role), ("active", str(int(target["is_active"])), str(int(data.is_active)))):
            if old != new:
                cursor.execute("INSERT INTO account_audit (actor_id, target_id, action, old_value, new_value, created_at) VALUES (%s, %s, %s, %s, %s, UTC_TIMESTAMP())", (actor["id"], member_id, action, old, new))
    return reply({"member": member_json(dict(target, role=data.role, is_active=data.is_active))})


@router.get("/admin/audit")
def audit(request: Request):
    require_role(request, "admin")
    with database() as connection, connection.cursor() as cursor:
        cursor.execute("""SELECT a.id, a.action, a.old_value, a.new_value, a.created_at,
                          actor.display_name AS actor, target.email AS target
                          FROM account_audit a JOIN account_users actor ON actor.id = a.actor_id
                          JOIN account_users target ON target.id = a.target_id ORDER BY a.id DESC LIMIT 20""")
        items = cursor.fetchall()
    for item in items:
        item["created_at"] = iso_date(item["created_at"])
    return reply({"items": items})
