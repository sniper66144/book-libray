/* ============================================================
   我的书库 · 前端逻辑
   数据拉取 / 渲染 / 图表(SVG) / 搜索 / 自动刷新 / 标签备注
   ============================================================ */
"use strict";

/* ---------------- 工具函数 ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtSize(b) {
  if (b >= 1 << 30) return (b / (1 << 30)).toFixed(2) + " GB";
  if (b >= 1 << 20) return (b / (1 << 20)).toFixed(1) + " MB";
  if (b >= 1 << 10) return (b / (1 << 10)).toFixed(1) + " KB";
  return b + " B";
}

function fmtDate(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDateShort(ts) {
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function seriesOf(path) {
  const i = path.indexOf("/");
  return i === -1 ? "散书" : path.slice(0, i);
}

function shorten(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* 字符顺序模糊匹配：token 的每个字符按顺序出现在 text 中即可（不要求连续） */
function fuzzyMatch(token, text) {
  let i = 0;
  for (const ch of token) {
    const idx = text.indexOf(ch, i);
    if (idx === -1) return false;
    i = idx + 1;
  }
  return true;
}

/* 某本书对一组关键词的总匹配得分；任一关键词完全未命中则返回 0（整体不通过） */
function searchScore(book, tokens) {
  let score = 0;
  for (const t of tokens) {
    const title = book.title.toLowerCase();
    const name = book.name.toLowerCase();
    const series = book.series.toLowerCase();
    const tags = ((state.data.notes[book.path] || {}).tags || []).map((x) => x.toLowerCase());
    let ts = 0;
    if (title.includes(t) || name.includes(t)) ts += 3;   // 书名直接命中（最高优先）
    if (series.includes(t)) ts += 2;                      // 系列名命中
    if (tags.some((tag) => tag.includes(t))) ts += 2;     // 标签命中
    if ([title, series].some((h) => fuzzyMatch(t, h))) ts += 1;  // 字符顺序模糊命中
    if (ts === 0) return 0;
    score += ts;
  }
  return score;
}

/* 标题高亮：仅对直接子串命中做单次替换（基于已转义文本，避免嵌套） */
function highlight(text, tokens) {
  const escText = esc(text);
  if (!tokens.length) return escText;
  const re = new RegExp(tokens.map(escapeRegex).join("|"), "gi");
  return escText.replace(re, (m) => "<mark>" + m + "</mark>");
}

/* 按匹配得分排序的搜索结果列表（含得分），搜索时忽略列排序 */
function searchRanked(list, tokens) {
  return list
    .map((b) => ({ b, sc: searchScore(b, tokens) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc || a.b.title.localeCompare(b.b.title, "zh"));
}

/* 收集系列树中全部目录节点（含嵌套子目录） */
function allDirs(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.type === "dir") {
      out.push(n);
      out.push(...allDirs(n.children));
    }
  }
  return out;
}

let toastTimer = null;
function showToast(msg, isError) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

/* ---------------- 全局状态 ---------------- */
const state = {
  data: null,
  books: [],           // 展平后的全部书籍
  selectedPath: null,  // 选中的系列/目录路径，null=全部
  expanded: new Set(), // 展开的目录路径
  query: "",
  sortKey: "title",
  sortDir: 1,
  booksCollapsed: localStorage.getItem("booksCollapsed") === "1",
  currentPath: null,   // 详情面板当前书籍
  autoRefresh: true,
  timer: null,
  lastSig: null,
  ddIndex: -1,         // 搜索下拉当前高亮的索引
};

/* ---------------- 数据获取 ---------------- */
function flatten(data) {
  const out = [];
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.type === "file") { n.series = seriesOf(n.path); out.push(n); }
      else walk(n.children);
    }
  })(data.series);
  for (const f of data.standalone) { f.series = "散书"; out.push(f); }
  return out;
}

function sigOf(data) {
  const s = data.stats;
  return JSON.stringify({
    t: s.totalBooks,
    series: s.seriesStats.map((x) => x.name + ":" + x.count).join(","),
    recent: s.recentlyModified.slice(0, 8).map((b) => b.path + "@" + b.mtime).join(","),
    hist: data.history.slice(0, 8).map((h) => h.path + "@" + h.lastOpened).join(","),
  });
}

