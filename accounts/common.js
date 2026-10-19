/* 홈페이지와 계정 화면의 공통 인증/회원 메뉴. 권한은 서버의 최신 응답을 사용합니다. */
(() => {
  const state = { user: null, csrfToken: '', likedIds: new Set(), likesLoaded: false, error: null };
  const account = window.TRAccount = { state };

  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function loginUrl(next = location.pathname + location.search) {
    return '/login?next=' + encodeURIComponent(next);
  }

  function nextPage(fallback = '/mypage') {
    const raw = new URLSearchParams(location.search).get('next');
    if (!raw) return fallback;
    try {
      const target = new URL(raw, location.origin);
      if (target.origin !== location.origin || !raw.startsWith('/') || raw.startsWith('//') || /[\\\r\n]/.test(raw)) return fallback;
      return target.pathname + target.search + target.hash;
    } catch { return fallback; }
  }

  async function api(url, options = {}) {
    const headers = { ...options.headers };
    if (options.body && typeof options.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase()) && state.csrfToken) {
      headers['X-CSRF-Token'] = state.csrfToken;
    }
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      let detail = data.detail || data.error;
      if (Array.isArray(detail)) detail = '입력 내용을 확인하세요. 닉네임은 2~40자, 비밀번호는 10~128자입니다.';
      const error = new Error(typeof detail === 'string' ? detail : `요청을 처리하지 못했습니다. (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function setAccount(data) {
    state.user = data.user;
    state.csrfToken = data.csrfToken || '';
    renderHeader();
  }

  function renderHeader() {
    const nav = document.getElementById('account-nav');
    if (!nav) return;
    nav.replaceChildren();
    function link(text, href, className) {
      const a = node('a', text, className); a.href = href; nav.append(a);
    }
    if (!state.user) {
      link('회원가입', '/signup'); link('로그인', loginUrl());
      return;
    }
    const name = node('span', state.user.displayName + ' 님', 'account-name'); nav.append(name);
    link('마이페이지', '/mypage');
    if (state.user.isAdmin) link('관리자', '/admin/');
    const logout = node('button', '로그아웃'); logout.type = 'button';
    logout.addEventListener('click', async () => {
      logout.disabled = true;
      try { await api('/api/auth/logout', { method: 'POST' }); location.assign('/'); }
      catch (error) {
        if (error.status === 401) location.assign('/login');
        else { alert(error.message); logout.disabled = false; }
      }
    });
    nav.append(logout);
  }

  async function loadLikeIds() {
    if (!state.user || state.likesLoaded) return;
    const result = await api('/api/me/like-ids');
    state.likedIds = new Set(result.songIds);
    state.likesLoaded = true;
  }

  function syncLikeButtons(songId, animate = false) {
    document.querySelectorAll('[data-like-song]').forEach(button => {
      const id = Number(button.dataset.likeSong);
      if (songId !== undefined && id !== songId) return;
      const liked = state.likedIds.has(id);
      const wasLiked = button.getAttribute('aria-pressed') === 'true';
      if (!button.classList.contains('like-button-icon')) button.textContent = liked ? '♥ 좋아요' : '♡ 좋아요';
      button.setAttribute('aria-pressed', String(liked));
      button.classList.toggle('is-liked', liked);
      button.setAttribute('aria-label', `${button.dataset.songLabel} ${liked ? '좋아요 취소' : '좋아요'}`);
      button.title = button.getAttribute('aria-label');
      if (!liked) button.classList.remove('is-popping');
      if (animate && liked && !wasLiked) {
        button.classList.remove('is-popping');
        void button.offsetWidth;
        button.classList.add('is-popping');
      }
    });
  }

  function heartIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const icon = document.createElementNS(ns, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    icon.classList.add('like-heart');
    const shape = document.createElementNS(ns, 'path');
    shape.setAttribute('d', 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z');
    icon.append(shape);
    return icon;
  }

  function addLikeButton(container, song, { iconOnly = false } = {}) {
    const id = Number(song.id);
    if (!Number.isInteger(id) || id <= 0) return;
    const button = node('button', undefined, iconOnly ? 'like-button like-button-icon' : 'like-button');
    if (iconOnly) button.append(heartIcon());
    else button.textContent = '♡ 좋아요';
    button.type = 'button'; button.dataset.likeSong = String(id);
    button.dataset.songLabel = song.artist + ' - ' + song.title;
    button.setAttribute('aria-pressed', 'false');
    container.append(button);
    syncLikeButtons(id);
    button.addEventListener('animationend', () => button.classList.remove('is-popping'));
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await account.ready;
        if (state.error) throw state.error;
        if (!state.user) { location.assign(loginUrl()); return; }
        await loadLikeIds();
        const data = await api('/api/me/likes/' + id, { method: state.likedIds.has(id) ? 'DELETE' : 'PUT' });
        if (data.liked) state.likedIds.add(id); else state.likedIds.delete(id);
        syncLikeButtons(id, true);
        document.dispatchEvent(new CustomEvent('tr:likes-changed', { detail: data }));
      } catch (error) {
        if (error.status === 401) location.assign(loginUrl());
        else {
          const message = document.getElementById('page-message') || document.getElementById('selection-message');
          if (message) message.textContent = error.message;
          else alert(error.message);
        }
      } finally { button.disabled = false; }
    });
  }

  account.ready = (async () => {
    try {
      setAccount(await api('/api/auth/me'));
      if (state.user && document.getElementById('song-list')) {
        await loadLikeIds(); syncLikeButtons();
      }
    } catch (error) { state.error = error; renderHeader(); }
    return state.user;
  })();
  Object.assign(account, { api, node, setAccount, nextPage, loginUrl, addLikeButton });
})();
