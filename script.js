let songs = [];
let songsLoaded = false;

const moodNames = {
  tired: "지친", calm: "평온한", blue: "울적한",
  excited: "신나는", frustrated: "답답한", focused: "집중하고 싶은"
};

const weatherNames = {
  clear: "맑은", cloudy: "흐린", rain: "비 오는", snow: "눈 오는"
};

let selectedMood = "";
let currentWeather = "cloudy";

const weatherStatus = document.querySelector("#weather-status");
const weatherDetail = document.querySelector("#weather-detail");
const weatherIcon = document.querySelector("#weather-icon");
const recommendButton = document.querySelector("#recommend-button");
const selectionMessage = document.querySelector("#selection-message");
const resultSection = document.querySelector("#result-section");

async function loadSongs() {
  try {
    const response = await fetch("http://localhost:8000/api/songs");
    if (!response.ok) throw new Error("곡 데이터를 불러오지 못했습니다.");

    songs = await response.json();
    songsLoaded = true;
    recommendButton.disabled = false;
    selectionMessage.textContent = "기분을 고르지 않으면 세 곡을 무작위로 추천해요.";
  } catch (error) {
    songsLoaded = false;
    recommendButton.disabled = true;
    selectionMessage.textContent = "곡 데이터를 불러오지 못했어요. 잠시 후 새로고침해주세요.";
    console.error(error);
  }
}

document.querySelectorAll(".mood-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".mood-button").forEach((item) => item.classList.remove("selected"));
    button.classList.add("selected");
    selectedMood = button.dataset.mood;
    recommendButton.disabled = !songsLoaded;
    selectionMessage.textContent = songsLoaded
      ? `${button.textContent}을 선택했어요.`
      : "곡 데이터를 불러오는 중이에요.";
  });
});

document.querySelector("#location-button").addEventListener("click", loadWeather);
recommendButton.addEventListener("click", showRecommendations);

function weatherGroup(code) {
  if (code === 0 || code === 1) return "clear";
  if (code === 2 || code === 3 || code === 45 || code === 48) return "cloudy";
  if (code >= 71 && code <= 77) return "snow";
  return "rain";
}

function weatherEmoji(group) {
  return { clear: "☀", cloudy: "☁", rain: "☂", snow: "❄" }[group];
}

async function fetchRegionName(latitude, longitude) {
  const url =
    "https://api.bigdatacloud.net/data/reverse-geocode-client" +
    `?latitude=${latitude}&longitude=${longitude}&localityLanguage=ko`;

  const response = await fetch(url);
  if (!response.ok) throw new Error("지역명을 가져오지 못했습니다.");

  const data = await response.json();
  const administrative = data.localityInfo?.administrative || [];
  const names = administrative.map((item) => item.name).filter(Boolean);

  const region = data.principalSubdivision || "";
  const city = names.find((name) =>
    name.endsWith("시") && name !== region
  ) || "";
  const district = names.find((name) =>
    name.endsWith("구") || name.endsWith("군")
  ) || "";

  const placeParts = [region];

  if (city && !region.includes(city)) {
    placeParts.push(city);
  }

  if (district && district !== city) {
    placeParts.push(district);
  }

  if (placeParts.filter(Boolean).length === 1) {
    const fallbackDistrict = data.locality || data.city || "";
    if (fallbackDistrict && !region.includes(fallbackDistrict)) {
      placeParts.push(fallbackDistrict);
    }
  }

  return placeParts.filter(Boolean).join(" ") || "현재 위치";
}

async function fetchWeather(latitude, longitude, placeName) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("날씨 정보를 가져오지 못했습니다.");
  const data = await response.json();

  if (!placeName) {
    try {
      placeName = await fetchRegionName(latitude, longitude);
    } catch (error) {
      placeName = "현재 위치";
    }
  }

  currentWeather = weatherGroup(data.current.weather_code);
  renderWeatherStatus(weatherNames[currentWeather], placeName);
  weatherDetail.textContent = `${Math.round(data.current.temperature_2m)}°C · 바람 ${Math.round(data.current.wind_speed_10m)}km/h`;
  weatherIcon.textContent = weatherEmoji(currentWeather);
}

function renderWeatherStatus(weatherName, placeName) {
  const [region = "", ...districtParts] = placeName.trim().split(/\s+/);
  const district = districtParts.join(" ");

  weatherStatus.replaceChildren();
  weatherStatus.append(`${weatherName} ${region}`.trim());

  if (district) {
    weatherStatus.append(document.createElement("br"), district);
  }
}

function loadWeather() {
  weatherStatus.textContent = "날씨를 불러오는 중";
  weatherDetail.textContent = "위치 권한을 허용하면 현재 지역을 기준으로 찾아요.";

  if (!navigator.geolocation) {
    useSeoulWeather();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    ({ coords }) => fetchWeather(coords.latitude, coords.longitude).catch(useSeoulWeather),
    useSeoulWeather,
    { timeout: 7000 }
  );
}

