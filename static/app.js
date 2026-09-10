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

/* 秒数 → 阅读时长文本（如「2 小时 15 分」「45 分钟」） */
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  if (sec < 60) return "不足 1 分钟";
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h && rm) return `${h} 小时 ${rm} 分`;
  if (h) return `${h} 小时`;
  return `${m} 分钟`;
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
  finishedFilter: null, // 读完筛选：null 全部 / true 已读完 / false 未读完
  activePath: null,    // 当前计时书籍（阅读时长自动估算）
  activeSince: 0,      // 当前计时起点（秒时间戳）
  timer: null,
  lastSig: null,
  ddIndex: -1,         // 搜索下拉当前高亮的索引
  activeTab: "books",  // 当前视图：books 书库 / shows 追剧
  showCurrentId: null, // 剧集面板当前编辑 id；null = 新增模式
  showDraft: { status: "want", tags: [], rating: null }, // 剧集面板临时编辑态
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
  // 追剧记录也计入签名：按固定字段序拼接并排序，避免对象 key 顺序/emoji 引起抖动
  const shows = Object.values(data.shows || {}).map((x) =>
    [x.id, x.status, x.name, x.episode, x.total, x.rating,
     (x.tags || []).join(","), x.startDate, x.finishDate, x.note].join("|")
  ).sort().join(";");
  return JSON.stringify({
    t: s.totalBooks,
    series: s.seriesStats.map((x) => x.name + ":" + x.count).join(","),
    recent: s.recentlyModified.slice(0, 8).map((b) => b.path + "@" + b.mtime).join(","),
    hist: data.history.slice(0, 8).map((h) => h.path + "@" + h.lastOpened).join(","),
    shows,
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
  // 追剧视图：列表随数据自动刷新
  if (state.activeTab === "shows") renderShowList();
}

/* ---------------- 统计卡片 ---------------- */
function renderStatCards() {
  const s = state.data.stats;
  const recent30 = s.recentlyModified.filter((b) => b.inRecent).length;
  const doneCount = Object.values(state.data.notes).filter((n) => n.finished).length;
  const cards = [
    { v: s.totalBooks, l: "书籍总数" },
    { v: fmtSize(s.totalSize), l: "总体积" },
    { v: s.seriesCount, l: "系列数量" },
    { v: recent30, l: "近 30 天新增/修改" },
    { v: fmtDur(s.readingSeconds), l: "累计阅读时长" },
    { v: doneCount, l: "已读完" },
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
  const allActive = state.selectedPath === null && state.finishedFilter === null ? " active" : "";
  let html = `<li><div class="tree-item tree-all${allActive}" data-sel="">
      <span class="caret"></span><span class="icon">📚</span><span class="name">全部书籍</span>
      <span class="count">${state.data.stats.totalBooks}</span></div></li>`;
  // 读完筛选入口（点击切换，再点一次取消）
  const finItem = (val, icon, label) => {
    const active = state.finishedFilter === val ? " active" : "";
    return `<li><div class="tree-item tree-fin${active}" data-fin="${val ? "done" : "undone"}">
      <span class="caret"></span><span class="icon">${icon}</span><span class="name">${label}</span></div></li>`;
  };
  html += finItem(true, "✅", "已读完");
  html += finItem(false, "📖", "未读完");
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
  // 近期阅读时长总量提示（单本时长在详情面板展示）
  $("#readingStat").textContent = s.readingSeconds
    ? `近 7 天 ${fmtDur(s.readingRecent7)} · 近 30 天 ${fmtDur(s.readingRecent30)}`
    : "";
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
  if (state.finishedFilter !== null) {
    list = list.filter((b) => !!((state.data.notes[b.path] || {}).finished) === state.finishedFilter);
  }
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
  if (state.finishedFilter !== null) return state.finishedFilter ? "已读完" : "未读完";
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
  const rows = list.map((b) => {
    const fin = (state.data.notes[b.path] || {}).finished
      ? '<span class="done-mark" title="已读完">✓</span> '
      : "";
    return `<tr data-path="${esc(b.path)}" class="${b.path === state.currentPath ? "selected" : ""}" title="${esc(b.name)}">
      <td class="c-title">${fin}${highlight(b.title, tokens)}</td>
      <td class="c-series">${esc(b.series)}</td>
      <td><span class="ext-badge ${esc(b.ext)}">${esc(b.ext)}</span></td>
      <td class="c-size">${fmtSize(b.size)}</td>
      <td class="c-mtime">${fmtDateShort(b.mtime)}</td>
    </tr>`;
  }).join("");
  $("#booksTbody").innerHTML = rows.length
    ? rows
    : '<tr class="empty-row"><td colspan="5">没有符合条件的书籍。</td></tr>';
}

/* ---------------- 追剧记录（手动清单） ---------------- */
const SHOW_ORDER = ["want", "watching", "done"];
const SHOW_LABEL = { want: "🍿 想看", watching: "📺 正在看", done: "✅ 已看完" };

/* 全部剧集，按 id 降序（最新添加在前） */
function showsArray() {
  return Object.values(state.data.shows || {})
    .sort((a, b) => Number(b.id) - Number(a.id));
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* 进度文本：3/24 集 之类；想看为空 */
function progressText(s) {
  const e = Number(s.episode) || 0;
  const t = Number(s.total) || 0;
  if (s.status === "done") return "已看完";
  if (s.status === "want") return "";
  if (t > 0) return `第 ${Math.min(e, t)}/${t} 集`;
  return e > 0 ? `看到第 ${e} 集` : "刚开始";
}

function ratingText(r) {
  return (r == null || r === "") ? "" : "★ " + r;
}

/* 状态对应的行内快捷按钮 */
function quickBtnHTML(s) {
  if (s.status === "want") {
    return `<button class="qbtn" data-q="start">开始看</button>`;
  }
  if (s.status === "watching") {
    return `<button class="qbtn" data-q="inc" title="记录进度 +1 集">＋1 集</button>
      <button class="qbtn" data-q="done">看完</button>`;
  }
  return `<button class="qbtn" data-q="redo" title="重新开始看一遍">再看一遍</button>
    <button class="qbtn danger" data-q="del">删除</button>`;
}

function showRowHTML(s) {
  const doneMark = s.status === "done" ? '<span class="done-mark">✓</span> ' : "";
  const meta = progressText(s);
  const rating = ratingText(s.rating);
  const date = (s.status === "done" && s.finishDate) ? s.finishDate : "";
  return `<li data-show-id="${esc(s.id)}" title="${esc(s.name)} · 点击编辑">
    <span class="show-name">${doneMark}${esc(s.name)}</span>
    ${meta ? `<span class="show-meta">${esc(meta)}</span>` : ""}
    ${rating ? `<span class="show-rating">${esc(rating)}</span>` : ""}
    ${date ? `<span class="show-date">${esc(date)}</span>` : ""}
    <span class="show-actions">${quickBtnHTML(s)}</span>
  </li>`;
}

function renderShowSummary() {
  const arr = showsArray();
  const count = (st) => arr.filter((x) => x.status === st).length;
  const chips = SHOW_ORDER.map((st) =>
    `<span class="summary-chip">${SHOW_LABEL[st]} <b>${count(st)}</b></span>`).join("");
  $("#showSummary").innerHTML =
    `<span class="summary-chip">🎬 共 <b>${arr.length}</b> 部</span>` + chips;
}

function renderShowList() {
  const arr = showsArray();
  const groups = SHOW_ORDER.map((st) => {
    const items = arr.filter((x) => x.status === st);
    return `<div class="show-group">
      <div class="show-group-head">${SHOW_LABEL[st]}<span class="count-badge">${items.length}</span></div>
      <ul class="show-list">${items.length
        ? items.map(showRowHTML).join("")
        : '<li class="empty">这里还没有剧集</li>'}</ul>
    </div>`;
  }).join("");
  $("#showGroups").innerHTML = groups;
  renderShowSummary();
}

/* ---------------- 追剧：视图切换 / 详情面板 ---------------- */
function switchTab(tab) {
  if (tab === state.activeTab) return;
  state.activeTab = tab;
  closeDetail();       // 关书籍详情面板，保证两面板不同屏
  closeShowPanel();    // 关剧集详情面板
  hideDropdown();      // 下拉只服务书库搜索，切走即收起
  $("#view-books").classList.toggle("hidden", tab !== "books");
  $("#view-shows").classList.toggle("hidden", tab !== "shows");
  document.body.dataset.view = tab;
  $$("#viewTabs .tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "shows") {
    renderShowList();
  } else {
    // 书库视图从隐藏恢复，图表需按真实宽度重绘（隐藏期宽度为 0 → 用了 480 fallback）
    renderCharts();
    renderBookTable();
  }
}

function updateSegActive() {
  $$("#showStatusSeg .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.status === state.showDraft.status));
}

function renderShowTags() {
  $("#showTags").innerHTML = state.showDraft.tags.map((t) =>
    `<span class="tag">${esc(t)}<span class="tag-del" data-tag="${esc(t)}">✕</span></span>`).join("");
}

function renderRatingPicker(cur) {
  let html = "";
  for (let v = 1; v <= 10; v++) {
    html += `<button type="button" class="rp-btn${v === cur ? " on" : ""}" data-rating="${v}">${v}</button>`;
  }
  html += `<button type="button" class="rp-btn" data-rating="clear" title="清除评分">✕</button>`;
  $("#showRatingPicker").innerHTML = html;
}

function closeShowPanel() {
  state.showCurrentId = null;
  state.showDraft = { status: "want", tags: [], rating: null };
  const p = $("#showPanel");
  if (p) p.classList.add("hidden");
}

/* 打开剧集详情面板：id 为 null 时进入「添加」模式 */
function openShow(id) {
  const d = state.showDraft;
  d.status = "want";
  d.tags = [];
  d.rating = null;
  if (id != null) {
    const s = (state.data.shows || {})[id];
    if (!s) { showToast("剧集不存在", true); return; }
    d.status = s.status;
    d.tags = (s.tags || []).slice();
    d.rating = (s.rating == null) ? null : s.rating;
  }
  state.showCurrentId = id;
  renderShowPanel();
  $("#showPanel").classList.remove("hidden");
  if (id == null) $("#showName").focus();
}

/* 回填剧集面板。注意：只写一次初始值，输入过程中的重绘由各控件自己负责，
   避免 5 秒轮询 / 无关操作打断正在输入的内容。 */
function renderShowPanel() {
  const id = state.showCurrentId;
  const d = state.showDraft;
  const rec = (id != null) ? (state.data.shows || {})[id] : null;
  const editing = !!rec;
  $("#showPanelTitle").textContent = editing ? `编辑 · ${rec.name}` : "添加剧集";
  $("#showName").value = editing ? rec.name : "";
  updateSegActive();
  $("#showEpisode").value = editing ? (rec.episode || 0) : 0;
  $("#showTotal").value = editing ? (rec.total || 0) : 0;
  $("#showStart").value = editing ? (rec.startDate || "") : "";
  $("#showFinish").value = editing ? (rec.finishDate || "") : "";
  renderRatingPicker(d.rating);
  renderShowTags();
  $("#showNote").value = editing ? (rec.note || "") : "";
  $("#showSaveStatus").textContent = "";
  $("#showSaveBtn").textContent = editing ? "保存修改" : "添加";
  $("#showDeleteBtn").classList.toggle("hidden-soft", !editing);
  const tagInput = $("#showTagInput");
  if (tagInput) tagInput.value = "";
}

/* 从面板 DOM + showDraft 汇总记录；剧名为空则提示并返回 null */
function collectShowForm() {
  const name = $("#showName").value.trim();
  if (!name) { showToast("请填写剧名", true); return null; }
  const episode = Math.max(0, parseInt($("#showEpisode").value, 10) || 0);
  const total = Math.max(0, parseInt($("#showTotal").value, 10) || 0);
  return {
    id: state.showCurrentId,          // null = 新增，id 由服务端分配
    name,
    status: state.showDraft.status,
    episode,
    total,
    startDate: $("#showStart").value || "",
    finishDate: $("#showFinish").value || "",
    rating: state.showDraft.rating,
    tags: state.showDraft.tags.slice(),
    note: $("#showNote").value.trim(),
  };
}

/* 保存（新增/更新），成功后以服务端规范化 record 覆盖本地 */
async function saveShow(rec) {
  const action = (rec.id != null) ? "update" : "add";
  const payload = Object.assign({ action }, rec);
  if (action === "add") delete payload.id;
  try {
    const res = await fetch("/api/shows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (!j.ok) { showToast(j.error || "保存失败", true); return; }
    const saved = j.record;
    state.data.shows = state.data.shows || {};
    state.data.shows[saved.id] = saved;
    state.showCurrentId = saved.id;
    state.lastSig = null;          // 强制下次轮询重渲染（含他处打开的同页）
    renderShowList();
    renderShowPanel();             // 新增 → 编辑态：刷新标题/按钮
    const st = $("#showSaveStatus");
    st.textContent = "✓ 已保存";
    setTimeout(() => { st.textContent = ""; }, 2000);
    showToast("已保存：" + saved.name);
  } catch (e) {
    showToast("保存失败", true);
  }
}

/* 行内快捷操作：act 见 quickBtnHTML 的 data-q */
async function quickShow(act, id) {
  const s = (state.data.shows || {})[id];
  if (!s) return;
  if (act === "start") {
    s.status = "watching";
    if (!s.startDate) s.startDate = todayStr();
  } else if (act === "inc") {
    const t = Number(s.total) || 0;
    s.episode = (Number(s.episode) || 0) + 1;
    if (t > 0) s.episode = Math.min(s.episode, t);   // 进度封顶到总集数
  } else if (act === "done") {
    s.status = "done";
    if (!s.finishDate) s.finishDate = todayStr();
    const t = Number(s.total) || 0;
    if (t > 0) s.episode = t;                        // 看完 = 进度拉满
  } else if (act === "redo") {
    s.status = "watching";
    s.finishDate = "";                               // 二刷：清掉看完日期
  } else if (act === "del") {
    deleteShow(id);
    return;
  }
  saveShow(s);
}

async function deleteShow(id) {
  const s = (state.data.shows || {})[id];
  if (!s) return;
  if (!window.confirm(`删除剧集「${s.name}」？`)) return;
  try {
    const res = await fetch("/api/shows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id }),
    });
    const j = await res.json();
    if (!j.ok) { showToast(j.error || "删除失败", true); return; }
    delete state.data.shows[id];
    if (state.showCurrentId === id) closeShowPanel();
    state.lastSig = null;
    renderShowList();
    showToast("已删除：" + s.name);
  } catch (e) {
    showToast("删除失败", true);
  }
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
  const rd = state.data.reading[path] || {};
  const rdStr = rd.seconds
    ? `${fmtDur(rd.seconds)}（近 30 天 ${fmtDur(rd.recent30)}）`
    : "暂无记录";
  $("#detailMeta").innerHTML = b ? `
    <dt>系列</dt><dd>${esc(b.series)}</dd>
    <dt>格式</dt><dd>${esc(b.ext.toUpperCase())}</dd>
    <dt>大小</dt><dd>${fmtSize(b.size)}</dd>
    <dt>修改</dt><dd>${fmtDate(b.mtime)}</dd>
    <dt>路径</dt><dd>${esc(b.path)}</dd>
    <dt>阅读时长</dt><dd>${esc(rdStr)}</dd>` : "";
  const hist = state.data.history.filter((h) => h.path === path);
  $("#detailHistory").innerHTML = hist.length
    ? hist.map((h) => `${fmtDate(h.lastOpened)}（第 ${h.opens} 次打开）`).join("<br>")
    : "暂无打开记录";
  $("#detailTags").innerHTML = (note.tags || []).map((t) =>
    `<span class="tag">${esc(t)}<span class="tag-del" data-tag="${esc(t)}">✕</span></span>`).join("");
  $("#noteInput").value = note.note || "";
  $("#noteSaveStatus").textContent = "";
  const finBtn = $("#finishToggle");
  if (finBtn) {
    finBtn.classList.toggle("on", !!note.finished);
    finBtn.textContent = note.finished ? "✓ 已读完" : "标记读完";
  }
}

/* ---------------- 阅读时长（自动估算） ---------------- */
function reportReading(path, start, end, useBeacon) {
  const payload = JSON.stringify({ path, start, end });
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/reading", new Blob([payload], { type: "application/json" }));
  } else {
    fetch("/api/reading", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    }).catch(() => {});
  }
}

/* 结算当前活跃书籍的阅读时长段并上报；随后推进计时起点 */
function settleActive(now) {
  if (!state.activePath || !state.activeSince) return;
  const start = state.activeSince;
  const end = now;
  if (end - start >= 1) reportReading(state.activePath, start, end, false);
  state.activeSince = now;
}

/* ---------------- 打开 / 备注 ---------------- */
async function openBook(path) {
  const b = bookOf(path);
  // 阅读计时：切换书籍时结算上一本；重复打开同一本则重置起点（不重复计时）
  const now = Math.floor(Date.now() / 1000);
  if (state.activePath && state.activePath !== path) settleActive(now);
  state.activePath = path;
  state.activeSince = now;
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

async function saveNote(path, tags, note, finished) {
  try {
    const res = await fetch("/api/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, tags, note, finished }),
    });
    const j = await res.json();
    if (!j.ok) { showToast(j.error || "保存失败", true); return; }
    state.data.notes[path] = { tags, note, finished };
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

  // 侧边栏：读完筛选入口（点击切换，再点一次取消）
  $("#seriesTree").addEventListener("click", (e) => {
    const finItem = e.target.closest("[data-fin]");
    if (finItem) {
      const v = finItem.getAttribute("data-fin") === "done";
      state.finishedFilter = state.finishedFilter === v ? null : v;
      state.selectedPath = null;
      renderSidebar();
      renderBookTable();
      return;
    }
    // 侧边栏：点击系列 → 展开/收起子目录（进一步打开）+ 选中查看书籍
    const item = e.target.closest("[data-sel]");
    if (!item) return;
    const path = item.getAttribute("data-sel") || null;
    if (path) {
      if (state.expanded.has(path)) state.expanded.delete(path);
      else state.expanded.add(path);
    }
    state.selectedPath = path;
    state.finishedFilter = null; // 选目录时清除读完筛选
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
    saveNote(state.currentPath, note.tags || [], $("#noteInput").value, !!note.finished);
  });

  // 读完开关：切换并保存
  $("#finishToggle").addEventListener("click", () => {
    if (!state.currentPath) return;
    const note = noteOf(state.currentPath);
    note.finished = !note.finished;
    saveNote(state.currentPath, note.tags || [], $("#noteInput").value, note.finished);
    renderDetail();
  });

  // 尺寸变化时重绘图表
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.data) renderCharts(); }, 200);
  });

  /* ---- 追剧视图 ---- */
  // 顶栏 Tab：书库 / 追剧
  $("#viewTabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (btn) switchTab(btn.dataset.tab);
  });

  // 添加剧集 → 打开空白面板
  $("#showAddBtn").addEventListener("click", () => openShow(null));

  // 追剧列表委托：先响应行内快捷按钮，否则点击整行打开编辑
  $("#showGroups").addEventListener("click", (e) => {
    const q = e.target.closest("[data-q]");
    if (q) {
      e.stopPropagation();
      const li = q.closest("li[data-show-id]");
      if (li) quickShow(q.getAttribute("data-q"), li.getAttribute("data-show-id"));
      return;
    }
    const row = e.target.closest("li[data-show-id]");
    if (row) openShow(row.getAttribute("data-show-id"));
  });

  // 剧集详情面板
  $("#showPanelClose").addEventListener("click", closeShowPanel);

  // 状态分段：只切高亮，不重绘整表，避免打断正在输入的进度
  $("#showStatusSeg").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (!b) return;
    state.showDraft.status = b.dataset.status;
    if (b.dataset.status === "done" && !$("#showFinish").value) {
      $("#showFinish").value = todayStr();   // 标记看完顺手填日期
    }
    updateSegActive();
  });

  // 评分选择
  $("#showRatingPicker").addEventListener("click", (e) => {
    const b = e.target.closest(".rp-btn");
    if (!b) return;
    const v = b.getAttribute("data-rating");
    state.showDraft.rating = (v === "clear") ? null : Number(v);
    renderRatingPicker(state.showDraft.rating);
  });

  // 剧集标签：删除 / 添加
  $("#showTags").addEventListener("click", (e) => {
    const del = e.target.closest(".tag-del");
    if (!del) return;
    const rm = del.getAttribute("data-tag");
    state.showDraft.tags = state.showDraft.tags.filter((t) => t !== rm);
    renderShowTags();
  });
  $("#showTagInput").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim();
    if (!v) return;
    if (!state.showDraft.tags.includes(v)) state.showDraft.tags.push(v);
    e.target.value = "";
    renderShowTags();
  });

  $("#showSaveBtn").addEventListener("click", () => {
    const rec = collectShowForm();
    if (rec) saveShow(rec);
  });
  $("#showDeleteBtn").addEventListener("click", () => {
    if (state.showCurrentId != null) deleteShow(state.showCurrentId);
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

  // 页面关闭/刷新前：结算当前阅读时长 + 通知服务端"再见"（服务端快速退出）
  window.addEventListener("pagehide", () => {
    const now = Math.floor(Date.now() / 1000);
    if (state.activePath && state.activeSince && now - state.activeSince >= 1) {
      reportReading(state.activePath, state.activeSince, now, true);
    }
    if (navigator.sendBeacon) {
      navigator.sendBeacon("/api/goodbye", new Blob(["bye"], { type: "text/plain" }));
    }
  });

  // 阅读计时兜底：每 60 秒结算一次活跃书籍（页面崩溃时最多丢几十秒）
  setInterval(() => settleActive(Math.floor(Date.now() / 1000)), 60000);

  setBooksCollapsed(state.booksCollapsed);
  wireEvents();
  fetchData();
  state.timer = setInterval(fetchData, 5000);
});
