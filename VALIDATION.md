# 회원 계정 시스템 검증

검증일: 2026-10-19

기존 GitHub 소스를 기준으로 수정본을 만들고 별도 테스트 DB에서 검사했습니다. 실제 사용자 DB나 기사 원고를 사용한 검증은 아닙니다.

## 서버·DB 통합 테스트

`tests/test_accounts.py`의 10개 테스트가 통과했습니다.

- 비로그인 사용자의 마이페이지·관리자·편집실/API 접근 차단
- 회원가입 시 관리자/기자 권한 지정 차단, 중복 이메일 거절, 비밀번호 해시 저장
- 로그인 세션 교체, 로그아웃, 요청 출처와 CSRF 토큰 검사
- 관리자에 의한 기자 승격·강등과 다음 요청의 편집실 권한 반영
- 기자의 초안 저장과 관리자 페이지 접근 차단
- 계정 정지 시 세션 해제, 계정 복구 후 재로그인 요구
- 계정별 좋아요 분리, 중복 좋아요 방지, 좋아요 취소
- 닉네임 변경, 비밀번호 변경 후 다른 세션 해제
- 자기 관리자 권한 제거/자기 계정 정지 방지, 회원 검색 입력 처리
- 만료 세션 거절, 반복 로그인 시도 제한, 스키마 반복 적용 시 데이터 유지

명령행 `create-admin`, `reset-password`, `init`도 실제 테스트 DB에서 실행해 완료를 확인했습니다.

## 브라우저 검증

Chromium에서 16개 확인 항목이 통과했습니다.

- 홈 상단 문구 오른쪽 회원가입·로그인 위치와 기존 편집실 버튼 제거
- 실제 500곡 SQL 데이터로 추천곡 3개 표시
- 화면에서 가입 → 추천곡 좋아요 → 마이페이지 저장 → 새로고침 후 유지
- 일반 사용자 마이페이지에서 편집실 버튼 숨김
- 관리자 화면의 기자 승격 → 기자 마이페이지의 편집실 버튼 표시 → 편집실 초기 로드
- 기자의 관리자 페이지 접근 거절
- 관리자 화면에서 계정 정지 → 기존 브라우저의 로그인 해제
- 서로 다른 계정의 좋아요 기록 분리
- 관리자 화면의 편집실 링크
- 390px 모바일의 가입·마이페이지·관리자 화면 배치
- 화면 JavaScript 오류 없음

1440px 데스크톱과 390px 모바일 화면을 캡처해 배치를 확인했습니다. 뉴스·날씨는 화면 테스트 중 고정 응답을 사용했고, 외부 AI 검색·번역·과금 호출은 실행하지 않았습니다.

## 환경과 남은 확인

- 실행 환경: Linux, Python 3.12.14, FastAPI 0.146.0, Pydantic 2.14.1, MariaDB 10.11.14, Chromium 153
- Python 구문 검사, JavaScript 구문 검사, 변경 파일 공백 검사 통과
- 기존 MySQL용 SQL 전체(500곡)와 회원 추가 스키마를 MariaDB에서 실행
- 사용자 PC의 Windows 11 / Python 3.14.7 / MySQL 실행 환경은 적용 후 확인 필요
- 이메일 인증/메일 비밀번호 재설정, SNS 로그인은 구현 범위 밖

Pydantic의 Python 3.14 지원 기준은 [공식 2.12 릴리스 안내](https://pydantic.dev/articles/pydantic-v2-12-release)를 참고해 requirements에 반영했습니다. 쿠키 옵션은 [Starlette 공식 응답 문서](https://starlette.dev/responses/), 비밀번호 해시는 [Python hashlib 문서](https://docs.python.org/3.14/library/hashlib.html)를 참고했습니다.

## 테스트를 다시 실행할 때

통합 테스트는 이름이 `_test`로 끝나는 별도 DB에서만 실행되며, 그 DB의 회원 테스트 데이터를 비웁니다. 현재 사용 중인 DB에는 실행하지 않습니다.

```powershell
.\.venv\Scripts\python.exe -m pip install pytest
$env:DB_NAME = "todays_rock_accounts_test"
.\.venv\Scripts\python.exe -m pytest tests/test_accounts.py -q
Remove-Item Env:DB_NAME
```

먼저 MySQL에서 해당 테스트 DB를 생성하고 접속 권한을 준비해야 합니다. DB 접속 주소·계정은 기존 `.env` 설정을 사용합니다.
