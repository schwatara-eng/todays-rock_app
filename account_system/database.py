"""기존 곡 DB와 같은 .env/DB를 사용합니다. 스키마 추가는 관리 명령으로 실행합니다."""
from contextlib import contextmanager
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import HTTPException
import pymysql

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def connect():
    return pymysql.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"),
        port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"),
        password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "todays_rock"),
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=5,
        read_timeout=10,
        write_timeout=10,
    )


@contextmanager
def database():
    connection = None
    try:
        connection = connect()
        yield connection
        connection.commit()
    except pymysql.MySQLError:
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
    # 이 파일에는 CREATE TABLE IF NOT EXISTS만 있습니다. 기존 곡/기사/회원은 지우지 않습니다.
    sql = (ROOT / "db/accounts.sql").read_text(encoding="utf-8")
    sql = "\n".join(line for line in sql.splitlines() if not line.lstrip().startswith("--"))
    with database() as connection, connection.cursor() as cursor:
        for statement in sql.split(";"):
            if statement.strip():
                cursor.execute(statement)
