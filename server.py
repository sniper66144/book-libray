# -*- coding: utf-8 -*-
"""
书库浏览器 · 本地网页可视化应用 —— 后端服务
纯 Python 标准库实现，零第三方依赖。

功能：
  - 递归扫描书库目录，构建系列树与统计信息
  - 提供 /api/books 数据接口，前端轮询实现自动同步
  - 提供 /api/open 用系统默认应用打开书籍，并记录打开历史
  - 提供 /api/note 保存/更新书籍的标签与备注
  - 支持 pythonw 无窗口后台运行：日志写入 data/server.log
  - 心跳 + 再见信号：浏览器关闭后服务自动退出，端口被占用自动 +1
  - 书库路径与应用名可配置：命令行参数 / 环境变量 / config.json
"""
import json
import os
import subprocess
import sys
import threading
import time
import webbrowser
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.path.join(BASE_DIR, "data")
DATA_FILE = os.path.join(DATA_DIR, "library.json")
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

HOST = "127.0.0.1"
PORT = 8000
ENV_ROOT = "BOOK_LIBRARY_ROOT"

# 运行期配置，由 load_config() 填充：
#   root —— 书库根目录（绝对路径）
#   name —— 应用名（显示在页面标题与顶栏）
#   port —— 监听端口
CONFIG = {"root": None, "name": "我的书库", "port": PORT}


def load_config():
    """加载配置。优先级：命令行 > 环境变量 > config.json > 默认值。
    返回配置 dict（调用方需用它更新全局 CONFIG）。"""
    cfg = dict(CONFIG)

    # 1) 本地 config.json（含个人路径，被 .gitignore 排除，不入仓库）
    if os.path.isfile(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                file_cfg = json.load(f)
            if isinstance(file_cfg.get("root"), str) and file_cfg["root"].strip():
                cfg["root"] = file_cfg["root"].strip()
            if isinstance(file_cfg.get("name"), str) and file_cfg["name"].strip():
                cfg["name"] = file_cfg["name"].strip()
            if isinstance(file_cfg.get("port"), int):
                cfg["port"] = file_cfg["port"]
        except (OSError, ValueError):
            pass  # 配置损坏时忽略，退回其他来源

    # 2) 环境变量
    env_root = os.environ.get(ENV_ROOT, "").strip()
    if env_root:
        cfg["root"] = env_root

    # 3) 命令行参数
    argv = sys.argv[1:]
    for i, arg in enumerate(argv):
        if arg == "--root" and i + 1 < len(argv) and argv[i + 1].strip():
            cfg["root"] = argv[i + 1].strip()
        elif arg == "--name" and i + 1 < len(argv) and argv[i + 1].strip():
            cfg["name"] = argv[i + 1].strip()
        elif arg == "--port" and i + 1 < len(argv):
            try:
                cfg["port"] = int(argv[i + 1])
            except ValueError:
                pass

    if cfg["root"]:
        cfg["root"] = os.path.abspath(cfg["root"])
    return cfg

# 认可的书籍格式（小写）
BOOK_EXTS = {"pdf", "epub", "docx", "doc", "txt", "mobi", "azw3", "djvu"}
# "最近修改" 时间窗口（天）
RECENT_DAYS = 30
# 每本书最多保留的打开记录条数
MAX_OPEN_PER_BOOK = 50
# 阅读时长：session 保留窗口（天）与每本最多条数
READING_KEEP_DAYS = 120
READING_MAX_SESSIONS = 200

# 统一用 "/" 作为 JSON 中的相对路径分隔符
SEP = "/"

# 心跳机制：页面存活则定期更新 last_heartbeat；
# 超时说明浏览器已关闭，服务自动退出（避免 pythonw 无窗口运行时残留进程）
HEARTBEAT_TIMEOUT = 120     # 秒，兜底：无 goodbye 时心跳超时判定浏览器已关闭
MONITOR_INTERVAL = 10       # 监控线程检查间隔（秒）
GOODBYE_DELAY = 30          # 收到"浏览器关闭"信号后的快速退出延迟（秒）
last_heartbeat = time.time()
exit_at = None              # 收到 goodbye 后设定的退出时刻；收到新心跳则取消

LOG_FILE = os.path.join(DATA_DIR, "server.log")


def log(msg):
    """写日志到 data/server.log，并尽量输出到控制台（pythonw 无控制台时静默）。"""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}\n")
    except Exception:
        pass
    try:
        if sys.stdout:
            print(msg)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 数据持久化：阅读记录 / 标签 / 备注
