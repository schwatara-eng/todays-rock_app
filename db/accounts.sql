-- 회원 전용 추가 스키마. 기존 곡/기사/회원 데이터를 삭제하지 않습니다.
-- Workbench에서 직접 실행할 때는 먼저 기존 todays_rock 데이터베이스를 선택하세요.

CREATE TABLE IF NOT EXISTS account_users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
    display_name VARCHAR(40) NOT NULL,
    password_hash VARCHAR(255) CHARACTER SET ascii NOT NULL,
    role ENUM('user', 'reporter', 'admin') NOT NULL DEFAULT 'user',
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME NULL,
    UNIQUE KEY uq_account_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS account_sessions (
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    csrf_token CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME NOT NULL,
    KEY ix_account_session_user (user_id),
    KEY ix_account_session_expiry (expires_at),
    CONSTRAINT fk_account_session_user FOREIGN KEY (user_id) REFERENCES account_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS account_likes (
    user_id BIGINT UNSIGNED NOT NULL,
    song_id INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, song_id),
    KEY ix_account_likes_date (user_id, created_at),
    CONSTRAINT fk_account_like_user FOREIGN KEY (user_id) REFERENCES account_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS account_audit (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    actor_id BIGINT UNSIGNED NOT NULL,
    target_id BIGINT UNSIGNED NOT NULL,
    action VARCHAR(32) NOT NULL,
    old_value VARCHAR(40) NOT NULL,
    new_value VARCHAR(40) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_account_audit_date (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS account_auth_limits (
    bucket_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    window_start DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
