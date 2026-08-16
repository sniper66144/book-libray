@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
echo ==============================
echo    📚 书库浏览器 · 正在启动
echo ==============================
python server.py
if errorlevel 1 (
  echo.
  echo [提示] 启动失败，请确认已安装 Python 并已加入系统 PATH。
)
pause