async function fetchData() {
  try {
    const res = await fetch("/api/books?t=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.data = data;
    state.books = flatten(data);
    // 应用名来自后端配置（默认「我的书库」），同步到标题与顶栏品牌
    if (data.name) {
      document.title = "📚 " + data.name;
      const brand = $(".brand");
      if (brand) brand.textContent = "📚 " + data.name;
    }
    const sig = sigOf(data);
    if (sig !== state.lastSig) {
      state.lastSig = sig;
      renderAll();
    }
    $("#scanStatus").textContent = "更新于 " + new Date().toLocaleTimeString();
  } catch (e) {
    $("#scanStatus").textContent = "⚠ 连接失败";
  }
}

/* ---------------- 渲染入口 ---------------- */
function renderAll() {
  if (!state.data) return;
  renderStatCards();
  renderSidebar();
  renderRecent();
  renderCharts();
  renderBookTable();
  renderDetail();
  // 数据刷新时若下拉框正开着，同步刷新其内容
  const dd = $("#searchDropdown");
  if (dd && !dd.classList.contains("hidden")) renderDropdown();
}

/* ---------------- 统计卡片 ---------------- */
function renderStatCards() {
  const s = state.data.stats;
  const recent30 = s.recentlyModified.filter((b) => b.inRecent).length;
  const cards = [
    { v: s.totalBooks, l: "书籍总数" },
    { v: fmtSize(s.totalSize), l: "总体积" },
    { v: s.seriesCount, l: "系列数量" },
    { v: recent30, l: "近 30 天新增/修改" },
  ];
  $("#statCards").innerHTML = cards
    .map((c) => `<div class="stat-card"><div class="value">${c.v}</div><div class="label">${c.l}</div></div>`)
    .join("");
}

/* ---------------- 侧边栏系列树 ---------------- */
function dirTreeHTML(nodes, depth) {
  const dirs = nodes.filter((n) => n.type === "dir");
  if (!dirs.length) return "";
  const items = dirs.map((n) => {
    const active = state.selectedPath === n.path ? " active" : "";
    const open = state.expanded.has(n.path);
    const hasKids = n.children.some((c) => c.type === "dir");
    return `<li>
      <div class="tree-item${active}" data-sel="${esc(n.path)}">
        <span class="caret" data-toggle="${esc(n.path)}">${hasKids ? (open ? "▾" : "▸") : ""}</span>
        <span class="icon">📁</span><span class="name">${esc(n.name)}</span>
        <span class="count">${n.count}</span>
      </div>
      ${hasKids && open ? dirTreeHTML(n.children, depth + 1) : ""}
    </li>`;
  }).join("");
  return `<ul class="tree-children">${items}</ul>`;
}

function renderSidebar() {
  const allActive = state.selectedPath === null ? " active" : "";
  let html = `<li><div class="tree-item tree-all${allActive}" data-sel="">
      <span class="caret"></span><span class="icon">📚</span><span class="name">全部书籍</span>
      <span class="count">${state.data.stats.totalBooks}</span></div></li>`;
  html += dirTreeHTML(state.data.series, 0);
  $("#seriesTree").innerHTML = html;
}

/* ---------------- 最近阅读 ---------------- */
function recentItemHTML(b) {
  return `<li data-open="${esc(b.path)}" title="${esc(b.name)}">
    <span class="ext-badge ${esc(b.ext)}">${esc(b.ext)}</span>
    <span class="b-title">${esc(b.title)}</span>
    <span class="b-series">${esc(b.series)}</span>
    <span class="b-date">${fmtDateShort(b.mtime)}</span>
  </li>`;
}

function renderRecent() {
  const s = state.data.stats;
  // 最近打开：来自应用内打开记录
  const hist = state.data.history.slice(0, 8);
  $("#recentOpenList").innerHTML = hist.length
    ? hist.map((h) => `<li data-open="${esc(h.path)}" title="${esc(h.title)}">
        <span class="b-title">${esc(h.title)}</span>
        <span class="b-date">${fmtDateShort(h.lastOpened)} · ${h.opens}次</span></li>`).join("")
    : '<li class="empty">在应用中点击打开书籍后，这里会记录你的阅读足迹。</li>';
  // 最近修改：近 30 天有改动的书
  const mod = s.recentlyModified.filter((b) => b.inRecent).slice(0, 8);
  $("#recentModifiedList").innerHTML = mod.length
    ? mod.map((b) => `<li data-open="${esc(b.path)}" title="${esc(b.name)}">
        <span class="ext-badge ${esc(b.ext)}">${esc(b.ext)}</span>
        <span class="b-title">${esc(b.title)}</span>
        <span class="b-series">${esc(b.series)}</span>
        <span class="b-date">${b.daysAgo} 天前</span></li>`).join("")
    : '<li class="empty">近 30 天没有检测到文件改动。</li>';
}

/* ---------------- 图表（内联 SVG） ---------------- */
function chartWidth(sel) {
  const el = $(sel);
  return Math.max(240, el.clientWidth || 480);
}

function bindTooltips() {
  const tip = $("#chartTooltip");
  document.querySelectorAll(".chart-box").forEach((box) => {
    box.onmousemove = (e) => {
      const t = e.target.closest("[data-tt]");
      if (!t) { tip.classList.remove("visible"); return; }
      tip.textContent = t.getAttribute("data-tt");
      tip.classList.add("visible");
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = e.clientX + 14, y = e.clientY + 16;
      if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 12;
      if (y + th > window.innerHeight - 8) y = e.clientY - th - 10;
      tip.style.left = x + "px";
      tip.style.top = y + "px";
    };
    box.onmouseleave = () => tip.classList.remove("visible");
  });
}

function renderSeriesBarChart() {
  const rows = state.data.stats.seriesStats.slice().sort((a, b) => b.count - a.count);
  const width = chartWidth("#seriesBarChart");
  const rowH = 26, labelW = 118, gap = 10, pad = 8;
  const valW = 34;
  const barMaxW = width - labelW - gap - valW - pad;
  const h = rows.length * rowH + pad;
  const maxCount = Math.max(...rows.map((r) => r.count), 1);
  let y = pad;
  let svg = `<svg viewBox="0 0 ${width} ${h}">`;
  for (const r of rows) {
    const bw = Math.max(2, (r.count / maxCount) * barMaxW);
    svg += `<text x="${labelW - gap}" y="${y + 12}" text-anchor="end" class="chart-axis-label">${esc(shorten(r.name, 12))}</text>`;
    svg += `<rect class="chart-bar" x="${labelW + gap}" y="${y}" width="${bw}" height="16" rx="4" data-tt="${esc(r.name)} · ${r.count} 本 · ${fmtSize(r.size)}"></rect>`;
    svg += `<text x="${labelW + gap + bw + 6}" y="${y + 12}" class="chart-value">${r.count}</text>`;
    y += rowH;
  }
  svg += "</svg>";
  $("#seriesBarChart").innerHTML = svg;
}

function renderFormatChart() {
  const fmts = state.data.stats.formats;
  const total = Math.max(state.data.stats.totalBooks, 1);
  const width = chartWidth("#formatBarChart");
  const h = 96, pad = 8, barY = 16, barH = 22, segGap = 2;
  const availW = width - pad * 2;
  const colors = { pdf: "var(--series-1)", epub: "var(--series-2)" };
  const defaultColor = "var(--series-3)";
  let segs = "", legend = "";
  let x = pad;
  fmts.forEach((f, i) => {
    const w = Math.max(0, (f.count / total) * availW - (i > 0 ? segGap : 0));
    const color = colors[f.ext] || defaultColor;
    const pct = Math.round((f.count / total) * 100);
    segs += `<rect class="chart-segment" x="${x}" y="${barY}" width="${w}" height="${barH}" rx="4" fill="${color}" data-tt="${f.ext.toUpperCase()} · ${f.count} 本 · ${pct}% · ${fmtSize(f.size)}"></rect>`;
    legend += `<span class="legend-item"><span class="swatch" style="background:${color}"></span>${f.ext.toUpperCase()} ${f.count} · ${pct}%</span>`;
    x += w;
  });
  $("#formatBarChart").innerHTML =
    `<svg viewBox="0 0 ${width} ${h}"><rect x="${pad}" y="${barY}" width="${availW}" height="${barH}" rx="4" fill="none" stroke="var(--baseline)"></rect>${segs}</svg>` +
    `<div class="legend">${legend}</div>`;
}

function renderTimelineChart() {
  const t = state.data.stats.timeline;
  const monthly = t.filter((x) => x.month !== "更早");
  const earlier = t.find((x) => x.month === "更早");
  const width = chartWidth("#timelineChart");
  const h = 220, padL = 30, padB = 26, padT = 18, padR = 8;
  const plotW = width - padL - padR;
  const plotH = h - padT - padB;
  const maxV = Math.max(...monthly.map((m) => m.count), 1);
  const slot = plotW / monthly.length;
  const barW = Math.min(34, slot * 0.62);
  const yScale = (v) => padT + plotH - (v / maxV) * plotH;
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = Math.round((maxV * i) / 4);
    const y = yScale(v);
    g += `<line class="chart-gridline" x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}"></line>`;
    g += `<text x="${padL - 6}" y="${y + 3}" text-anchor="end" class="chart-axis-label">${v}</text>`;
  }
  let bars = "", vals = "", labels = "";
  monthly.forEach((m, i) => {
    const cx = padL + slot * i + slot / 2;
    const by = yScale(m.count);
    if (m.count > 0) {
      const ttTitles = m.titles || [];
      let ttExtra = "";
      if (ttTitles.length) {
        const shown = ttTitles.slice(0, 20);
        ttExtra = "\n" + shown.map((t) => "· " + esc(t)).join("\n");
        if (ttTitles.length > 20) ttExtra += "\n… 等 " + ttTitles.length + " 本";
      }
      bars += `<rect class="chart-bar" x="${cx - barW / 2}" y="${by}" width="${barW}" height="${plotH - (by - padT)}" rx="4" data-tt="${m.month} · 新增 ${m.count} 本${ttExtra}"></rect>`;
      vals += `<text x="${cx}" y="${by - 6}" text-anchor="middle" class="chart-value">${m.count}</text>`;
    }
    labels += `<text x="${cx}" y="${padT + plotH + 16}" text-anchor="middle" class="chart-axis-label">${m.month.slice(2)}</text>`;
  });
  $("#timelineChart").innerHTML = `<svg viewBox="0 0 ${width} ${h}">${g}${bars}${vals}${labels}</svg>`;
  $("#timelineNote").textContent = earlier ? `· 更早之前 ${earlier.count} 本未显示` : "";
}

