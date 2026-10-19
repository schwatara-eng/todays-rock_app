/* 계정 화면의 입력/목록 제어. 서버가 각 요청의 본인 여부와 역할을 다시 검사합니다. */
(() => {
  const A = window.TRAccount;
  const $ = id => document.getElementById(id);
  const page = document.body.dataset.page;
  const roleNames = { user: '사용자', reporter: '기자', admin: '관리자' };
  let likesPage = 1, membersPage = 1, membersQuery = '';

  function message(text, error = false) {
    const output = $('page-message');
    output.textContent = text;
    output.classList.toggle('is-error', error);
  }

  function date(value, full = false) {
    if (!value) return '—';
    return new Date(value).toLocaleString('ko-KR', full
      ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'medium' });
  }

  async function run(button, work) {
    if (button) button.disabled = true;
    message('');
    try { await work(); }
    catch (error) {
      if (error.status === 401 && page !== 'auth') location.assign(A.loginUrl());
      else message(error.message, true);
    } finally { if (button) button.disabled = false; }
  }

  function form(id, handler) {
    $(id).addEventListener('submit', event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type="submit"]');
      run(button, handler);
    });
  }

  function authScreen() {
    const signup = location.pathname === '/signup';
    document.title = `${signup ? '회원가입' : '로그인'} — TODAY'S ROCK`;
    $('auth-title').textContent = signup ? '회원가입' : '로그인';
    $('auth-submit').textContent = signup ? '가입하고 시작하기' : '로그인';
    $('name-field').hidden = !signup; $('display-name').required = signup;
    $('confirm-field').hidden = !signup; $('password-confirm').required = signup;
    $('password-note').hidden = !signup;
    $('password').minLength = signup ? 10 : 1;
    $('password').autocomplete = signup ? 'new-password' : 'current-password';
    $('auth-intro').textContent = signup ? '마음에 드는 곡을 저장하고 다시 꺼내 들어요.' : '좋아하는 곡을 모아 나만의 기록을 만들어보세요.';
    const switchText = A.node('span', signup ? '이미 계정이 있나요? ' : '아직 계정이 없나요? ');
    const switchLink = A.node('a', signup ? '로그인' : '회원가입');
    const next = new URLSearchParams(location.search).get('next');
    switchLink.href = (signup ? '/login' : '/signup') + (next ? '?next=' + encodeURIComponent(next) : '');
    $('auth-switch').replaceChildren(switchText, switchLink);
    form('auth-form', async () => {
      if (signup && $('password').value !== $('password-confirm').value) throw new Error('두 비밀번호가 달라요. 다시 확인해주세요.');
      const payload = { email: $('email').value, password: $('password').value };
      if (signup) payload.display_name = $('display-name').value;
      const result = await A.api('/api/auth/' + (signup ? 'signup' : 'login'), { method: 'POST', body: payload });
      A.setAccount(result);
      location.assign(A.nextPage(result.user.isAdmin ? '/admin/' : '/mypage'));
    });
    A.ready.then(() => {
      if (A.state.user) location.replace(A.nextPage(A.state.user.isAdmin ? '/admin/' : '/mypage'));
    });
  }

  function roleLinks(user) {
    const links = $('role-links'); links.replaceChildren();
    if (user.canEdit) {
      const editor = A.node('a', '편집실 열기 ↗', 'account-primary'); editor.href = '/editor/'; links.append(editor);
    }
    if (user.isAdmin) {
      const admin = A.node('a', '관리자 페이지', 'account-secondary'); admin.href = '/admin/'; links.append(admin);
    }
  }

  async function loadLikes() {
    const data = await A.api('/api/me/likes?page=' + likesPage);
    if (!data.items.length && likesPage > 1) { likesPage = Math.max(1, Math.ceil(data.total / data.pageSize)); return loadLikes(); }
    $('likes-count').textContent = data.total;
    $('likes-list').replaceChildren();
    if (!data.items.length) {
      const row = A.node('tr'), empty = A.node('td', undefined, 'empty-state');
      empty.colSpan = 7;
      empty.append(A.node('strong', '아직 좋아요한 곡이 없어요.'), A.node('p', '추천곡에서 하트를 눌러 첫 곡을 모아보세요.'));
      const home = A.node('a', '오늘의 음악 찾기 ↗', 'account-secondary'); home.href = '/'; empty.append(home);
      row.append(empty); $('likes-list').append(row);
    }
    for (const [index, song] of data.items.entries()) {
      A.state.likedIds.add(song.id);
      const row = A.node('tr');
      const number = A.node('td', (likesPage - 1) * data.pageSize + index + 1, 'likes-number');
      const title = A.node('th', song.title, 'likes-song-title'); title.scope = 'row';
      const artist = A.node('td', song.artist, 'likes-artist');
      const details = A.node('td', `${song.year} · ${song.genre}`, 'likes-details');
      const saved = A.node('td', date(song.liked_at), 'likes-date');
      const listen = A.node('td');
      const youtube = A.node('a', 'YouTube ↗');
      youtube.href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(song.artist + ' ' + song.title);
      youtube.target = '_blank'; youtube.rel = 'noopener';
      youtube.setAttribute('aria-label', `${song.artist} - ${song.title} YouTube에서 듣기`);
      listen.append(youtube);
      const action = A.node('td', undefined, 'likes-action');
      row.append(number, title, artist, details, saved, listen, action);
      $('likes-list').append(row); A.addLikeButton(action, song, { iconOnly: true });
    }
    $('likes-prev').disabled = likesPage <= 1;
    $('likes-next').disabled = likesPage * data.pageSize >= data.total;
    $('likes-page').textContent = `${likesPage} / ${Math.max(1, Math.ceil(data.total / data.pageSize))}`;
  }

  async function mypage() {
    const user = A.state.user;
    $('welcome').textContent = `${user.displayName} 님의 음악을 모으는 곳이에요.`;
    $('profile-email').textContent = user.email; $('profile-role').textContent = user.roleLabel;
    $('profile-name').value = user.displayName;
    roleLinks(user);
    form('profile-form', async () => {
      const result = await A.api('/api/me/profile', { method: 'PATCH', body: { display_name: $('profile-name').value } });
      A.setAccount({ user: result.user, csrfToken: A.state.csrfToken });
      $('welcome').textContent = `${result.user.displayName} 님의 음악을 모으는 곳이에요.`;
      message('닉네임을 저장했어요.');
    });
    form('password-form', async () => {
      if ($('new-password').value !== $('new-password-confirm').value) throw new Error('새 비밀번호가 서로 달라요.');
      const result = await A.api('/api/me/password', { method: 'PUT', body: { current_password: $('current-password').value, new_password: $('new-password').value } });
      A.setAccount(result); $('password-form').reset();
      message('비밀번호를 변경했어요. 다른 기기의 로그인은 해제했어요.');
    });
    $('likes-prev').addEventListener('click', () => run(null, async () => { likesPage--; await loadLikes(); }));
    $('likes-next').addEventListener('click', () => run(null, async () => { likesPage++; await loadLikes(); }));
    document.addEventListener('tr:likes-changed', () => run(null, loadLikes));
    await loadLikes();
  }

  async function loadMembers() {
    const data = await A.api('/api/admin/members?page=' + membersPage + '&q=' + encodeURIComponent(membersQuery));
    $('members-list').replaceChildren(); $('members-empty').hidden = Boolean(data.items.length);
    for (const key of ['total', 'reporters', 'admins', 'suspended']) $('stat-' + key).textContent = data.stats[key];
    for (const member of data.items) {
      const self = member.id === A.state.user.id;
      const row = A.node('tr');
      const identity = A.node('td'); identity.append(A.node('strong', member.displayName + (self ? ' (본인)' : '')), A.node('span', member.email, 'member-email'));
      const joined = A.node('td', date(member.createdAt));
      const roleCell = A.node('td'), role = A.node('select');
      role.setAttribute('aria-label', member.displayName + ' 권한');
      for (const [value, label] of Object.entries(roleNames)) {
        const option = A.node('option', label); option.value = value; role.append(option);
      }
      role.value = member.role; role.disabled = self; roleCell.append(role);
      const activeCell = A.node('td'), active = A.node('select'); active.setAttribute('aria-label', member.displayName + ' 계정 상태');
      for (const [value, label] of [['1', '정상'], ['0', '정지']]) {
        const option = A.node('option', label); option.value = value; active.append(option);
      }
      active.value = member.isActive ? '1' : '0'; active.disabled = self; activeCell.append(active);
      const action = A.node('td'), save = A.node('button', '저장', 'member-save'); save.type = 'button'; save.disabled = self;
      save.setAttribute('aria-label', member.displayName + ' 변경 저장'); action.append(save);
      save.addEventListener('click', () => run(save, async () => {
        const newRole = role.value, newActive = active.value === '1';
        if (newRole === member.role && newActive === member.isActive) { message('변경한 내용이 없어요.'); return; }
        if ((newRole === 'admin' || !newActive) && !confirm(`${member.displayName} 님의 권한을 ${roleNames[newRole]}, 상태를 ${newActive ? '정상' : '정지'}로 바꿀까요?`)) return;
        await A.api('/api/admin/members/' + member.id, { method: 'PATCH', body: { role: newRole, is_active: newActive } });
        await loadMembers(); await loadAudit(); message(`${member.displayName} 님의 계정 정보를 변경했어요.`);
      }));
      row.append(identity, joined, roleCell, activeCell, action); $('members-list').append(row);
    }
    $('members-prev').disabled = membersPage <= 1;
    $('members-next').disabled = membersPage * data.pageSize >= data.total;
    $('members-page').textContent = `${membersPage} / ${Math.max(1, Math.ceil(data.total / data.pageSize))}`;
  }

  async function loadAudit() {
    const data = await A.api('/api/admin/audit'); $('audit-list').replaceChildren();
    if (!data.items.length) $('audit-list').append(A.node('li', '아직 변경 기록이 없어요.'));
    for (const item of data.items) {
      const value = item.action === 'role' ? `${roleNames[item.old_value]} → ${roleNames[item.new_value]}` : `${item.old_value === '1' ? '정상' : '정지'} → ${item.new_value === '1' ? '정상' : '정지'}`;
      const entry = A.node('li'); entry.append(A.node('span', `${item.actor} · ${item.target}`), A.node('strong', value), A.node('time', date(item.created_at, true))); $('audit-list').append(entry);
    }
  }

  async function admin() {
    if (!A.state.user.isAdmin) { location.assign('/mypage'); return; }
    form('member-search', async () => { membersQuery = $('member-query').value; membersPage = 1; await loadMembers(); });
    $('members-prev').addEventListener('click', () => run(null, async () => { membersPage--; await loadMembers(); }));
    $('members-next').addEventListener('click', () => run(null, async () => { membersPage++; await loadMembers(); }));
    await Promise.all([loadMembers(), loadAudit()]);
  }

  if (page === 'auth') authScreen();
  else A.ready.then(async () => {
    if (A.state.error) { message(A.state.error.message, true); return; }
    if (!A.state.user) { location.assign(A.loginUrl()); return; }
    await run(null, page === 'admin' ? admin : mypage);
  });
})();
