"""PostgreSQL(Supabase 포함) 연결. 곡 API와 회원 기능이 같은 DB를 사용합니다.

접속 정보는 .env에서 읽습니다.
  - DATABASE_URL이 있으면 그것을 씁니다. (Supabase 대시보드의 Connect에서 복사한 주소)
  - 없으면 DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SSLMODE로 접속합니다.
스키마 추가는 관리 명령(python -m account_system.manage init)으로 실행합니다.
"""
from contextlib import contextmanager
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import HTTPException
import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

DatabaseError = psycopg.Error


def connect():
    options = dict(
        row_factory=dict_row,     # 결과를 {"칸 이름": 값} 형태로 받습니다.
        connect_timeout=5,
        # Supabase 연결 풀러(특히 6543 transaction 모드)는 prepared statement를 지원하지 않으므로 끕니다.
        prepare_threshold=None,
    )
    url = os.getenv("DATABASE_URL", "").strip()
    if url:
        return psycopg.connect(url, **options)
    return psycopg.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "5432")),
        user=os.getenv("DB_USER", "postgres"),
        password=os.getenv("DB_PASSWORD", ""),
        dbname=os.getenv("DB_NAME", "todays_rock"),
        sslmode=os.getenv("DB_SSLMODE", "prefer"),
        **options,
    )


@contextmanager
def database():
    connection = None
    try:
        connection = connect()
        yield connection
        connection.commit()
    except psycopg.Error:
        if connection:
            connection.rollback()
        logging.exception("회원 DB 처리 실패")
        raise HTTPException(503, "계정 정보를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.") from None
    except BaseException:
        if connection:
            connection.rollback()
        raise
    finally:
        if connection:
            connection.close()


def initialize_schema():
    # 이 파일에는 CREATE ... IF NOT EXISTS와 보안 설정만 있습니다. 기존 곡/기사/회원은 지우지 않습니다.
    sql = (ROOT / "db/accounts.sql").read_text(encoding="utf-8")
    sql = "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--"))
    with database() as connection, connection.cursor() as cursor:
        for statement in sql.split(";"):
            if statement.strip():
                cursor.execute(statement)
