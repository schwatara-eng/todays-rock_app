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
  function pickBestMatch(results, song) {
    const artist = normalize(song.artist);
    const title = normalize(song.title);
    const matches = results.filter((item) =>
      item.previewUrl &&
      (normalize(item.artistName).includes(artist) || artist.includes(normalize(item.artistName))) &&
      normalize(item.trackName).startsWith(title)
    );
    return matches.find((item) => !unwantedVersion.test(item.trackName.replace(song.title, ""))) || matches[0] || null;
  }

  async function lookupPreview(song) {
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

  function findPreview(song) {
    const key = song.artist + "|" + song.title;
    if (!cache.has(key)) cache.set(key, lookupPreview(song).catch(() => null));
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
  let songs = [];        // 지금 화면에 뜬 추천곡
  let current = null;    // 재생 중인 곡 번호

  const cardsFor = (index) => document.querySelectorAll(`[data-preview="${index}"]`);
  const setCardState = (index, className, on) => cardsFor(index).forEach((el) => el.classList.toggle(className, on));
  const setProgress = (index, ratio) => cardsFor(index).forEach((el) => {
    const fill = el.querySelector(".preview-progress span");
    if (fill) fill.style.width = (ratio * 100) + "%";
  });
  // 미리듣기를 못 찾은 곡: 재생 버튼을 숨기고, 원픽 카드는 예전처럼 YouTube 링크로 되돌린다.
  function markNoPreview(index) {
    cardsFor(index).forEach((el) => {
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
  function fadeTo(volume, ms = 300) {
    return new Promise((resolve) => {
      const from = audio.volume;
      const start = performance.now();
      function step(now) {
        const progress = Math.min(1, (now - start) / ms);
        audio.volume = Math.min(1, Math.max(0, from + (volume - from) * progress));
        if (progress < 1) requestAnimationFrame(step); else resolve();
      }
      requestAnimationFrame(step);
    });
  }

  function stop() {
    if (current !== null) {
      setCardState(current, "is-playing", false);
      setCardState(current, "is-loading", false);
      setProgress(current, 0);
    }
    audio.pause();
    current = null;
    bar.classList.remove("is-open");
  }

  async function toggle(index) {
    const song = songs[index];
    if (!song) return;

    // 같은 곡을 다시 누르면 일시정지 / 다시 재생
    if (current === index) {
      if (audio.paused) { audio.play(); fadeTo(1); }
      else { await fadeTo(0, 200); audio.pause(); }
      return;
    }

    stop();
    current = index;
    setCardState(index, "is-loading", true);
    const preview = await findPreview(song);
    setCardState(index, "is-loading", false);
    if (current !== index) return; // 기다리는 사이 다른 곡을 눌렀으면 무시

    if (!preview) {
      current = null;
      markNoPreview(index);
      return;
    }

    audio.src = preview.previewUrl;
    audio.volume = 0;
    try {
      await audio.play();
    } catch (error) {
      console.error(error);
      current = null;
      return;
    }
    fadeTo(1);
    barTitle.textContent = `${song.title} — ${song.artist}`;
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
    if (card) toggle(Number(card.dataset.preview));
  });

  // ---------- 4. script.js에서 부르는 함수 ----------
  window.TRPreview = {
    // 새 추천이 뜰 때마다 호출: 이전 곡을 멈추고, 새 곡들의 미리듣기를 미리 찾아 둡니다.
    prepare(pickedSongs) {
      stop();
      songs = pickedSongs;
      songs.forEach((song, index) => {
        findPreview(song).then((preview) => {
          if (songs[index] !== song) return;
          if (!preview) markNoPreview(index);
        });
      });
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
})();