function useSeoulWeather() {
  fetchWeather(37.5665, 126.978, "서울특별시")
    .catch(() => {
      currentWeather = "cloudy";
      weatherStatus.textContent = "날씨 연결 실패";
      weatherDetail.textContent = "흐린 날을 기준으로 추천할게요.";
      weatherIcon.textContent = "☁";
    });
}

// 최근 추천한 30곡 기억하기
const HISTORY_KEY = "todayRockRecentSongs";
const HISTORY_LIMIT = 30;

function songKey(song) {
  return `${song.artist.trim().toLowerCase()}|${song.title.trim().toLowerCase()}`;
}

function getRecentSongs() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveRecentSongs(picked) {
  const recent = getRecentSongs();

  picked.forEach(song => {
    const key = songKey(song);
    const index = recent.indexOf(key);

    if (index !== -1) recent.splice(index, 1);
    recent.push(key);
  });

  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(recent.slice(-HISTORY_LIMIT))
  );
}

// 기분과 날씨를 모두 만족하는 곡을 우선 추천
function recommendSongs() {
  const recent = new Set(getRecentSongs());

  // 기분을 선택하지 않았다면 전체 곡에서 추천
  if (!selectedMood) {
    const fresh = songs.filter(song => !recent.has(songKey(song)));
    const picked = pickRandomSongs(
      fresh.length >= 3 ? fresh : songs,
      3
    );
    saveRecentSongs(picked);
    return picked;
  }

  // 1순위: 기분 + 날씨 모두 일치
  const exactMatches = songs.filter(song =>
    song.moods.includes(selectedMood) &&
    song.weathers.includes(currentWeather)
  );

  // 2순위: 기분만 일치
  const moodMatches = songs.filter(song =>
    song.moods.includes(selectedMood)
  );

  // 중복 없이 후보를 순서대로 구성
  const candidates = [
    ...exactMatches,
    ...moodMatches.filter(song => !exactMatches.includes(song))
  ];

  // 최근 추천곡 제외
  const freshCandidates = candidates.filter(
    song => !recent.has(songKey(song))
  );

  // 기분 + 날씨 일치 후보를 우선 무작위 추출
  const freshExact = freshCandidates.filter(song =>
    exactMatches.includes(song)
  );

  let picked = pickRandomSongs(freshExact, 3);

  // 3곡이 부족하면 기분만 일치하는 곡으로 보충
  if (picked.length < 3) {
    const remaining = freshCandidates.filter(
      song => !picked.includes(song)
    );

    picked.push(
      ...pickRandomSongs(remaining, 3 - picked.length)
    );
  }

  // 최근 추천곡 제외로 3곡이 안 되면 이전 곡도 허용
  if (picked.length < 3) {
    const remaining = candidates.filter(
      song => !picked.includes(song)
    );

    picked.push(
      ...pickRandomSongs(remaining, 3 - picked.length)
    );
  }

  // 기분에 해당하는 곡 자체가 부족할 때 최종 보충
  if (picked.length < 3) {
    const remaining = songs.filter(
      song => !picked.includes(song)
    );

    picked.push(
      ...pickRandomSongs(remaining, 3 - picked.length)
    );
  }

  saveRecentSongs(picked);
  return picked;
}

function pickRandomSongs(songList, count) {
  const shuffled = [...songList];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
  }

  return shuffled.slice(0, count);
}