function renderCharts() {
  renderSeriesBarChart();
  renderFormatChart();
  renderTimelineChart();
  bindTooltips();
}

/* ---------------- 书籍列表 ---------------- */
function filteredBooks() {
  let list = state.books;
  if (state.selectedPath) {
    const p = state.selectedPath;
    list = list.filter((b) => b.path.startsWith(p + "/"));
  }
  const tokens = state.query ? state.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  if (tokens.length) {
    return searchRanked(list, tokens).map((x) => x.b);
  }
  const k = state.sortKey, dir = state.sortDir;
  list = list.slice().sort((a, b) => {
    let va = a[k], vb = b[k];
    if (k === "title") { va = a.title.toLowerCase(); vb = b.title.toLowerCase(); }
    if (typeof va === "string") return va.localeCompare(vb, "zh") * dir;
    return (va - vb) * dir;
  });
  return list;
}

/* 全部书籍列表：收起 / 展开 */
function setBooksCollapsed(collapsed) {
  state.booksCollapsed = collapsed;
  const sec = $("#booksSection");
  if (sec) sec.classList.toggle("collapsed", collapsed);
  const btn = $("#toggleBooks");
  if (btn) {
    btn.textContent = collapsed ? "▸" : "▾";
    btn.title = collapsed ? "展开书籍列表" : "收起书籍列表";
  }
  try { localStorage.setItem("booksCollapsed", collapsed ? "1" : "0"); } catch (e) {}
}
function toggleBooks() { setBooksCollapsed(!state.booksCollapsed); }

