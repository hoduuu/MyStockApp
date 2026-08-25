// 기상청_지진정보 조회서비스(공공데이터포털)를 호출해 국내 지진 목록을 가져오고,
// 위치를 표시한 정적 지도 HTML(map.html)을 생성한다.
//
// 사용법:
//   KMA_SERVICE_KEY=발급받은키 node earthquake-map/fetch-quakes.mjs [일수]
//
// 서비스키는 공공데이터포털(data.go.kr)에서 "기상청_지진정보 조회서비스"를
// 신청하면 발급된다 (승인까지 시간이 걸릴 수 있음). "Decoding" 키를 사용할 것.
//
// 주의: 이 API의 공식 응답 필드 문서를 이 환경의 네트워크 정책(egress 차단)으로
// 확인하지 못했다. 아래 FIELD_CANDIDATES는 데이터고 API 공통 스펙과 관련 자료를
// 바탕으로 한 추정치이며, 실제 응답 필드명이 다르면 콘솔 경고에 찍히는 원본 item을
// 보고 이 배열을 수정하면 된다.

const SERVICE_KEY = process.env.KMA_SERVICE_KEY;
const DAYS = Number(process.argv[2] ?? 30);

if (!SERVICE_KEY) {
  console.error("환경변수 KMA_SERVICE_KEY가 필요합니다. (data.go.kr에서 발급받은 Decoding 키)");
  process.exit(1);
}

const FIELD_CANDIDATES = {
  lat: ["lat", "latitude", "Lat"],
  lon: ["lon", "lng", "longitude", "Lon"],
  mag: ["mt", "magnitude", "mag"],
  loc: ["loc", "location", "area"],
  time: ["tmEqk", "tmFc", "time"],
  rem: ["rem", "msg", "content"],
};

function pick(item, candidates) {
  for (const key of candidates) {
    if (item[key] !== undefined && item[key] !== "") return item[key];
  }
  return undefined;
}

function toYmd(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchQuakes() {
  const today = new Date();
  const from = new Date(today.getTime() - DAYS * 24 * 60 * 60 * 1000);

  const url = new URL("https://apis.data.go.kr/1360000/EqkInfoService/getEqkMsg");
  url.searchParams.set("serviceKey", SERVICE_KEY);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "100");
  url.searchParams.set("dataType", "JSON");
  url.searchParams.set("fromTmFc", toYmd(from));
  url.searchParams.set("toTmFc", toYmd(today));

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API 호출 실패: HTTP ${res.status}`);
  }

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      "JSON 파싱 실패 — API가 XML을 반환했을 수 있습니다. 원본 응답:\n" + text.slice(0, 1000)
    );
  }

  const header = parsed?.response?.header;
  if (header && header.resultCode !== "00") {
    throw new Error(`API 오류: ${header.resultCode} ${header.resultMsg}`);
  }

  const items = parsed?.response?.body?.items?.item ?? [];
  const list = Array.isArray(items) ? items : [items];

  const quakes = [];
  for (const item of list) {
    const lat = Number(pick(item, FIELD_CANDIDATES.lat));
    const lon = Number(pick(item, FIELD_CANDIDATES.lon));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      console.warn("위도/경도를 찾지 못해 건너뜀. 원본 item:", JSON.stringify(item));
      continue;
    }
    quakes.push({
      lat,
      lon,
      mag: Number(pick(item, FIELD_CANDIDATES.mag)) || null,
      loc: pick(item, FIELD_CANDIDATES.loc) ?? "",
      time: pick(item, FIELD_CANDIDATES.time) ?? "",
      rem: pick(item, FIELD_CANDIDATES.rem) ?? "",
    });
  }

  return quakes;
}

function renderHtml(quakes) {
  const dataJson = JSON.stringify(quakes);
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>대한민국 지진 지도 (프로토타입)</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html, body, #map { height: 100%; margin: 0; }
  .info { position: absolute; top: 10px; left: 50px; z-index: 1000; background: white; padding: 8px 12px; border-radius: 6px; font-family: sans-serif; box-shadow: 0 1px 4px rgba(0,0,0,0.3); }
</style>
</head>
<body>
<div id="map"></div>
<div class="info">최근 지진 ${quakes.length}건 (기상청 지진정보 조회서비스)</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  const QUAKES = ${dataJson};
  const map = L.map('map').setView([36.5, 127.8], 7);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  for (const q of QUAKES) {
    const mag = q.mag ?? 0;
    const radius = Math.max(4, mag * 4);
    const color = mag >= 4 ? '#d62728' : mag >= 2 ? '#ff7f0e' : '#1f77b4';
    L.circleMarker([q.lat, q.lon], { radius, color, fillOpacity: 0.6 })
      .addTo(map)
      .bindPopup(\`<b>\${q.loc || '위치 정보 없음'}</b><br>규모: \${q.mag ?? '?'}<br>\${q.time}<br>\${q.rem}\`);
  }
</script>
</body>
</html>
`;
}

const quakes = await fetchQuakes();
console.log(`${quakes.length}건의 지진 데이터를 가져왔습니다.`);

const { writeFileSync } = await import("node:fs");
const outPath = new URL("./map.html", import.meta.url);
writeFileSync(outPath, renderHtml(quakes));
console.log(`지도 생성 완료: ${outPath.pathname} 를 브라우저로 여세요.`);
