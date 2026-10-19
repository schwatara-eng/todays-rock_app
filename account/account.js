// TODAY'S ROCK — 회원 기능 공통 스크립트
// 홈페이지와 로그인·마이페이지·관리자 페이지가 함께 사용한다.
//  1) 머리말 오른쪽 #auth-nav 에 로그인 상태에 맞는 버튼을 그린다.
//  2) <body data-page="login|mypage|admin"> 에 맞는 화면 동작을 실행한다.
//  3) 홈페이지의 좋아요 버튼이 쓸 수 있도록 window.TRAuth 를 내보낸다.

(function () {
  // 1. 공통 도구
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    let data = {};
    try { data = await response.json(); } catch { /* 빈 응답 */ }
    if (!response.ok) {
      const error = new Error(data.detail || data.error || "요청을 처리하지 못했어요.");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  const post = (url, body) => api(url, { method: "POST", body: JSON.stringify(body || {}) });

  function formatDate(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
  }

  // 로그인 후 돌아갈 주소. 다른 사이트로 튕겨 나가지 않도록 우리 사이트 경로만 허용한다.
  function safeNext(value) {
    return value && value.startsWith("/") && !value.startsWith("//") ? value : "";
  }

  // 2. 로그인 상태 (한 번만 불러와 함께 쓴다)
  const userReady = api("/api/auth/me").then((data) => data.user).catch(() => null);

  async function logout() {
    try { await post("/api/auth/logout"); } catch { /* 이미 로그아웃 */ }
    location.href = "/";
  }

  // 3. 머리말 버튼
  function renderNav(user) {
    const nav = document.querySelector("#auth-nav");
    if (!nav) return;

    if (!user) {
      const here = location.pathname.startsWith("/account/") ? "" : `?next=${encodeURIComponent(location.pathname)}`;
      nav.innerHTML = `
        <a class="auth-link" href="/account/login.html${here}">로그인</a>
        <a class="auth-link auth-link-strong" href="/account/login.html?mode=signup">회원가입</a>`;
      return;
    }

    nav.innerHTML = `
      ${user.role === "admin" ? '<a class="auth-link" href="/account/admin.html">관리실</a>' : ""}
      <a class="auth-link" href="/account/mypage.html">${escapeHtml(user.nickname)}</a>
      <button class="auth-link" type="button" data-logout>로그아웃</button>`;
    nav.querySelector("[data-logout]").addEventListener("click", logout);
  }

  // 4. 로그인 · 회원가입 화면
  function initLogin() {
    const params = new URLSearchParams(location.search);
    const next = safeNext(params.get("next"));
    const form = document.querySelector("#auth-form");
    const message = document.querySelector("#auth-message");
    const nicknameField = document.querySelector("#nickname-field");
    const submit = form.querySelector("button[type=submit]");
    let mode = params.get("mode") === "signup" ? "signup" : "login";

    function setMode(nextMode) {
      mode = nextMode;
      document.querySelectorAll(".auth-tab").forEach((tab) => {
        tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
      });
      nicknameField.hidden = mode !== "signup";
      nicknameField.querySelector("input").required = mode === "signup";
      form.password.autocomplete = mode === "signup" ? "new-password" : "current-password";
      submit.textContent = mode === "signup" ? "가입하기" : "로그인";
      document.querySelector("#auth-title").textContent = mode === "signup" ? "회원가입" : "로그인";
      message.textContent = "";
      message.className = "message";
    }

    document.querySelectorAll(".auth-tab").forEach((tab) => {
      tab.addEventListener("click", () => setMode(tab.dataset.mode));
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      message.className = "message";
      message.textContent = mode === "signup" ? "가입하는 중이에요…" : "로그인하는 중이에요…";
      try {
        const body = { email: form.email.value, password: form.password.value };
        if (mode === "signup") body.nickname = form.nickname.value;
        const { user } = await post(`/api/auth/${mode}`, body);
        location.href = next || (user.role === "admin" ? "/account/admin.html" : "/account/mypage.html");
      } catch (error) {
        message.className = "message error";
        message.textContent = error.message;
        submit.disabled = false;
      }
    });

    userReady.then((user) => { if (user) location.replace(next || "/account/mypage.html"); });
    setMode(mode);
  }

  // 5. 마이페이지
  async function initMypage(user) {
    if (!user) return location.replace("/account/login.html?next=/account/mypage.html");

    document.querySelector("#profile-name").innerHTML =
      `${escapeHtml(user.nickname)} <span class="role-badge role-${user.role}">${escapeHtml(user.roleName)}</span>`;
    document.querySelector("#profile-email").textContent = user.email;

    const actions = document.querySelector("#profile-actions");
    // 편집실 버튼은 기자(와 모든 권한을 가진 관리자)에게만 보인다.
    if (user.canEdit) actions.insertAdjacentHTML("beforeend", '<a class="btn btn-primary" href="/editor/">편집실 ↗</a>');
    if (user.role === "admin") actions.insertAdjacentHTML("beforeend", '<a class="btn" href="/account/admin.html">관리실 ↗</a>');

    if (new URLSearchParams(location.search).get("denied") === "editor") {
      document.querySelector("#notice").hidden = false;
    }

    const list = document.querySelector("#like-list");
    try {
      const { likes } = await api("/api/me/likes");
      document.querySelector("#like-count").textContent = likes.length;
      if (likes.length === 0) {
        list.outerHTML = '<p class="empty">아직 좋아요한 곡이 없어요. 홈에서 추천받은 곡에 ♥를 눌러보세요.</p>';
        return;
      }
      list.innerHTML = likes.map((song) => {
        const youtube = `https://www.youtube.com/results?search_query=${encodeURIComponent(song.artist + " " + song.title)}`;
        return `
          <li class="like-item">
            <div><h3>${escapeHtml(song.title)} <span class="artist">· ${escapeHtml(song.artist)}</span></h3></div>
            <p class="meta">${escapeHtml(song.year)} · ${escapeHtml(song.genre)} · ${formatDate(song.likedAt)}에 좋아요</p>
            <div class="like-links">
              <a class="btn btn-small" href="${youtube}" target="_blank" rel="noopener">YouTube ↗</a>
              ${song.lyricsUrl ? `<a class="btn btn-small" href="${escapeHtml(song.lyricsUrl)}" target="_blank" rel="noopener">가사 ↗</a>` : ""}
              <button class="btn btn-small" type="button" data-unlike="${song.id}">♥ 취소</button>
            </div>
          </li>`;
      }).join("");
      list.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-unlike]");
        if (!button) return;
        button.disabled = true;
        await toggleLike(Number(button.dataset.unlike));
        button.closest(".like-item").remove();
        const count = document.querySelector("#like-count");
        count.textContent = Number(count.textContent) - 1;
      });
    } catch (error) {
      list.outerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
    }
  }

  // 6. 관리자 페이지
  async function initAdmin(user) {
    if (!user) return location.replace("/account/login.html?next=/account/admin.html");
    if (user.role !== "admin") return location.replace("/account/mypage.html");

    const body = document.querySelector("#user-rows");
    const message = document.querySelector("#admin-message");

    async function load() {
      const { users } = await api("/api/admin/users");
      const count = (role) => users.filter((u) => u.role === role).length;
      document.querySelector("#stat-total").textContent = users.length;
      document.querySelector("#stat-reporter").textContent = count("reporter");
      document.querySelector("#stat-user").textContent = count("user");

      body.innerHTML = users.map((u) => {
        let action = '<span class="meta">—</span>';
        if (u.role === "user") action = `<button class="btn btn-small" type="button" data-id="${u.id}" data-role="reporter">기자로 승격</button>`;
        if (u.role === "reporter") action = `<button class="btn btn-small" type="button" data-id="${u.id}" data-role="user">사용자로 변경</button>`;
        return `
          <tr>
            <td>${escapeHtml(u.nickname)}${u.id === user.id ? ' <span class="meta">(나)</span>' : ""}</td>
            <td>${escapeHtml(u.email)}</td>
            <td><span class="role-badge role-${u.role}">${escapeHtml(u.roleName)}</span></td>
            <td>${formatDate(u.createdAt)}</td>
            <td class="num">${u.likes}</td>
            <td>${action}</td>
          </tr>`;
      }).join("");
    }

    body.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-role]");
      if (!button) return;
      const name = button.closest("tr").firstElementChild.textContent.trim();
      const toReporter = button.dataset.role === "reporter";
      if (!confirm(`${name} 님을 ${toReporter ? "기자로 승격" : "사용자로 변경"}할까요?`)) return;
      button.disabled = true;
      try {
        await post(`/api/admin/users/${button.dataset.id}/role`, { role: button.dataset.role });
        message.className = "message";
        message.textContent = `${name} 님의 권한을 바꿨어요.`;
        await load();
      } catch (error) {
        message.className = "message error";
        message.textContent = error.message;
        button.disabled = false;
      }
    });

    try { await load(); }
    catch (error) {
      message.className = "message error";
      message.textContent = error.message;
    }
  }

  // 7. 좋아요 (홈페이지에서 사용)
  async function toggleLike(songId) {
    return post(`/api/likes/${songId}`);
  }

  async function likedIds() {
    try { return new Set((await api("/api/likes/ids")).ids); }
    catch { return new Set(); }
  }

  window.TRAuth = { user: userReady, toggleLike, likedIds, escapeHtml };

  // 8. 시작
  userReady.then((user) => {
    renderNav(user);
    const page = document.body.dataset.page;
    if (page === "mypage") initMypage(user);
    if (page === "admin") initAdmin(user);
  });
  if (document.body.dataset.page === "login") initLogin();
})();