function selectionLabel() {
  if (state.selectedPath) {
    const p = state.selectedPath;
    return p.includes("/") ? p.split("/").slice(-1)[0] : p;
  }
  return "全部书籍";
}

function renderBookTable() {
  if (state.query && state.booksCollapsed) setBooksCollapsed(false);
  const title = state.selectedPath ? `📚 ${selectionLabel()}` : "📚 全部书籍";
  const s = state.data.stats;
  const list = filteredBooks();
  $("#bookListTitle").textContent = title + `（${list.length} 本 / 共 ${s.totalBooks} 本）`;
  const sortMark = (k) => state.sortKey === k ? (state.sortDir === 1 ? " ▲" : " ▼") : "";
  const ths = ["title", "series", "ext", "size", "mtime"];
  $$("#booksTable thead th").forEach((th, i) => {
    th.textContent = th.textContent.replace(/[▲▼ ]+$/, "") + sortMark(ths[i]);
  });
  const tokens = state.query ? state.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const rows = list.map((b) => `<tr data-path="${esc(b.path)}" class="${b.path === state.currentPath ? "selected" : ""}" title="${esc(b.name)}">
      <td class="c-title">${highlight(b.title, tokens)}</td>
      <td class="c-series">${esc(b.series)}</td>
      <td><span class="ext-badge ${esc(b.ext)}">${esc(b.ext)}</span></td>
      <td class="c-size">${fmtSize(b.size)}</td>
      <td class="c-mtime">${fmtDateShort(b.mtime)}</td>
    </tr>`).join("");
  $("#booksTbody").innerHTML = rows.length
    ? rows
    : '<tr class="empty-row"><td colspan="5">没有符合条件的书籍。</td></tr>';
}

