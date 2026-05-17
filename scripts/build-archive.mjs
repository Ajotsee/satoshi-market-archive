import { access, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("https://satoshimarket.biz/ecommerce/");
const API = new URL("wp-json/wp/v2/", ROOT);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(SCRIPT_DIR, "..");
const OUT = path.join(SITE_ROOT, "ecommerce");
const ASSETS = path.join(OUT, "assets");
const MISSING_IMAGE = "assets/missing.svg";
const GENERATED_AT = new Date().toISOString().slice(0, 10);

const money = new Intl.NumberFormat("ko-KR");

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "Satoshi Market static archive builder",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

async function fetchAll(type) {
  const items = [];
  for (let page = 1; page < 20; page += 1) {
    const url = new URL(type, API);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    url.searchParams.set("_embed", "1");
    const res = await fetch(url, {
      headers: { "user-agent": "Satoshi Market static archive builder" },
    });
    if (res.status === 400) break;
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
    const batch = await res.json();
    items.push(...batch);
    const totalPages = Number(res.headers.get("x-wp-totalpages") || "1");
    if (page >= totalPages || batch.length === 0) break;
  }
  return items;
}

function decodeHtml(value = "") {
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripTags(html = "") {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function cleanWpHtml(html = "") {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "<p class=\"archive-note\">외부 임베드는 정적 아카이브에서 비활성화되었습니다.</p>")
    .replace(/<form[\s\S]*?<\/form>/gi, "<p class=\"archive-note\">원본 주문/입력 양식은 운영 종료로 보존하지 않았습니다.</p>")
    .replace(/\sdata-[a-z0-9_-]+=(["']).*?\1/gi, "")
    .replace(/\son[a-z]+=(["']).*?\1/gi, "")
    .replace(/<a\s/gi, "<a target=\"_blank\" rel=\"noopener\" ")
    .replace(/<(button|input|select|textarea)[\s\S]*?>[\s\S]*?<\/\1>/gi, "");
}

function localFileName(url) {
  const parsed = new URL(url);
  const rawName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "asset");
  const cleanName = rawName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const ext = path.extname(cleanName) || ".jpg";
  const base = path.basename(cleanName, ext).slice(0, 60) || "asset";
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 10);
  return `${base}-${hash}${ext}`;
}

function optimizedImageUrl(url) {
  const parsed = new URL(url);
  if (!parsed.hostname.endsWith("wp.com")) return url;
  if (!parsed.searchParams.has("resize") && !parsed.searchParams.has("w") && !parsed.searchParams.has("fit")) {
    parsed.searchParams.set("resize", "1400,1400");
  }
  parsed.searchParams.set("ssl", "1");
  return parsed.href;
}

function imageUrlsFromHtml(html = "") {
  const urls = new Set();
  for (const match of html.matchAll(/<img[^>]+(?:src|data-orig-file|data-large-file)=["']([^"']+)["']/gi)) {
    urls.add(decodeHtml(match[1]).replace(/&#038;/g, "&"));
  }
  for (const match of html.matchAll(/https?:\/\/i\d\.wp\.com\/[^"'\s<>]+/gi)) {
    urls.add(decodeHtml(match[0]).replace(/&#038;/g, "&"));
  }
  return [...urls].filter((url) => /\.(png|jpe?g|webp|gif|heic)(\?|$)/i.test(url));
}

async function downloadImage(url, imageMap) {
  if (imageMap.has(url)) return imageMap.get(url);
  const fileName = localFileName(url);
  const rel = `assets/${fileName}`;
  try {
    await access(path.join(ASSETS, fileName));
    imageMap.set(url, rel);
    return rel;
  } catch {
    // Download below when the file is not already present from a prior run.
  }
  try {
    const res = await fetch(optimizedImageUrl(url), {
      headers: { "user-agent": "Satoshi Market static archive builder" },
      signal: AbortSignal.timeout(4500),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile(path.join(ASSETS, fileName), bytes);
    imageMap.set(url, rel);
    return rel;
  } catch (error) {
    console.warn(`Image skipped: ${url} (${error.message})`);
    imageMap.set(url, MISSING_IMAGE);
    return MISSING_IMAGE;
  }
}

async function localizeImages(html, imageMap) {
  let result = html;
  for (const url of imageUrlsFromHtml(html)) {
    const local = await downloadImage(url, imageMap);
    result = result.split(url).join(local);
    result = result.split(url.replace(/&/g, "&#038;")).join(local);
    result = result.split(url.replace(/&/g, "&amp;")).join(local);
    result = result.replace(/srcset=(["'])[^"']+\1/gi, "");
  }
  return result;
}

function featuredImage(item) {
  return item?._embedded?.["wp:featuredmedia"]?.[0]?.source_url || "";
}

function stat(label, value) {
  return `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function card(item, type) {
  const title = decodeHtml(item.title.rendered);
  const excerpt = stripTags(item.excerpt?.rendered || item.content?.rendered || "").slice(0, 160);
  const img = item.archiveImage || "";
  return `<article class="card ${type}">
    ${img ? `<img src="${img}" alt="">` : `<div class="image-fallback">Sats</div>`}
    <div class="card-body">
      <p class="eyebrow">${type === "product" ? "전시 상품" : "기록 페이지"}</p>
      <h3>${title}</h3>
      <p>${excerpt}</p>
      <a href="#${type}-${item.id}" class="text-link">기록 보기</a>
    </div>
  </article>`;
}

function detail(item, type) {
  const title = decodeHtml(item.title.rendered);
  const content = item.archiveContent || "";
  return `<section class="record" id="${type}-${item.id}">
    <div class="record-heading">
      <p class="eyebrow">${type === "product" ? "Product Archive" : "Page Archive"}</p>
      <h2>${title}</h2>
      <a href="${item.link}" target="_blank" rel="noopener">원본 URL</a>
    </div>
    <div class="wp-content">${content}</div>
  </section>`;
}

function renderHtml({ pages, products }) {
  const history = pages.find((page) => stripTags(page.title.rendered).includes("일지"));
  const firstImage = products.find((item) => item.archiveImage)?.archiveImage || pages.find((item) => item.archiveImage)?.archiveImage || "";
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Satoshi Market Archive</title>
  <meta name="description" content="사토시마켓의 정적 박물관 아카이브">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="site-header">
    <a class="brand" href="#">Satoshi Market Archive</a>
    <nav aria-label="archive navigation">
      <a href="#collection">컬렉션</a>
      <a href="#records">기록</a>
      <a href="#preservation">보존 방식</a>
    </nav>
  </header>

  <main>
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Static Museum · ${GENERATED_AT}</p>
        <h1>Satoshi Market</h1>
        <p>한국에서도 비트코인 스탠다드를 경험하려 했던 작은 시장의 흔적을 정적 웹사이트로 보존합니다. 이곳의 상품, 페이지, 운영 기록은 판매가 아닌 관람을 위해 남겨졌습니다.</p>
        <div class="hero-actions">
          <a href="#collection" class="button primary">전시 보기</a>
          ${history ? `<a href="#page-${history.id}" class="button secondary">운영 일지</a>` : ""}
        </div>
      </div>
      <div class="artifact-panel" aria-label="archive artifact">
        ${firstImage ? `<img src="${firstImage}" alt="">` : ""}
        <div>
          <span>Archived from</span>
          <strong>satoshimarket.biz/ecommerce</strong>
        </div>
      </div>
    </section>

    <section class="notice">
      <strong>운영 종료 아카이브</strong>
      <p>이 사이트는 결제, 장바구니, 회원가입, 주문 접수를 제공하지 않습니다. 원본 쇼핑몰의 내용은 역사적 기록으로만 전시됩니다.</p>
    </section>

    <section class="stats" aria-label="archive stats">
      ${stat("상품 기록", money.format(products.length))}
      ${stat("페이지 기록", money.format(pages.length))}
      ${stat("호스팅 방식", "정적 파일")}
      ${stat("서버/DB", "불필요")}
    </section>

    <section class="section" id="collection">
      <div class="section-heading">
        <p class="eyebrow">Collection</p>
        <h2>상품 카탈로그</h2>
      </div>
      <div class="grid">
        ${products.map((item) => card(item, "product")).join("\n")}
      </div>
    </section>

    <section class="section">
      <div class="section-heading">
        <p class="eyebrow">Pages</p>
        <h2>사이트 페이지</h2>
      </div>
      <div class="grid compact">
        ${pages.map((item) => card(item, "page")).join("\n")}
      </div>
    </section>

    <section class="section records" id="records">
      <div class="section-heading">
        <p class="eyebrow">Records</p>
        <h2>보존된 본문</h2>
      </div>
      ${pages.map((item) => detail(item, "page")).join("\n")}
      ${products.map((item) => detail(item, "product")).join("\n")}
    </section>

    <section class="preservation" id="preservation">
      <p class="eyebrow">Preservation Notes</p>
      <h2>운영비를 거의 없애는 보존 방식</h2>
      <p>이 결과물은 HTML, CSS, 이미지 파일만으로 동작합니다. Cloudflare Pages, GitHub Pages, Netlify 같은 무료 정적 호스팅에 올리면 서버, 데이터베이스, WooCommerce 업데이트 없이 보존할 수 있습니다.</p>
    </section>
  </main>

  <footer>
    <span>© Satoshi Market Archive</span>
    <span>Generated ${GENERATED_AT}</span>
  </footer>
</body>
</html>`;
}

const css = `:root {
  --ink: #191613;
  --muted: #6d6358;
  --paper: #f8f4ec;
  --panel: #fffaf1;
  --line: #d8cdbb;
  --orange: #f7931a;
  --green: #2f6b4f;
  --blue: #1c5267;
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--ink);
  background: var(--paper);
  line-height: 1.6;
}

a { color: inherit; }
img { max-width: 100%; display: block; }

.site-header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
  padding: 16px clamp(18px, 4vw, 52px);
  background: rgba(248, 244, 236, 0.92);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(14px);
}

.brand {
  font-weight: 800;
  text-decoration: none;
}

nav {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  color: var(--muted);
  font-size: 14px;
}

nav a { text-decoration: none; }

main { overflow: hidden; }

.hero {
  min-height: 86vh;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 460px);
  align-items: center;
  gap: clamp(28px, 6vw, 72px);
  padding: clamp(56px, 8vw, 112px) clamp(18px, 4vw, 52px) 48px;
  border-bottom: 1px solid var(--line);
}

.hero-copy {
  max-width: 780px;
}

.eyebrow {
  margin: 0 0 12px;
  color: var(--green);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1, h2, h3, p { margin-top: 0; }
h1 {
  margin-bottom: 18px;
  font-size: clamp(56px, 11vw, 132px);
  line-height: 0.9;
  letter-spacing: 0;
}

h2 {
  font-size: clamp(28px, 5vw, 56px);
  line-height: 1.05;
  letter-spacing: 0;
}

h3 {
  font-size: 20px;
  line-height: 1.25;
  letter-spacing: 0;
}

.hero-copy > p:not(.eyebrow) {
  max-width: 680px;
  color: #403931;
  font-size: clamp(17px, 2vw, 22px);
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 28px;
}

.button {
  min-height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px 18px;
  border: 1px solid var(--ink);
  border-radius: 8px;
  font-weight: 800;
  text-decoration: none;
}

.button.primary {
  background: var(--ink);
  color: white;
}

.button.secondary {
  background: transparent;
}

.artifact-panel {
  border: 1px solid var(--line);
  background: var(--panel);
  box-shadow: 0 24px 80px rgba(25, 22, 19, 0.12);
}

.artifact-panel img {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  border-bottom: 1px solid var(--line);
}

.artifact-panel div {
  padding: 18px;
}

.artifact-panel span,
.stat span,
footer {
  color: var(--muted);
  font-size: 13px;
}

.artifact-panel strong {
  display: block;
  overflow-wrap: anywhere;
}

.notice,
.stats,
.section,
.preservation {
  padding-inline: clamp(18px, 4vw, 52px);
}

.notice {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 20px;
  padding-block: 22px;
  background: #221b14;
  color: white;
}

.notice p {
  margin: 0;
  color: #f2dfc7;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border-bottom: 1px solid var(--line);
}

.stat {
  padding: 22px 18px;
  border-right: 1px solid var(--line);
}

.stat:last-child { border-right: 0; }
.stat strong {
  display: block;
  margin-top: 4px;
  font-size: 26px;
}

.section {
  padding-block: clamp(54px, 8vw, 92px);
  border-bottom: 1px solid var(--line);
}

.section-heading {
  max-width: 760px;
  margin-bottom: 28px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

.grid.compact {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.card {
  min-width: 0;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}

.card img,
.image-fallback {
  width: 100%;
  aspect-ratio: 4 / 3;
  object-fit: cover;
  background: #28231d;
}

.image-fallback {
  display: grid;
  place-items: center;
  color: var(--orange);
  font-size: 42px;
  font-weight: 900;
}

.card-body {
  padding: 18px;
}

.card-body p:not(.eyebrow) {
  color: var(--muted);
}

.text-link {
  font-weight: 800;
  color: var(--blue);
  text-decoration-thickness: 2px;
  text-underline-offset: 4px;
}

.records {
  background: #fffdf8;
}

.record {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 32px;
  padding: 34px 0;
  border-top: 1px solid var(--line);
}

.record-heading {
  position: sticky;
  top: 86px;
  align-self: start;
}

.record-heading h2 {
  font-size: 28px;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.record-heading a {
  color: var(--blue);
  overflow-wrap: anywhere;
}

.wp-content {
  min-width: 0;
  overflow-wrap: anywhere;
}

.wp-content img {
  height: auto;
  margin: 14px auto;
  border: 1px solid var(--line);
  border-radius: 8px;
}

.wp-content table {
  width: 100%;
  border-collapse: collapse;
  display: block;
  overflow-x: auto;
}

.wp-content td,
.wp-content th {
  border: 1px solid var(--line);
  padding: 10px;
}

.wp-content .archive-note {
  padding: 12px 14px;
  border-left: 4px solid var(--orange);
  background: #fff3dd;
}

.wp-content .wp-block-button__link,
.wp-content .button,
.wp-content a[href*="add-to-cart"],
.wp-content a[href*="?product="] {
  pointer-events: none;
  opacity: 0.68;
  cursor: default;
}

.wp-content .wp-block-button__link::after,
.wp-content .button::after {
  content: " / 운영 종료";
}

.preservation {
  max-width: 960px;
  padding-block: clamp(54px, 8vw, 92px);
}

footer {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 24px clamp(18px, 4vw, 52px);
  border-top: 1px solid var(--line);
}

@media (max-width: 900px) {
  .hero,
  .record,
  .notice {
    grid-template-columns: 1fr;
  }
  .grid,
  .grid.compact,
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .record-heading {
    position: static;
  }
}

@media (max-width: 620px) {
  .site-header {
    align-items: flex-start;
    flex-direction: column;
  }
  .hero {
    min-height: auto;
  }
  .grid,
  .grid.compact,
  .stats {
    grid-template-columns: 1fr;
  }
  .stat {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  footer {
    flex-direction: column;
  }
}`;

await mkdir(ASSETS, { recursive: true });
await writeFile(path.join(ASSETS, "missing.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900" viewBox="0 0 1200 900"><rect width="1200" height="900" fill="#28231d"/><rect x="64" y="64" width="1072" height="772" fill="none" stroke="#d8cdbb" stroke-width="4"/><text x="600" y="430" text-anchor="middle" fill="#f7931a" font-size="72" font-family="Arial, sans-serif" font-weight="700">Satoshi Market</text><text x="600" y="520" text-anchor="middle" fill="#f8f4ec" font-size="34" font-family="Arial, sans-serif">Archived image unavailable</text></svg>`);

console.log("Fetching WordPress pages and products...");
const [pagesRaw, productsRaw] = await Promise.all([fetchAll("pages"), fetchAll("product")]);
const mediaById = new Map();
for (const item of [...pagesRaw, ...productsRaw]) {
  const media = item?._embedded?.["wp:featuredmedia"]?.[0];
  if (media) mediaById.set(media.id, media);
}

const imageMap = new Map();
const pages = [];
const products = [];

for (const item of pagesRaw.sort((a, b) => a.menu_order - b.menu_order || a.id - b.id)) {
  const rawContent = cleanWpHtml(item.content?.rendered || "");
  const archiveContent = await localizeImages(rawContent, imageMap);
  const image = featuredImage(item) || imageUrlsFromHtml(item.content?.rendered || "")[0] || "";
  const archiveImage = image ? await downloadImage(image, imageMap) : "";
  pages.push({ ...item, archiveContent, archiveImage });
}

for (const item of productsRaw.sort((a, b) => new Date(b.date) - new Date(a.date))) {
  const rawContent = cleanWpHtml(`${item.excerpt?.rendered || ""}${item.content?.rendered || ""}`);
  const archiveContent = await localizeImages(rawContent, imageMap);
  const image = featuredImage(item) || imageUrlsFromHtml(`${item.excerpt?.rendered || ""}${item.content?.rendered || ""}`)[0] || "";
  const archiveImage = image ? await downloadImage(image, imageMap) : "";
  products.push({ ...item, archiveContent, archiveImage });
}

const data = {
  source: ROOT.href,
  generatedAt: new Date().toISOString(),
  counts: { pages: pages.length, products: products.length, images: imageMap.size },
  pages: pages.map(({ id, date, modified, link, slug, title, excerpt, archiveImage }) => ({ id, date, modified, link, slug, title, excerpt, archiveImage })),
  products: products.map(({ id, date, modified, link, slug, title, excerpt, featured_media, archiveImage }) => ({ id, date, modified, link, slug, title, excerpt, featured_media, archiveImage })),
};

const ecommerceHtml = renderHtml({ pages, products });
const rootHtml = ecommerceHtml
  .replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="ecommerce/styles.css">')
  .replaceAll('src="assets/', 'src="ecommerce/assets/')
  .replaceAll('href="assets/', 'href="ecommerce/assets/');

await writeFile(path.join(OUT, "archive-data.json"), JSON.stringify(data, null, 2));
await writeFile(path.join(OUT, "index.html"), ecommerceHtml);
await writeFile(path.join(OUT, "styles.css"), css);
await writeFile(path.join(SITE_ROOT, "index.html"), rootHtml);

console.log(`Done: ${pages.length} pages, ${products.length} products, ${imageMap.size} images.`);
