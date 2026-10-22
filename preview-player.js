// TODAY'S ROCK — 30초 미리듣기
// 추천 카드를 누르면 iTunes 미리듣기 음원을 페이지 안에서 바로 재생합니다.
// - 곡에 itunes_track_id 값이 있으면 그 ID로 정확히 찾고, 없으면 "아티스트 + 제목"으로 검색합니다.
// - 추천이 뜨는 순간 미리 찾아 두기 때문에, 클릭하면 기다림 없이 소리가 납니다.
// - 미리듣기를 찾지 못한 곡은 YouTube 링크만 남깁니다.

(function () {
  const ITUNES = "https://itunes.apple.com";
  const cache = new Map(); // "아티스트|제목" → Promise<찾은 곡 | null>

  // ---------- 1. iTunes에서 미리듣기 찾기 ----------
  // iTunes API는 다른 사이트에서 fetch로 부르기 어려워서 JSONP(script 태그) 방식을 씁니다.
  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const callbackName = "itunesPreview_" + Math.random().toString(36).slice(2);
      const script = document.createElement("script");
      const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 8000);

      function cleanup() {
        clearTimeout(timer);
        delete window[callbackName];
        script.remove();
      }

      window[callbackName] = (data) => { cleanup(); resolve(data); };
      script.onerror = () => { cleanup(); reject(new Error("network")); };
      script.src = url + "&callback=" + callbackName;
      document.head.appendChild(script);
    });
  }

  const normalize = (text) => String(text).toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
  const unwantedVersion = /live|remaster|demo|karaoke|instrumental|inst\.|\bmr\b|acoustic|remix|version|ver\./i;

  // 검색 결과 중에서 아티스트와 제목이 맞는 원곡 버전을 고릅니다.
  // 서버 main.py의 preview_best_match와 같은 규칙입니다. 한쪽을 고치면 다른 쪽도 같이 고칩니다.
  function pickBestMatch(results, song) {
    const artist = normalize(song.artist);
    const title = normalize(song.title);
    // 한글·영문·숫자가 없는 이름(예: 일본어)은 빈 값이 되어 아무 가수와나 일치하므로 제외합니다.
    const artistMatches = (name) => Boolean(artist && name && (name.includes(artist) || artist.includes(name)));
    let matches = results.filter((item) =>
      item.previewUrl &&
      artistMatches(normalize(item.artistName)) &&
      normalize(item.trackName).startsWith(title)
    );
    if (!matches.length) {
      // 가수 이름이 다른 언어로 등록된 경우(예: '자우림'이 'Jaurim'): 제목으로 고릅니다.
      // 정확히 같은 제목 → '샤이닝 (Shining)'처럼 제목이 포함된 곡 순서.
      const withPreview = results.filter((item) => item.previewUrl);
      matches = withPreview.filter((item) => normalize(item.trackName) === title);
      if (!matches.length && title) matches = withPreview.filter((item) => normalize(item.trackName).includes(title));
    }
    return matches.find((item) => !unwantedVersion.test(item.trackName.replace(song.title, ""))) || matches[0] || null;
  }

  // 1순위: 우리 서버(/api/preview)가 대신 찾기 — 아이폰에서도 안정적이고, 결과가 CDN에 저장됩니다.
  async function lookupFromServer(song) {
    // v: 검색 규칙을 바꿀 때 올려서, 브라우저에 저장된 예전 결과(특히 '못 찾음')를 쓰지 않게 합니다.
    const params = new URLSearchParams({ artist: song.artist, title: song.title, v: "5" });
    if (song.itunes_track_id) params.set("track_id", song.itunes_track_id);
    const response = await fetch("/api/preview?" + params.toString());
    if (!response.ok) throw new Error("preview api " + response.status);
    const data = await response.json();
    return data.previewUrl ? data : null;
  }

  async function lookupPreview(song) {
    try {
      return await lookupFromServer(song);
    } catch (error) {
      // 서버 조회가 실패했을 때만 브라우저가 iTunes에 직접 물어봅니다.
      return lookupDirect(song);
    }
  }

  // 2순위: 브라우저가 iTunes에 직접 묻기 (JSONP)
  async function lookupDirect(song) {
    // DB에 iTunes ID를 넣어 둔 곡은 검색 없이 정확히 가져옵니다.
    if (song.itunes_track_id) {
      for (const country of ["KR", "US"]) {
        try {
          const data = await jsonp(`${ITUNES}/lookup?id=${encodeURIComponent(song.itunes_track_id)}&country=${country}`);
          const item = (data.results || []).find((result) => result.previewUrl);
          if (item) return item;
        } catch (error) { /* 다음 국가로 */ }
      }
    }

    for (const country of ["KR", "US"]) {
      const term = encodeURIComponent(song.artist + " " + song.title);
      try {
        const data = await jsonp(`${ITUNES}/search?term=${term}&country=${country}&media=music&entity=song&limit=15`);
        const item = pickBestMatch(data.results || [], song);
        if (item) return item;
      } catch (error) { /* 다음 국가로 */ }
    }
    return null;
  }

  const resolved = new Map(); // 찾기를 마친 곡: 클릭 즉시(기다림 없이) 재생하는 데 씁니다.
  const keyOf = (song) => song.artist + "|" + song.title;

  function findPreview(song) {
    const key = keyOf(song);
    if (!cache.has(key)) {
      cache.set(key, lookupPreview(song).catch(() => null).then((preview) => {
        resolved.set(key, preview);
        return preview;
      }));
    }
    return cache.get(key);
  }

  // ---------- 2. 하단 재생바 ----------
  const audio = new Audio();
  audio.preload = "auto";

  const bar = document.createElement("div");
  bar.className = "preview-bar";
  bar.setAttribute("aria-live", "polite");
  bar.innerHTML = `
    <div class="preview-eq" aria-hidden="true"><i></i><i></i><i></i></div>
    <div class="preview-bar-text">
      <p class="preview-bar-title"></p>
      <p class="preview-bar-sub">30초 미리듣기</p>
    </div>
    <span class="preview-bar-time">0:00 / 0:30</span>
    <button class="preview-bar-toggle" type="button">일시정지</button>
  `;
  document.body.append(bar);

  const barTitle = bar.querySelector(".preview-bar-title");
  const barTime = bar.querySelector(".preview-bar-time");
  const barToggle = bar.querySelector(".preview-bar-toggle");

  // ---------- 3. 재생 상태 ----------
  // 재생할 수 있는 곡 목록. 키: 추천곡은 "0"·"1"·"2", 오늘의 뮤지션 대표곡은 "track-0"…
  const songs = {};
  let current = null;    // 재생 중인 곡의 키

  const cardsFor = (key) => document.querySelectorAll(`[data-preview="${key}"]`);
  const setCardState = (key, className, on) => cardsFor(key).forEach((el) => el.classList.toggle(className, on));
  const setProgress = (key, ratio) => cardsFor(key).forEach((el) => {
    const fill = el.querySelector(".preview-progress span");
    if (fill) fill.style.width = (ratio * 100) + "%";
  });
  // 미리듣기를 못 찾은 곡: 재생 버튼을 숨기고, 원픽 카드는 예전처럼 YouTube 링크로 되돌린다.
  function markNoPreview(key) {
    cardsFor(key).forEach((el) => {
      el.classList.add("no-preview");
      if (el.dataset.youtube && !el.querySelector(".pick-card-link")) {
        const link = document.createElement("a");
        link.className = "pick-card-link";
        link.href = el.dataset.youtube;
        link.target = "_blank";
        link.rel = "noopener";
        link.setAttribute("aria-label", "YouTube에서 듣기");
        el.prepend(link);
      }
    });
  }
  const formatTime = (seconds) => {
    const s = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // 소리가 툭 끊기지 않게 볼륨을 부드럽게 올리고 내립니다.
  // 새 페이드가 시작되면 이전 페이드는 중단합니다. 끝까지 진행했으면 true, 중단됐으면 false.
  // (아이폰은 볼륨을 코드로 바꿀 수 없어서 페이드 없이 바로 재생·정지됩니다.)
  let fadeId = 0;
  function fadeTo(volume, ms = 300) {
    const id = ++fadeId;
    return new Promise((resolve) => {
      const from = audio.volume;
      const start = performance.now();
      function step(now) {
        if (id !== fadeId) { resolve(false); return; }
        const progress = Math.min(1, (now - start) / ms);
        audio.volume = Math.min(1, Math.max(0, from + (volume - from) * progress));
        if (progress < 1) requestAnimationFrame(step); else resolve(true);
      }
      requestAnimationFrame(step);
    });
  }

  // 재생을 시작하고, 거부되면(자동재생 제한 등) 조용히 기록만 남깁니다.
  function playAudio() {
    return audio.play().then(() => { fadeTo(1); return true; }, (error) => {
      console.error(error);
      return false;
    });
  }

  function stop() {
    fadeId += 1; // 진행 중인 페이드 중단
    if (current !== null) {
      setCardState(current, "is-playing", false);
      setCardState(current, "is-loading", false);
      setProgress(current, 0);
    }
    audio.pause();
    current = null;
    bar.classList.remove("is-open");
  }

  async function toggle(key) {
    const song = songs[key];
    if (!song) return;

    // 같은 곡을 다시 누르면 일시정지 / 다시 재생
    if (current === key) {
      if (audio.paused) {
        playAudio();
      } else {
        const finished = await fadeTo(0, 200);
        // 소리를 줄이는 사이 다른 곡을 눌렀다면 그 곡을 멈추지 않는다
        if (finished && current === key) audio.pause();
      }
      return;
    }

    stop();
    current = key;
    let preview;
    if (resolved.has(keyOf(song))) {
      // 미리 찾아 둔 곡: 기다리지 않고 바로 재생해야 아이폰에서도 '누른 순간'으로 인정되어 소리가 납니다.
      preview = resolved.get(keyOf(song));
    } else {
      setCardState(key, "is-loading", true);
      preview = await findPreview(song);
      setCardState(key, "is-loading", false);
      if (current !== key) return; // 기다리는 사이 다른 곡을 눌렀으면 무시
    }

    if (!preview) {
      current = null;
      markNoPreview(key);
      return;
    }

    audio.src = preview.previewUrl;
    audio.volume = 0;
    barTitle.textContent = `${song.title} — ${song.artist}`;
    // await 전에 바로 play()를 호출해야 아이폰 자동재생 제한에 걸리지 않습니다.
    if (!(await playAudio())) {
      if (current === key) current = null;
      return;
    }
    bar.classList.add("is-open");
  }

  audio.addEventListener("play", () => {
    if (current !== null) setCardState(current, "is-playing", true);
    bar.classList.remove("is-paused");
    barToggle.textContent = "일시정지";
  });
  audio.addEventListener("pause", () => {
    if (current !== null) setCardState(current, "is-playing", false);
    bar.classList.add("is-paused");
    barToggle.textContent = "재생";
  });
  audio.addEventListener("timeupdate", () => {
    if (current === null) return;
    const duration = audio.duration || 30;
    setProgress(current, audio.currentTime / duration);
    barTime.textContent = `${formatTime(audio.currentTime)} / ${formatTime(duration)}`;
  });
  audio.addEventListener("ended", stop);
  barToggle.addEventListener("click", () => { if (current !== null) toggle(current); });

  // 카드 아무 곳이나 누르면 재생 (좋아요·YouTube·가사 버튼은 제외)
  document.addEventListener("click", (event) => {
    if (event.target.closest("a, button:not(.preview-button)")) return;
    const card = event.target.closest("[data-preview]");
    if (card) toggle(card.dataset.preview);
  });

  // 곡을 등록하고 미리듣기를 미리 찾아 둔다. 못 찾으면 그 곡의 ▶ 버튼을 숨긴다.
  function register(key, song) {
    songs[key] = song;
    findPreview(song).then((preview) => {
      if (songs[key] !== song) return;
      if (!preview) markNoPreview(key);
    });
  }

  // ---------- 4. 오늘의 뮤지션 대표곡 ----------
  // 대표곡 목록(기사 본문)에 ▶ 버튼을 붙인다. 버튼 밖을 누르면 예전처럼 YouTube로 이동한다.
  function setupArtistTracks() {
    const section = document.querySelector(".artist-feature");
    if (!section) return;
    const musician = (section.querySelector(".artist-name-sub") || section.querySelector(".artist-name-main") || {}).textContent || "";

    section.querySelectorAll(".artist-feature-tracks li").forEach((item, index) => {
      const title = (item.querySelector("strong") || {}).textContent || "";
      const artist = ((item.querySelector("small") || {}).textContent || musician).trim();
      if (!title.trim() || !artist || item.querySelector(".preview-button")) return;

      const key = "track-" + index;
      item.classList.add("artist-track");
      item.dataset.preview = key;
      item.insertAdjacentHTML("beforeend", window.TRPreview.playButtonHtml(title.trim()) + window.TRPreview.progressHtml());
      register(key, { title: title.trim(), artist });
    });
  }

  // ---------- 5. script.js에서 부르는 함수 ----------
  window.TRPreview = {
    // 새 추천이 뜰 때마다 호출: 이전 곡을 멈추고, 새 곡들의 미리듣기를 미리 찾아 둡니다.
    prepare(pickedSongs) {
      // 추천곡을 듣던 중이었다면 멈춘다 (대표곡을 듣던 중이면 그대로 둔다)
      if (current !== null && !String(current).startsWith("track-")) stop();
      Object.keys(songs).filter((key) => !key.startsWith("track-")).forEach((key) => delete songs[key]);
      pickedSongs.forEach((song, index) => register(String(index), song));
    },
    // 카드 안에 넣을 재생 버튼 + 진행 바 HTML (원픽 카드용)
    buttonHtml(label) {
      return this.playButtonHtml(label) + this.progressHtml();
    },
    // 재생 버튼만 (곡 카드에서는 좋아요 버튼 왼쪽에 넣는다)
    playButtonHtml(label) {
      label = String(label).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      return `
        <button class="preview-button" type="button" aria-label="${label} 미리듣기">
          <svg class="preview-icon-play" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2l10 6-10 6z"/></svg>
          <svg class="preview-icon-pause" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h4v12H3zM9 2h4v12H9z"/></svg>
          <i class="preview-spinner" aria-hidden="true"></i>
        </button>
      `;
    },
    // 카드 아래 진행 바
    progressHtml() {
      return `<div class="preview-progress" aria-hidden="true"><span></span></div>`;
    },
  };

  setupArtistTracks();
})();