/* ---------------- 搜索下拉（网页搜索框效果） ---------------- */
function seriesMatch(name, tokens) {
  const n = name.toLowerCase();
  if (!tokens.length) return true;
  return tokens.some((t) => n.includes(t) || fuzzyMatch(t, n));
}

function renderDropdown() {
  const dd = $("#searchDropdown");
  if (!state.data) return;
  state.ddIndex = -1;
  const tokens = state.query ? state.query.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const dirs = allDirs(state.data.series).filter((n) => seriesMatch(n.name, tokens));
  const bookHits = tokens.length ? searchRanked(state.books, tokens).slice(0, 8).map((x) => x.b) : [];
  let html = "";
  if (dirs.length) {
    html += '<div class="dd-group-title">系列</div>';
    html += dirs.slice(0, 12).map((n) => `
      <div class="dd-item" data-type="series" data-path="${esc(n.path)}">
        <span>📁</span><span class="dd-name">${highlight(n.name, tokens)}</span>
        <span class="dd-count">${n.count} 本</span>
      </div>`).join("");
  }
  if (bookHits.length) {
    html += '<div class="dd-group-title">书籍</div>';
    html += bookHits.map((b) => `
      <div class="dd-item" data-type="book" data-path="${esc(b.path)}">
        <span class="ext-badge ${esc(b.ext)}">${esc(b.ext)}</span>
        <span class="dd-name">${highlight(b.title, tokens)}</span>
        <span class="dd-meta">${esc(b.series)}</span>
      </div>`).join("");
  }
  dd.innerHTML = html || '<div class="dd-empty">没有匹配的系列或书籍</div>';
  dd.classList.remove("hidden");
}

function hideDropdown() {
  $("#searchDropdown").classList.add("hidden");
  state.ddIndex = -1;
}

function ddItems() {
  return $$("#searchDropdown .dd-item");
}

function ddActivate(item) {
  if (!item) return;
  const type = item.getAttribute("data-type");
  const path = item.getAttribute("data-path");
  if (type === "book") {
    openDetail(path);
    openBook(path);
  } else {
    state.selectedPath = path || null;
    if (path) state.expanded.add(path); // 选中系列时同步展开侧边栏
    renderSidebar();
    renderBookTable();
    scrollToBooks();
  }
  // 选择后清空搜索并收起下拉
  state.query = "";
  $("#searchInput").value = "";
  renderBookTable();
  hideDropdown();
}

