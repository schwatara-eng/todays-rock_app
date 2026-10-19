"""회원/권한 통합 테스트. DB_NAME이 _test로 끝나는 별도 MySQL/MariaDB에서만 실행합니다.

실행 예: DB_NAME=todays_rock_accounts_test python -m pytest tests/test_accounts.py -q
Windows에서는 PowerShell의 $env:DB_NAME으로 테스트 DB를 지정하세요.
"""
import os
from pathlib import Path
import shutil

import pymysql
import pytest
from fastapi.testclient import TestClient

from account_system.database import connect, initialize_schema
from account_system.security import COOKIE_NAME, hash_password, verify_password
from main import app

ORIGIN = "http://localhost:8000"
PASSWORD = "test-password-12345"


@pytest.fixture(autouse=True)
def clean_test_database(tmp_path, monkeypatch):
    if not os.getenv("DB_NAME", "").endswith("_test"):
        pytest.fail("DB_NAME이 _test로 끝나는 별도 테스트 DB가 필요합니다. 운영 DB에서는 실행하지 않습니다.")
    connection = connect()
    with connection.cursor() as cursor:
        cursor.execute("""CREATE TABLE IF NOT EXISTS songs (
            id INT PRIMARY KEY, title VARCHAR(200), artist VARCHAR(200), year SMALLINT,
            genre VARCHAR(100), lyrics_url VARCHAR(500)) ENGINE=InnoDB""")
        cursor.execute("INSERT IGNORE INTO songs VALUES (1, 'Heroes', 'David Bowie', 1977, 'Art Rock', ''), (2, 'Dreams', 'The Cranberries', 1992, 'Rock', '')")
    connection.commit(); connection.close()
    initialize_schema()
    connection = connect()
    with connection.cursor() as cursor:
        for table in ("account_sessions", "account_likes", "account_audit", "account_auth_limits", "account_users"):
            cursor.execute("DELETE FROM " + table)
    connection.commit(); connection.close()
    from editor_python import routes
    for name in ("admin/index.html", "accounts/forbidden.html"):
        destination = tmp_path / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(Path(__file__).resolve().parent.parent / name, destination)
    monkeypatch.setattr(routes, "ROOT", tmp_path)
    yield


def client():
    return TestClient(app, base_url=ORIGIN, headers={"Origin": ORIGIN})


def signup(c, email="reader@example.com", name="테스트 독자"):
    result = c.post("/api/auth/signup", json={"email": email, "password": PASSWORD, "display_name": name})
    assert result.status_code == 201, result.text
    return result.json()


def csrf(c):
    return {"X-CSRF-Token": c.get("/api/auth/me").json()["csrfToken"]}


def seed_admin():
    connection = connect()
    with connection.cursor() as cursor:
        cursor.execute("INSERT INTO account_users (email, display_name, password_hash, role) VALUES (%s, %s, %s, 'admin')", ("admin@example.com", "관리자", hash_password(PASSWORD)))
    connection.commit(); connection.close()
    c = client()
    assert c.post("/api/auth/login", json={"email": "admin@example.com", "password": PASSWORD}).status_code == 200
    return c


def set_role(admin, user_id, role="reporter", active=True):
    return admin.patch(f"/api/admin/members/{user_id}", json={"role": role, "is_active": active}, headers=csrf(admin))


def test_guest_route_guards():
    c = client()
    assert c.get("/api/auth/me").json()["user"] is None
    for url in ("/mypage", "/admin/", "/editor/"):
        r = c.get(url, follow_redirects=False)
        assert r.status_code == 303 and r.headers["location"].startswith("/login?")
    for url in ("/api/me/likes", "/api/admin/members", "/local/data", "/site/index.html", "/editor/app.js"):
        assert c.get(url).status_code == 401
    assert c.get("/api/auth/me", headers={"Host": "untrusted.example"}).status_code == 400