# ---------------------------------------------------------------------------
def load_data():
    """读取本地数据文件；不存在或损坏时返回空结构。"""
    empty = {"history": {}, "notes": {}, "reading": {}, "shows": {}}
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        data.setdefault("history", {})
        data.setdefault("notes", {})
        data.setdefault("reading", {})
        # 追剧记录（手动清单，不依赖书库文件）；历史脏数据兜底复位
        data.setdefault("shows", {})
        if not isinstance(data["shows"], dict):
            data["shows"] = {}
        return data
    except (OSError, ValueError):
        return empty


def save_data(data):
    """写入本地数据文件（原子写入，避免半截文件）。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = DATA_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DATA_FILE)


# ---------------------------------------------------------------------------
# 追剧记录：手动清单的增删改辅助（存储于 library.json 顶层 "shows"）
# ---------------------------------------------------------------------------
SHOW_STATUSES = {"want", "watching", "done"}


def next_show_id(shows):
    """为新增剧集分配自增 id（现存最大数字 key + 1），返回字符串。"""
    max_id = 0
    for k in shows:
        try:
            max_id = max(max_id, int(k))
        except (TypeError, ValueError):
            continue
    return str(max_id + 1)


def _clean_show(body, cur=None):
    """
    把前端提交的剧集字段规范化成统一 record。
    cur 为 update 时该记录的当前值，用于字段缺省/非法时回退。
    """
    cur = cur or {}

    def _pick_str(key, limit):
        """取值：优先 body 中的 str（去除首尾空白并限长），否则沿用 cur 的 str。"""
        v = body.get(key)
        if isinstance(v, str):
            return v.strip()[:limit]
        cv = cur.get(key)
        return cv[:limit] if isinstance(cv, str) else ""

    def _pick_int(key):
        """取值：body 中是 int 则 >= 0，否则沿用 cur 的整数（缺省 0）。"""
        v = body.get(key)
        if isinstance(v, bool):
            v = None
        if isinstance(v, int):
            return max(0, v)
        cv = cur.get(key)
        return max(0, int(cv)) if isinstance(cv, int) else 0

    out = {}
    # 剧名（必填校验由调用方处理）
    name = body.get("name")
    out["name"] = name.strip() if isinstance(name, str) else cur.get("name", "")
    # 状态：限定三值，否则沿用当前/默认想看
    status = body.get("status", "")
    out["status"] = status if status in SHOW_STATUSES else cur.get("status", "want")
    # 进度：整数 >= 0，未知/未填为 0
    out["episode"] = _pick_int("episode")
    out["total"] = _pick_int("total")
    # 日期：仅收 str 并限长，对齐 <input type=date> 的 YYYY-MM-DD
    out["startDate"] = _pick_str("startDate", 10)
    out["finishDate"] = _pick_str("finishDate", 10)
    # 备注 / 标签
    out["note"] = _pick_str("note", 5000)
    tags = body.get("tags")
    if isinstance(tags, list):
        out["tags"] = [str(t) for t in tags if isinstance(t, str)][:50]
    else:
        out["tags"] = list(cur.get("tags", []) or [])
    # 评分：null 未评，否则 0-10 整数，越界/非法归 None
    rating = body.get("rating")
    if rating is None:
        out["rating"] = cur.get("rating")
    elif isinstance(rating, bool):
        out["rating"] = None
    elif isinstance(rating, int):
        out["rating"] = rating if 0 <= rating <= 10 else None
    else:
        try:
            r = int(rating)
            out["rating"] = r if 0 <= r <= 10 else None
        except (TypeError, ValueError):
            out["rating"] = None
    return out


# ---------------------------------------------------------------------------
# 目录扫描与统计
# ---------------------------------------------------------------------------
def norm(rel_path):
    """将本机分隔符路径转换为 JSON 中统一的 "/" 相对路径。"""
    return rel_path.replace(os.sep, SEP)


def is_book(filename):
    """是否可识别的书籍文件。"""
    ext = os.path.splitext(filename)[1].lstrip(".").lower()
    return ext in BOOK_EXTS


def make_file_node(full_path, rel_path):
    """构造单个书籍文件节点。"""
    name = os.path.basename(full_path)
    ext = os.path.splitext(name)[1].lstrip(".").lower()
    st = os.stat(full_path)
    return {
        "name": name,
        "title": os.path.splitext(name)[0],
        "path": norm(rel_path),
        "type": "file",
        "ext": ext,
        "size": st.st_size,
        "mtime": int(st.st_mtime),
    }


def scan_dir(abs_dir, rel_dir):
    """
    递归扫描一个目录，返回 (children, count, size)。
    children 为 dir/file 混合节点列表，dir 节点带嵌套 children。
    """
    children = []
    count = 0
    size = 0
    try:
        entries = sorted(os.listdir(abs_dir), key=str.lower)
    except OSError:
        return children, count, size

    for entry in entries:
        full = os.path.join(abs_dir, entry)
        rel = os.path.join(rel_dir, entry)
        try:
            if os.path.isdir(full):
                sub_children, sub_count, sub_size = scan_dir(full, rel)
                if sub_count == 0:
                    continue  # 空目录（无书籍）不展示
                children.append({
                    "name": entry,
                    "path": norm(rel),
                    "type": "dir",
                    "count": sub_count,
                    "size": sub_size,
                    "children": sub_children,
                })
                count += sub_count
                size += sub_size
            elif is_book(entry):
                node = make_file_node(full, rel)
                children.append(node)
                count += 1
                size += node["size"]
        except OSError:
            continue  # 权限/占位文件异常时跳过单个条目
    return children, count, size


def collect_files(nodes, bucket):
    """把系列树中所有文件节点展平收集到 bucket 列表。"""
    for node in nodes:
        if node["type"] == "file":
            bucket.append(node)
        else:
            collect_files(node["children"], bucket)


def build_stats(nodes, standalone):
    """基于系列树与散书计算统计信息。"""
    all_books = []
    collect_files(nodes, all_books)
    all_books.extend(standalone)

    total_size = sum(b["size"] for b in all_books)

    # 格式分布
    fmt_map = {}
    for b in all_books:
        e = fmt_map.setdefault(b["ext"], {"ext": b["ext"], "count": 0, "size": 0})
        e["count"] += 1
        e["size"] += b["size"]
    formats = sorted(fmt_map.values(), key=lambda x: -x["count"])

    # 新增时间线：按修改月份统计（近 12 个月 + 更早）
    now = datetime.now()
    month_map = {}
    for b in all_books:
        d = datetime.fromtimestamp(b["mtime"])
        key = d.strftime("%Y-%m")
        month_map.setdefault(key, {"month": key, "count": 0, "size": 0, "titles": []})
        month_map[key]["count"] += 1
        month_map[key]["size"] += b["size"]
        month_map[key]["titles"].append(b["title"])
    timeline = []
    for offset in range(11, -1, -1):
        key = (now - timedelta(days=30 * offset)).strftime("%Y-%m")
        if key in month_map:
            timeline.append(month_map[key])
        else:
            timeline.append({"month": key, "count": 0, "size": 0, "titles": []})
    earlier = {k: v for k, v in month_map.items() if k not in {t["month"] for t in timeline}}
    if earlier:
        earlier_count = sum(v["count"] for v in earlier.values())
        earlier_size = sum(v["size"] for v in earlier.values())
        timeline.insert(0, {"month": "更早", "count": earlier_count, "size": earlier_size, "titles": []})

    # 各系列统计（顶层目录）
    series_stats = [
        {"name": n["name"], "path": n["path"], "count": n["count"], "size": n["size"]}
        for n in nodes
    ]

    # 最近修改（按 mtime 排序，取前 20）
    all_books.sort(key=lambda x: x["mtime"], reverse=True)
    cutoff = now - timedelta(days=RECENT_DAYS)
    recently_modified = []
    for b in all_books:
        d = datetime.fromtimestamp(b["mtime"])
        recently_modified.append({
            "name": b["name"],
            "title": b["title"],
            "path": b["path"],
            "ext": b["ext"],
            "size": b["size"],
            "mtime": b["mtime"],
            "daysAgo": int((now - d).total_seconds() // 86400),
            "inRecent": d >= cutoff,
        })
        if len(recently_modified) >= 20:
            break

    return {
        "totalBooks": len(all_books),
        "totalSize": total_size,
        "seriesCount": len(series_stats),
        "formats": formats,
        "seriesStats": series_stats,
        "timeline": timeline,
        "recentlyModified": recently_modified,
    }


def scan():
    """完整扫描一次书库，返回前端所需数据。"""
    children, _, _ = scan_dir(CONFIG["root"], "")
    series = [n for n in children if n["type"] == "dir"]
    standalone = [n for n in children if n["type"] == "file"]
    stats = build_stats(series, standalone)

    # 合并阅读记录与备注，仅保留仍存在的书籍
    data = load_data()
    history = []
    for rel, stamps in data.get("history", {}).items():
        if not safe_path(rel) or not stamps:
            continue
        history.append({
            "path": rel,
            "title": file_display_name(rel),
            "opens": len(stamps),
            "lastOpened": stamps[-1],
        })
    history.sort(key=lambda h: h["lastOpened"], reverse=True)

    notes = {}
    for rel, entry in data.get("notes", {}).items():
        if safe_path(rel):
            notes[rel] = entry

    # 阅读时长：每本累计 + 近 7/30 天，及总量（供前端统计卡片 / 详情 / 列表展示）
    now_ts = time.time()
    reading = {}
    total_reading = 0
    recent7_total = 0
    recent30_total = 0
    for rel, entry in data.get("reading", {}).items():
        if not safe_path(rel):
            continue
        sessions = entry.get("sessions") or []
        seconds = int(entry.get("seconds", 0) or 0)
        r7 = sum(e - s for s, e in sessions if e >= now_ts - 7 * 86400)
        r30 = sum(e - s for s, e in sessions if e >= now_ts - 30 * 86400)
        reading[rel] = {"seconds": seconds, "recent7": r7, "recent30": r30}
        total_reading += seconds
        recent7_total += r7
        recent30_total += r30
    stats["readingSeconds"] = total_reading
    stats["readingRecent7"] = recent7_total
    stats["readingRecent30"] = recent30_total

    return {
        "root": CONFIG["root"],
        "name": CONFIG["name"],
        "series": series,
        "standalone": standalone,
        "stats": stats,
        "history": history,
        "notes": notes,
        "reading": reading,
        "shows": data.get("shows", {}),
    }


# ---------------------------------------------------------------------------
# 路径安全校验
# ---------------------------------------------------------------------------
def safe_path(rel_path):
    """校验相对路径位于书库根目录内，返回绝对路径；非法时返回 None。"""
    if not rel_path:
        return None
    rel = rel_path.replace(SEP, os.sep)
    root = os.path.realpath(CONFIG["root"])
    full = os.path.realpath(os.path.join(CONFIG["root"], rel))
    if full != root and not full.startswith(root + os.sep):
        return None
    if not os.path.isfile(full):
        return None
    return full


def open_with_default_app(full_path):
    """用系统默认应用打开文件，跨平台兼容。"""
    if sys.platform.startswith("win"):
        os.startfile(full_path)
    elif sys.platform == "darwin":
        subprocess.run(["open", full_path], check=False)
    else:
        subprocess.run(["xdg-open", full_path], check=False)


def file_display_name(rel_path):
    """根据相对路径取书名（不含扩展名），用于历史记录展示。"""
    return os.path.splitext(os.path.basename(rel_path.replace(SEP, os.sep)))[0]


# ---------------------------------------------------------------------------
# HTTP 处理
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "BookLibrary/1.0"

    def _send(self, code, body_bytes, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body_bytes)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body_bytes)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/heartbeat":
            global last_heartbeat, exit_at
            last_heartbeat = time.time()
            exit_at = None       # 页面存活，取消快速退出
            self._json({"ok": True})
            return
        if path == "/api/health":
            self._json({"ok": True})
            return
        if path == "/api/books":
            self._json(scan())
            return
        # 静态文件
        if path == "/":
            rel = "index.html"
        elif path.startswith("/static/"):
            rel = path[len("/static/"):]
        else:
            self._json({"error": "not found"}, 404)
            return
        full = os.path.realpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(os.path.realpath(STATIC_DIR) + os.sep) or not os.path.isfile(full):
            self._json({"error": "not found"}, 404)
            return
        ctype = "text/html; charset=utf-8"
        if rel.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        elif rel.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/goodbye":
            # 页面正常关闭时收到此信号，开始快速退出倒计时（新心跳会取消）
            global exit_at
            if exit_at is None:
                exit_at = time.time() + GOODBYE_DELAY
            self._json({"ok": True})
            return
        if parsed.path == "/api/open":
            body = self._read_json()
            rel = body.get("path", "")
            full = safe_path(rel)
            if not full:
                self._json({"ok": False, "error": "路径无效或书籍不存在"}, 400)
                return
            try:
                open_with_default_app(full)
            except OSError as e:
                self._json({"ok": False, "error": f"打开失败：{e}"}, 500)
                return
            # 记录打开历史
            data = load_data()
            hist = data["history"].setdefault(rel, [])
            hist.append(int(time.time()))
            del hist[:-MAX_OPEN_PER_BOOK]
            save_data(data)
            self._json({"ok": True})
            return
        if parsed.path == "/api/reading":
            body = self._read_json()
            rel = body.get("path", "")
            if not safe_path(rel):
                self._json({"ok": False, "error": "路径无效或书籍不存在"}, 400)
                return
            try:
                start = int(body.get("start", 0))
                end = int(body.get("end", 0))
            except (TypeError, ValueError):
                self._json({"ok": False, "error": "时间参数无效"}, 400)
                return
            delta = end - start
            if not (0 < delta <= 86400):
                # 异常的时长（0 / 负 / 超一天）忽略，不记录也不报错
                self._json({"ok": True})
                return
            data = load_data()
            entry = data["reading"].setdefault(rel, {"seconds": 0, "sessions": []})
            entry["seconds"] = int(entry.get("seconds", 0) or 0) + delta
            sessions = entry.get("sessions") or []
            sessions.append([start, end])
            cutoff = time.time() - READING_KEEP_DAYS * 86400
            sessions = [s for s in sessions if s[1] >= cutoff]
            del sessions[:-READING_MAX_SESSIONS]
            entry["sessions"] = sessions
            save_data(data)
            self._json({"ok": True})
            return
        if parsed.path == "/api/note":
            body = self._read_json()
            rel = body.get("path", "")
            if not safe_path(rel):
                self._json({"ok": False, "error": "路径无效或书籍不存在"}, 400)
                return
            data = load_data()
            entry = data["notes"].setdefault(rel, {"tags": [], "note": ""})
            if isinstance(body.get("tags"), list):
                entry["tags"] = [t for t in body["tags"] if isinstance(t, str)]
            if isinstance(body.get("note"), str):
                entry["note"] = body["note"]
            if isinstance(body.get("finished"), bool):
                entry["finished"] = body["finished"]
            save_data(data)
            self._json({"ok": True})
            return
        if parsed.path == "/api/shows":
            # 追剧记录（手动清单）：add 新增 / update 更新 / delete 删除
            body = self._read_json()
            action = body.get("action", "")
            data = load_data()
            shows = data.setdefault("shows", {})
            if action == "add":
                record = _clean_show(body)
                if not record["name"]:
                    self._json({"ok": False, "error": "剧名不能为空"}, 400)
                    return
                sid = next_show_id(shows)
                record["id"] = sid
                shows[sid] = record
                save_data(data)
                self._json({"ok": True, "record": record})
                return
            if action in ("update", "delete"):
                sid = str(body.get("id", ""))
                if sid not in shows:
                    self._json({"ok": False, "error": "剧集不存在"}, 400)
                    return
                if action == "delete":
                    del shows[sid]
                    save_data(data)
                    self._json({"ok": True, "id": sid})
                    return
                record = _clean_show(body, cur=shows[sid])
                record["id"] = sid
                shows[sid] = record
                save_data(data)
                self._json({"ok": True, "record": record})
                return
            self._json({"ok": False, "error": "未知操作"}, 400)
            return
        self._json({"error": "not found"}, 404)

    def log_message(self, fmt, *args):
        """精简访问日志，仅记录 API 调用（pythonw 无控制台时静默）。"""
        if self.path.startswith("/api/"):
            msg = "[%s] %s\n" % (self.log_date_time_string(), fmt % args)
            try:
                if sys.stdout:
                    sys.stdout.write(msg)
            except Exception:
                pass


def _heartbeat_monitor():
    """后台监控：
    - 收到 goodbye（页面正常关闭）→ GOODBYE_DELAY 秒后快速退出
    - 无 goodbye（页面崩溃/强杀）→ 心跳超时 HEARTBEAT_TIMEOUT 兜底退出
    os._exit 直接终止整个进程（含所有线程），由 OS 释放端口。"""
    while True:
        time.sleep(MONITOR_INTERVAL)
        now = time.time()
        if exit_at is not None:
            if now >= exit_at:
                log("收到浏览器关闭信号，服务快速退出")
                os._exit(0)
            continue
        if now - last_heartbeat > HEARTBEAT_TIMEOUT:
            log(f"心跳超时（{HEARTBEAT_TIMEOUT}s），判定浏览器已关闭，服务自动退出")
            os._exit(0)


def main():
    # 控制台 UTF-8，中文不乱码（pythonw 下 stdout 为 None 时跳过）
    try:
        if sys.stdout:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    # 加载配置：命令行 > 环境变量 > config.json > 默认值
    CONFIG.update(load_config())

    if not CONFIG["root"]:
        log("[配置] 未指定书库目录。请通过以下任一方式配置：")
        log("  1) 命令行：python server.py --root \"书库路径\"")
        log(f"  2) 环境变量：set {ENV_ROOT}=书库路径")
        log("  3) 配置文件：在项目目录创建 config.json（参考 config.example.json）")
        sys.exit(1)

    if not os.path.isdir(CONFIG["root"]):
        log(f"[错误] 书库目录不存在：{CONFIG['root']}")
        sys.exit(1)
    os.makedirs(DATA_DIR, exist_ok=True)

    # 启动服务：端口占用自动 +1（避免上一个实例残留导致无法启动）
    server = None
    port = CONFIG["port"]
    for _ in range(20):
        try:
            server = ThreadingHTTPServer((HOST, port), Handler)
            break
        except OSError:
            port += 1
    if server is None:
        log("错误：无法绑定端口，请检查占用。")
        return

    url = f"http://{HOST}:{port}"
    log("=" * 46)
    log(f"  {CONFIG['name']} 已启动（无窗口后台运行）")
    log(f"  访问地址：{url}")
    log("  书库目录：" + CONFIG["root"])
    log("  关闭浏览器后服务将自动退出。")
    log("=" * 46)

    # 心跳监控线程：浏览器关闭后自动退出，避免残留进程
    threading.Thread(target=_heartbeat_monitor, daemon=True).start()

    # 自动打开默认浏览器（延迟一点，等服务就绪）
    threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