function scrollToBooks() {
  const el = $("#booksSection");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function onSearchKeydown(e) {
  const items = ddItems();
  if (!items.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const dir = e.key === "ArrowDown" ? 1 : -1;
    let idx = state.ddIndex;
    if (idx < 0) idx = dir === 1 ? 0 : items.length - 1;
    else idx = (idx + dir + items.length) % items.length;
    state.ddIndex = idx;
    items.forEach((it, i) => it.classList.toggle("active", i === idx));
    items[idx].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    ddActivate(items[state.ddIndex >= 0 ? state.ddIndex : 0]);
  } else if (e.key === "Escape") {
    hideDropdown();
  }
}

/* ---------------- 详情面板 ---------------- */
function noteOf(path) {
  return (state.data.notes[path] || { tags: [], note: "" });
}

function bookOf(path) {
  return state.books.find((b) => b.path === path) || null;
}

function openDetail(path) {
  state.currentPath = path;
  renderDetail();
  $("#detailPanel").classList.remove("hidden");
}

function closeDetail() {
  state.currentPath = null;
  $("#detailPanel").classList.add("hidden");
}

function renderDetail() {
  const panel = $("#detailPanel");
  const path = state.currentPath;
  if (!path) { panel.classList.add("hidden"); return; }
  const b = bookOf(path);
  const note = noteOf(path);
  $("#detailTitle").textContent = b ? b.title : path.split("/").pop();
  $("#detailMeta").innerHTML = b ? `
    <dt>系列</dt><dd>${esc(b.series)}</dd>
    <dt>格式</dt><dd>${esc(b.ext.toUpperCase())}</dd>
    <dt>大小</dt><dd>${fmtSize(b.size)}</dd>
    <dt>修改</dt><dd>${fmtDate(b.mtime)}</dd>
    <dt>路径</dt><dd>${esc(b.path)}</dd>` : "";
  const hist = state.data.history.filter((h) => h.path === path);
  $("#detailHistory").innerHTML = hist.length
    ? hist.map((h) => `${fmtDate(h.lastOpened)}（第 ${h.opens} 次打开）`).join("<br>")
    : "暂无打开记录";
  $("#detailTags").innerHTML = (note.tags || []).map((t) =>
    `<span class="tag">${esc(t)}<span class="tag-del" data-tag="${esc(t)}">✕</span></span>`).join("");
  $("#noteInput").value = note.note || "";
  $("#noteSaveStatus").textContent = "";
}

/* ---------------- 打开 / 备注 ---------------- */
async function openBook(path) {
  const b = bookOf(path);
  try {
    const res = await fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const j = await res.json();
    if (j.ok) {
      showToast("已打开：" + (b ? b.title : "书籍"));
      fetchData(); // 刷新后更新"最近打开"
    } else {
      showToast(j.error || "打开失败", true);
    }
  } catch (e) {
    showToast("打开失败：无法访问本地文件", true);
  }
}

async function saveNote(path, tags, note) {
  try {
    const res = await fetch("/api/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, tags, note }),
    });
    const j = await res.json();
    if (!j.ok) { showToast(j.error || "保存失败", true); return; }
    state.data.notes[path] = { tags, note };
    state.lastSig = null; // 强制下次刷新重渲染
    const st = $("#noteSaveStatus");
    st.textContent = "✓ 已保存";
    setTimeout(() => { st.textContent = ""; }, 2000);
    showToast("备注与标签已保存");
  } catch (e) {
    showToast("保存失败", true);
  }
}