def test_signup_cannot_choose_role_and_uses_password_hash():
    c = client()
    payload = {"email": "Reader@Example.com", "password": PASSWORD, "display_name": "독자 계정", "role": "admin"}
    assert c.post("/api/auth/signup", json=payload).status_code == 422
    payload.pop("role")
    r = c.post("/api/auth/signup", json=payload)
    assert r.status_code == 201
    assert r.json()["user"]["role"] == "user"
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert "password_hash" not in r.text
    connection = connect()
    with connection.cursor() as cursor:
        cursor.execute("SELECT password_hash, email FROM account_users")
        stored = cursor.fetchone()
    connection.close()
    assert stored["email"] == "reader@example.com"
    assert stored["password_hash"] != PASSWORD and verify_password(PASSWORD, stored["password_hash"])
    assert client().post("/api/auth/signup", json=payload).status_code == 409
    payload["email"] = "other@example.com"; payload["password"] = "short"
    assert c.post("/api/auth/signup", json=payload).status_code == 422


def test_login_csrf_origin_and_logout():
    c = client(); signup(c)
    old_token = c.cookies.get(COOKIE_NAME)
    assert c.post("/api/auth/login", json={"email": "reader@example.com", "password": "wrong"}).status_code == 401
    assert c.post("/api/auth/login", json={"email": "reader@example.com", "password": PASSWORD}).status_code == 200
    old_client = client(); old_client.cookies.set(COOKIE_NAME, old_token)
    assert old_client.get("/api/auth/me").json()["user"] is None
    assert c.post("/api/auth/logout").status_code == 403
    assert c.post("/api/auth/logout", headers={**csrf(c), "Origin": "https://other.example"}).status_code == 403
    assert c.post("/api/auth/logout", headers={"X-CSRF-Token": "x" * 43}).status_code == 403
    assert c.post("/api/auth/logout", headers=csrf(c)).status_code == 200
    assert c.get("/api/auth/me").json()["user"] is None
    assert client().post("/api/auth/login", json={"email": "reader@example.com", "password": PASSWORD}, headers={"Origin": "https://other.example"}).status_code == 403


def test_reader_and_reporter_permissions_and_admin_promotion():
    admin = seed_admin(); reader = client(); user = signup(reader)["user"]
    for url in ("/editor/", "/local/data", "/site/index.html", "/api/admin/members", "/admin/"):
        assert reader.get(url).status_code == 403
    assert set_role(reader, user["id"]).status_code == 403
    assert set_role(admin, user["id"]).status_code == 200
    account = reader.get("/api/auth/me").json()["user"]
    assert account["role"] == "reporter" and account["canEdit"]
    assert reader.get("/editor/").status_code == 200
    assert reader.get("/local/artists").status_code == 200
    assert reader.get("/api/admin/members").status_code == 403
    assert set_role(admin, user["id"], "user").status_code == 200
    assert reader.get("/local/data").status_code == 403
    audit = admin.get("/api/admin/audit").json()["items"]
    assert len(audit) == 2


def test_reporter_save_requires_csrf_and_preserves_editor_function():
    admin = seed_admin(); reporter = client(); user = signup(reporter)["user"]
    assert set_role(admin, user["id"]).status_code == 200
    payload = {"artist": "test-musician", "artistInfo": {"name": "Test Musician", "nameKo": "테스트"}, "article": {"title": "테스트 원고", "body": "기자가 직접 쓴 테스트 원고입니다."}}
    assert reporter.post("/local/save", json=payload).status_code == 403
    assert reporter.post("/local/save", json=payload, headers={**csrf(reporter), "Origin": "https://other.example"}).status_code == 403
    assert reporter.post("/local/save", json=payload, headers=csrf(reporter)).status_code == 200
    assert reporter.get("/local/data?artist=test-musician").json()["article"]["title"] == "테스트 원고"
    assert reporter.post("/local/photo?artist=test-musician", content=b"fake image").status_code == 403


