"""터미널에서만 실행하는 최초 관리자 생성/비밀번호 복구. 기본 비밀번호는 없습니다."""
import argparse
import getpass
import sys

from fastapi import HTTPException

from .database import database, initialize_schema
from .routes import SignupData, clean_email
from .security import hash_password


def main():
    parser = argparse.ArgumentParser(description="TODAY'S ROCK 회원 관리")
    parser.add_argument("command", choices=("init", "create-admin", "reset-password"))
    args = parser.parse_args()
    try:
        initialize_schema()
        if args.command == "init":
            print("회원 테이블 준비 완료. 기존 데이터는 유지했습니다.")
            return
        email = clean_email(input("이메일: "))
        if args.command == "create-admin":
            name = input("관리자 닉네임 (2~40자): ").strip()
        password = getpass.getpass("비밀번호 (10~128자, 입력 시 화면에 표시되지 않음): ")
        if password != getpass.getpass("비밀번호 확인: "):
            raise ValueError("두 비밀번호가 다릅니다.")
        # 가입 API와 동일한 입력 규칙을 적용합니다.
        SignupData(email=email, password=password, display_name=name if args.command == "create-admin" else "비밀번호 복구")
        encoded = hash_password(password)
        with database() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT id FROM account_users WHERE email = %s", (email,))
            existing = cursor.fetchone()
            if args.command == "create-admin":
                if existing:
                    raise ValueError("이미 가입한 이메일입니다. 다른 이메일을 쓰거나 관리자 페이지에서 권한을 변경하세요.")
                cursor.execute("INSERT INTO account_users (email, display_name, password_hash, role, created_at, updated_at) VALUES (%s, %s, %s, 'admin', UTC_TIMESTAMP(), UTC_TIMESTAMP())", (email, name, encoded))
            else:
                if not existing:
                    raise ValueError("해당 이메일의 계정이 없습니다.")
                cursor.execute("UPDATE account_users SET password_hash = %s, updated_at = UTC_TIMESTAMP() WHERE id = %s", (encoded, existing["id"]))
                cursor.execute("DELETE FROM account_sessions WHERE user_id = %s", (existing["id"],))
        print("관리자 계정 생성 완료. 홈페이지에서 로그인하세요." if args.command == "create-admin" else "비밀번호 변경 완료. 기존 로그인은 모두 해제했습니다.")
    except (ValueError, HTTPException) as error:
        print(f"실패: {getattr(error, 'detail', str(error))}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