/* ---------------- 事件绑定 ---------------- */
function wireEvents() {
  // 搜索：输入时实时过滤表格 + 显示下拉即时结果（网页搜索框效果）
  $("#searchInput").addEventListener("input", (e) => {
    state.query = e.target.value.trim();
    renderBookTable();
    renderDropdown();
  });
  $("#searchInput").addEventListener("focus", () => renderDropdown());
  $("#searchInput").addEventListener("blur", () => setTimeout(hideDropdown, 150));
  $("#searchInput").addEventListener("keydown", onSearchKeydown);
  $("#searchDropdown").addEventListener("mousedown", (e) => {
    const item = e.target.closest(".dd-item");
    if (!item) return;
    e.preventDefault(); // 避免先触发 input 的 blur 导致下拉提前关闭
    ddActivate(item);
  });

  // 自动刷新
  const toggleAuto = () => {
    state.autoRefresh = $("#autoRefresh").checked;
    clearInterval(state.timer);
    if (state.autoRefresh) state.timer = setInterval(fetchData, 5000);
  };
  $("#autoRefresh").addEventListener("change", toggleAuto);

  // 手动刷新
  $("#refreshBtn").addEventListener("click", fetchData);

  // 侧边栏：点击系列 → 展开/收起子目录（进一步打开）+ 选中查看书籍
  $("#seriesTree").addEventListener("click", (e) => {
    const item = e.target.closest("[data-sel]");
    if (!item) return;
    const path = item.getAttribute("data-sel") || null;
    if (path) {
      if (state.expanded.has(path)) state.expanded.delete(path);
      else state.expanded.add(path);
    }
    state.selectedPath = path;
    renderSidebar();
    renderBookTable();
  });

  // 全部书籍：点击标题栏或按钮 → 收起 / 展开
  $("#booksSectionHead").addEventListener("click", toggleBooks);
  $("#toggleBooks").addEventListener("click", (e) => {
    e.stopPropagation(); // 避免冒泡到标题栏重复触发
    toggleBooks();
  });

  // 表格排序
  $("#booksTable thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-sort]");
    if (!th) return;
    const k = th.getAttribute("data-sort");
    if (state.sortKey === k) state.sortDir *= -1;
    else { state.sortKey = k; state.sortDir = 1; }
    renderBookTable();
  });

  // 表格行：点击打开 + 详情
  $("#booksTbody").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-path]");
    if (!row) return;
    const path = row.getAttribute("data-path");
    openDetail(path);
    openBook(path);
  });

  // 最近阅读点击打开
  $("#recentOpenList").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-open]");
    if (li) openBook(li.getAttribute("data-open"));
  });
  $("#recentModifiedList").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-open]");
    if (li) openBook(li.getAttribute("data-open"));
  });

  // 详情面板
  $("#detailClose").addEventListener("click", closeDetail);
  $("#detailOpen").addEventListener("click", () => {
    if (state.currentPath) openBook(state.currentPath);
  });

  $("#detailTags").addEventListener("click", (e) => {
    const del = e.target.closest(".tag-del");
    if (!del || !state.currentPath) return;
    const rm = del.getAttribute("data-tag");
    const note = noteOf(state.currentPath);
    note.tags = (note.tags || []).filter((t) => t !== rm);
    renderDetail();
  });

  $("#tagInput").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !state.currentPath) return;
    const v = e.target.value.trim();
    if (!v) return;
    const note = noteOf(state.currentPath);
    note.tags = note.tags || [];
    if (!note.tags.includes(v)) note.tags.push(v);
    e.target.value = "";
    renderDetail();
  });

  $("#noteSaveBtn").addEventListener("click", () => {
    if (!state.currentPath) return;
    const note = noteOf(state.currentPath);
    saveNote(state.currentPath, note.tags || [], $("#noteInput").value);
  });

  // 尺寸变化时重绘图表
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.data) renderCharts(); }, 200);
  });
}

/* ---------------- 启动 ---------------- */
document.addEventListener("DOMContentLoaded", () => {
  // 工具提示容器
  const tip = document.createElement("div");
  tip.id = "chartTooltip";
  tip.className = "chart-tooltip";
  document.body.appendChild(tip);
  // 心跳：加载后立即发一次（及时取消"再见"退出倒计时），之后每 30 秒一次；
  // 浏览器关闭后心跳停止，服务端自动退出（避免无窗口后台残留进程）
  const beat = () => fetch("/api/heartbeat", { cache: "no-store" }).catch(() => {});
  beat();
  setInterval(beat, 30000);

  // 页面关闭/刷新前：通知服务端"再见"（服务端快速退出）
  window.addEventListener("pagehide", () => {
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/goodbye", new Blob(["bye"], { type: "text/plain" }));
    }
  });

  setBooksCollapsed(state.booksCollapsed);
  wireEvents();
  fetchData();
  state.timer = setInterval(fetchData, 5000);
});