function showRecommendations() {
  if (!songsLoaded || songs.length === 0) return;

  const picked = recommendSongs();
  const list = document.querySelector("#song-list");
  list.innerHTML = "";

  picked.forEach((song, index) => {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(song.artist + " " + song.title)}`;
    const lyricsUrl = song.lyricsUrl;
    list.insertAdjacentHTML("beforeend", `
      <article class="song-card">
        <span class="song-number">0${index + 1}</span>
        <p class="song-meta">${song.year} · ${song.genre} · ENERGY ${song.energy}/5</p>
        <h3>${song.title}</h3>
        <p class="song-artist">${song.artist}</p>
        <dl class="song-analysis">
          <div><dt>곡의 주제</dt><dd>${song.theme}</dd></div>
          <div><dt>정서·분위기</dt><dd>${song.tone}</dd></div>
          <div><dt>추천 이유</dt><dd>${song.reason}</dd></div>
        </dl>
        <div class="song-links">
          <a class="listen-link" href="${searchUrl}" target="_blank" rel="noopener">YouTube ↗</a>
          <a class="lyrics-link" href="${lyricsUrl}" target="_blank" rel="noopener">가사 보기 ↗</a>
        </div>
      </article>
    `);
  });

  const top = picked[0];
  const topSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(top.artist + " " + top.title)}`;
  document.querySelector("#result-summary").textContent =
    selectedMood
      ? `${weatherNames[currentWeather]} 날씨와 ${moodNames[selectedMood]} 마음을 함께 고려했어요.`
      : `오늘은 기분 선택 없이 ${songs.length}곡 가운데 세 곡을 무작위로 골랐어요.`;
  document.querySelector("#pick-card").innerHTML = `
    <a class="pick-card-link" href="${topSearchUrl}" target="_blank" rel="noopener" aria-label="오늘의 원픽을 YouTube에서 듣기"></a>
    <div><p class="section-label">TODAY'S ONE PICK</p></div>
    <div>
      <h3>${top.title}</h3>
      <p><strong>${top.artist}</strong></p>
      <p>${selectedMood ? `${top.reason} 오늘의 첫 곡으로 가장 잘 어울립니다.` : "무작위로 만난 오늘의 첫 곡입니다."}</p>
    </div>
  `;
  resultSection.hidden = false;
 // resultSection.scrollIntoView({ behavior: "smooth", block: "start" }); - 자동스크롤 제거
}

// --------------------------------------------------
// NME 최신 뉴스 불러오기
// --------------------------------------------------
// 브라우저가 NME RSS에 직접 접근하면 CORS 문제가 발생한다.
// 그래서 브라우저는 우리가 만든 Node.js 서버에 요청하고,
// Node.js 서버가 NME RSS를 대신 가져와 JSON으로 변환해준다.
//
// 데이터 흐름:
// NME RSS(XML)
// → Node.js server.js
// → JSON
// → fetch()
// → TODAY'S ROCK 화면
async function loadNews() {
  const newsList = document.querySelector("#news-list");

  try {
    // 우리가 만든 Node.js API에 GET 요청을 보낸다.
    const response = await fetch("http://localhost:8000/api/news");

    // 서버에서 오류 응답이 왔다면 catch로 이동한다.
    if (!response.ok) {
      throw new Error("뉴스 데이터를 불러오지 못했습니다.");
    }

    // server.js가 JSON으로 보내주기 때문에
    // response.json()으로 JavaScript 데이터로 변환한다.
    const newsItems = await response.json();

    // '불러오는 중...' 문구를 제거한다.
    newsList.innerHTML = "";

    // 받아온 기사 배열을 하나씩 반복하면서 화면에 출력한다.
    newsItems.forEach((article, index) => {

      // RSS의 긴 날짜를 한국 화면에서 읽기 쉽게 바꾼다.
      const date = new Date(article.pubDate);

      const formattedDate = date.toLocaleDateString("ko-KR", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });

      // 첫 번째 기사는 LATEST,
      // 나머지는 NEWS 02, NEWS 03으로 표시한다.
      const label =
        index === 0
          ? "LATEST"
          : `NEWS 0${index + 1}`;

      // insertAdjacentHTML을 이용해
      // 실제 NME 기사 하나를 HTML article로 추가한다.
      newsList.insertAdjacentHTML(
        "beforeend",
        `
          <article class="news-item ${index === 0 ? "lead-news" : ""}">
            <p class="news-date">${label} · ${formattedDate}</p>

            <h3>
              <a
                href="${article.link}"
                target="_blank"
                rel="noopener"
              >
                ${article.title}
              </a>
            </h3>

            ${index === 0
          ? `<p>${article.description}</p>`
          : ""
        }

            <a
              class="news-link"
              href="${article.link}"
              target="_blank"
              rel="noopener"
            >
              NME 원문 보기 ↗
            </a>
          </article>
        `
      );
    });

  } catch (error) {
    console.error(error);

    // Node 서버가 꺼져 있거나 RSS 요청에 실패해도
    // 화면 전체가 망가지지 않고 뉴스 영역에만 오류를 표시한다.
    newsList.innerHTML = `
      <p class="news-loading">
        뉴스를 불러오지 못했습니다.
      </p>
    `;
  }
}

loadWeather();
loadSongs();
loadNews();

// ARTIST ARCHIVE — 지난 기사는 별도 페이지에서 열람
const archiveBar = document.querySelector("#artist-archive");
const archiveList = document.querySelector("#artist-archive-list");
const returnButton = document.querySelector("#artist-archive-return");
const artistArchive = [
  { nameOriginal: "Jack White", nameKo: "잭 화이트", url: "artist-jack-white.html" }
];
archiveList.replaceChildren();
artistArchive.forEach((artist, index) => {
  if (index) {
    const separator = document.createElement("span");
    separator.className = "artist-archive-separator";
    separator.textContent = "/";
    archiveList.appendChild(separator);
  }
  const link = document.createElement("a");
  link.className = "artist-archive-item";
  link.href = artist.url;
  link.textContent = artist.nameKo
    ? `${artist.nameOriginal} (${artist.nameKo})` : artist.nameOriginal;
  archiveList.appendChild(link);
});
archiveBar.hidden = artistArchive.length === 0;
returnButton.hidden = true;
