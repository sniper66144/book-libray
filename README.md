# 📚 书库浏览器 · Book Library Viewer

把本地书库文件夹变成一个可视化网页应用：分类浏览、即时搜索、统计图表、阅读记录、备注标签，文件夹内容增删改后自动同步。

A lightweight local book-library viewer that turns any folder into a browsable web app — categorized browsing, instant fuzzy search, statistics charts, reading history, notes & tags, auto-synced with the filesystem.

纯 Python 标准库实现，**零第三方依赖**，仅绑定本机 `127.0.0.1`。

Pure Python standard library, **zero third-party dependencies**, bound to localhost only.

---

## ✨ 功能特性 Features

| 功能 | 说明 |
|---|---|
| 📂 分类浏览 | 左侧树状浏览系列分类，点击可展开/收起子目录 |
| 🔍 即时搜索 | 下拉式模糊搜索：多关键词（空格分隔）、字符顺序模糊匹配、相关度排序，支持键盘选择 |
| 📖 最近阅读 | 「最近打开」记录 + 「最近修改」近 30 天文件 |
| 📊 统计图表 | 各系列数量、格式分布、近 12 个月新增时间线（手写内联 SVG） |
| 🏷 备注标签 | 每本书可添加标签、写备注，自动保存 |
| 🔄 自动同步 | 每 5 秒扫描一次，新增/删除/修改后页面自动更新 |
| 📄 打开书籍 | 用系统默认应用（如 WPS / Preview / Evince）打开本地文件 |

---

## 🖥 快速开始 Quick Start

要求：**Python 3.8+**，无需安装任何第三方库。

Requirement: **Python 3.8+**, no pip install needed.

```bash
# 方式一：命令行直接指定书库目录（无需配置文件）
# Option 1: pass the library path via command line
python server.py --root "D:/Books"

# 方式二：复制示例配置并填写书库路径
# Option 2: copy the example config and fill in your path
cp config.example.json config.json   # Windows: copy config.example.json config.json
python server.py
```

启动后浏览器自动打开 `http://127.0.0.1:8000`（端口被占用时自动 +1，实际地址见 `data/server.log`）。

浏览器关闭后服务会自动退出（心跳机制，不会残留进程）。

The server opens your browser automatically and exits when the tab closes (heartbeat mechanism, no lingering processes).

---

## ⚙️ 配置 Configuration

书库路径与应用名按以下优先级读取（高 → 低）：

The library path and app name are resolved with this priority (highest → lowest):

1. **命令行参数** CLI args：`--root "路径"`、`--name "应用名"`、`--port 8000`
2. **环境变量** Environment variable：`BOOK_LIBRARY_ROOT`
3. **配置文件** `config.json`（在项目目录下，参考 `config.example.json`）

`config.json` 字段说明：

```json
{
  "root": "C:/path/to/your/books",   // 书库根目录（绝对路径）library root (absolute path)
  "name": "我的书库",                 // 应用名，显示在页面标题与顶栏 app name shown in title & header
  "port": 8000                       // 监听端口 listening port
}
```

> 提示：`config.json` 包含你的本地路径，已被 `.gitignore` 排除，不会提交到版本库。线上仓库仅提供 `config.example.json` 占位示例。
>
> Note: `config.json` holds your local path and is excluded by `.gitignore`. Only `config.example.json` (a placeholder) is committed.

---

## 🌍 跨平台 Cross-Platform

打开书籍时按系统选择默认应用：

- **Windows**：`os.startfile`
- **macOS**：`open`
- **Linux**：`xdg-open`

Windows 下可用 `pythonw.exe` 无窗口后台运行（桌面快捷方式指向 `pythonw server.py` 即可）。

On Windows you can run it windowless via `pythonw.exe` for a background launch.

---

## 📁 数据与文件 Project Layout

```
.
├── server.py             # 后端服务 backend server
├── config.json           # 本地配置（不入仓库）local config (gitignored)
├── config.example.json   # 配置示例 config example
├── start.bat             # Windows 双击启动 launch script (Windows)
├── LICENSE
├── README.md
├── assets/book.ico       # 快捷方式图标 shortcut icon
└── static/               # 前端页面 front-end (HTML/CSS/JS)
    ├── index.html
    ├── app.js
    └── style.css
```

运行时自动生成 `data/` 目录（阅读记录、标签、备注、日志），由 `.gitignore` 排除，**不会进入版本库**。

The `data/` directory (reading history, notes, logs) is auto-generated and gitignored.

---

## ❓ 常见问题 FAQ

- **点击书籍提示"打开失败"**：云盘文件若尚未下载到本地（仅云端占位），可能无法直接打开，请先在客户端中下载到本机。  
  *Can't open a book? Cloud-synced files not yet downloaded locally may fail — download them first.*
- **「最近修改」不准确**：文件"修改日期"仅在内容变化时更新，阅读不改变它；「最近打开」更贴近真实阅读行为。
- **端口被占用**：服务会自动 +1 尝试，最终地址见 `data/server.log`。
- **换书库目录**：修改 `config.json` 的 `root`，或直接用 `--root` 参数。

---

## 📄 开源协议 License

[MIT](LICENSE) · © 2026 ltzhp1130

本项目基于 MIT 协议开源，欢迎自由使用、修改与分发（请保留版权声明）。

Open source under the MIT License — free to use, modify and distribute with attribution.
