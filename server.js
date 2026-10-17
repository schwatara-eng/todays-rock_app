require("dotenv").config({
  path: require("path").join(__dirname, ".env")
});

const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 5
});

const http = require("http");
// NME가 보내주는 RSS(XML)를
// JavaScript 객체로 변환하기 위해 사용하는 라이브러리
const { XMLParser } = require("fast-xml-parser");

const PORT = 3000;

const server = http.createServer(async (req, res) => {
    if (req.url === "/api/songs") {
    try {
      const [rows] = await pool.query(
        "SELECT * FROM v_songs ORDER BY id"
      );

      // DB의 태그 문자열을 웹앱에서 사용하는 배열로 변환
      const songs = rows.map(({ lyrics_url, ...song }) => ({
        ...song,
        moods: song.moods ? song.moods.split(",") : [],
        weathers: song.weathers ? song.weathers.split(",") : [],
        lyricsUrl: lyrics_url
      }));

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(JSON.stringify(songs));
    } catch (error) {
      console.error("곡 조회 실패:", error.code);

      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(JSON.stringify({
        error: "MySQL에서 곡을 가져오지 못했습니다."
      }));
    }
    return;
  }

    // 기존 뉴스·번역 기능을 로컬 서버에서 실행
  if (req.url === "/api/news") {
    const newsHandler = require("./api/news");

    res.setHeader("Access-Control-Allow-Origin", "*");

    // news.js가 사용하는 응답 방식을 Node 서버에 연결
    res.status = function (code) {
      this.statusCode = code;
      return this;
    };

    res.json = function (data) {
      this.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
      );
      this.end(JSON.stringify(data));
      return this;
    };

    await newsHandler(req, res);
    return;
  }
  
  // 우리가 만들 API 주소
  if (req.url === "/api/news") {

    try {
      // NME Music News RSS
      const rssUrl = "https://www.nme.com/news/music/feed";

      // 서버가 NME에 대신 요청
      const response = await fetch(rssUrl);

      if (!response.ok) {
        throw new Error(`NME 응답 오류: ${response.status}`);
      }

// NME 서버가 보내준 RSS는 XML 형식의 문자열이다.
const rssData = await response.text();

// XML 문자열을 JavaScript 객체로 변환한다.
// 이렇게 바꾸면 item.title, item.link처럼 데이터를 꺼내기 쉬워진다.
const parser = new XMLParser();
const parsedRss = parser.parse(rssData);

// RSS 안의 실제 기사 목록(item)을 가져온다.
const items = parsedRss.rss.channel.item;

// TODAY'S ROCK 화면에서 필요한 정보만 골라 새로운 배열을 만든다.
// 전체 RSS 중 우선 최신 기사 3개만 사용한다.
// RSS 안에는 <img>, <a>, <p> 같은 HTML 태그가 포함되어 있다.
// TODAY'S ROCK 화면에는 순수한 텍스트만 필요하므로 태그를 제거한다.
function cleanHtml(text = "") {
  return String(text)
    // HTML 태그 제거
    .replace(/<[^>]*>/g, " ")

    // RSS에 자주 포함되는 HTML 특수문자를 일반 문자로 변환
    .replace(/&#8217;|&#x2019;/g, "'")
    .replace(/&#8216;|&#x2018;/g, "'")
    .replace(/&#8220;|&#x201C;/g, '"')
    .replace(/&#8221;|&#x201D;/g, '"')
    .replace(/&#038;|&amp;/g, "&")
    .replace(/&nbsp;/g, " ")

    // 태그 제거 후 생긴 불필요한 연속 공백 정리
    .replace(/\s+/g, " ")
    .trim();
}


// RSS 전체 기사 중 최신 3개만 사용한다.
// 화면에 필요한 데이터만 골라 새로운 JSON 구조를 만든다.
const news = items.slice(0, 3).map((item) => {

  // description도 HTML이 섞여 있으므로 먼저 정리한다.
  const cleanDescription = cleanHtml(item.description);

  return {
    title: cleanHtml(item.title),
    link: item.link,
    pubDate: item.pubDate,

    // 뉴스 날개단이 좁기 때문에 너무 긴 설명은 잘라서 보낸다.
    description:
      cleanDescription.length > 160
        ? cleanDescription.slice(0, 160) + "..."
        : cleanDescription
  };
});

// 이제 브라우저에 XML이 아니라 JSON을 보낸다.
res.writeHead(200, {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*"
});

res.end(JSON.stringify(news));

    } catch (error) {

      console.error(error);

      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      });

      res.end(
        JSON.stringify({
          error: "NME RSS를 가져오지 못했습니다."
        })
      );
    }

  } else {

    res.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8"
    });

    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`서버 실행: http://localhost:${PORT}`);
});