def test_suspension_revokes_sessions_and_restoration_requires_login():
    admin = seed_admin(); reader = client(); user = signup(reader)["user"]
    assert set_role(admin, user["id"], "user", False).status_code == 200
    assert reader.get("/api/me/likes").status_code == 401
    assert reader.post("/api/auth/login", json={"email": user["email"], "password": PASSWORD}).status_code == 401
    assert set_role(admin, user["id"], "user", True).status_code == 200
    assert reader.get("/api/auth/me").json()["user"] is None
    assert reader.post("/api/auth/login", json={"email": user["email"], "password": PASSWORD}).status_code == 200


def test_likes_are_idempotent_and_separate_for_each_user():
    a = client(); signup(a)
    b = client(); signup(b, "other@example.com")
    for _ in range(2):
        assert a.put("/api/me/likes/1", headers=csrf(a)).status_code == 200
    assert a.get("/api/me/likes").json()["total"] == 1
    assert a.get("/api/me/like-ids").json()["songIds"] == [1]
    assert b.get("/api/me/likes").json()["total"] == 0
    assert b.delete("/api/me/likes/1", headers=csrf(b)).status_code == 200
    assert a.get("/api/me/likes").json()["total"] == 1
    assert a.put("/api/me/likes/999999", headers=csrf(a)).status_code == 404
    assert a.delete("/api/me/likes/1", headers=csrf(a)).status_code == 200
    assert a.get("/api/me/likes").json()["total"] == 0


def test_profile_password_change_rotates_sessions():
    c = client(); signup(c)
    second = client(); second.post("/api/auth/login", json={"email": "reader@example.com", "password": PASSWORD})
    assert c.patch("/api/me/profile", json={"display_name": "새 닉네임"}, headers=csrf(c)).status_code == 200
    assert c.get("/api/auth/me").json()["user"]["displayName"] == "새 닉네임"
    assert c.patch("/api/me/profile", json={"display_name": "독자", "role": "admin"}, headers=csrf(c)).status_code == 422
    payload = {"current_password": "wrong", "new_password": "changed-password-56789"}
    assert c.put("/api/me/password", json=payload, headers=csrf(c)).status_code == 400
    payload["current_password"] = PASSWORD
    assert c.put("/api/me/password", json=payload, headers=csrf(c)).status_code == 200
    assert second.get("/api/auth/me").json()["user"] is None
    assert c.get("/api/auth/me").json()["user"] is not None
    assert second.post("/api/auth/login", json={"email": "reader@example.com", "password": PASSWORD}).status_code == 401
    assert second.post("/api/auth/login", json={"email": "reader@example.com", "password": payload["new_password"]}).status_code == 200


def test_admin_self_protection_search_and_non_destructive_schema():
    admin = seed_admin(); user_id = admin.get("/api/auth/me").json()["user"]["id"]
    assert set_role(admin, user_id, "user").status_code == 409
    assert set_role(admin, user_id, "admin", False).status_code == 409
    assert admin.get("/api/admin/members?q=%25").json()["total"] == 0
    assert admin.get("/api/admin/members", params={"q": "' OR 1=1 --"}).json()["total"] == 0
    initialize_schema(); initialize_schema()
    assert admin.get("/api/auth/me").json()["user"]["role"] == "admin"
    assert admin.get("/api/admin/members").json()["total"] == 1


def test_expired_session_and_login_rate_limit():
    c = client(); signup(c)
    connection = connect()
    with connection.cursor() as cursor:
        cursor.execute("UPDATE account_sessions SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 HOUR)")
    connection.commit(); connection.close()
    assert c.get("/api/auth/me").json()["user"] is None
    for _ in range(15):
        assert c.post("/api/auth/login", json={"email": "reader@example.com", "password": "wrong"}).status_code == 401
    assert c.post("/api/auth/login", json={"email": "reader@example.com", "password": PASSWORD}).status_code == 429
