@echo off
REM Autostart helper: ensure AetherVox local gateway is up (idempotent).
setlocal
cd /d "%~dp0"

set "PY="
REM Prefer the short-path venv: the repo-local .venv lives under a path so long
REM that onnxruntime/piper fail to load DLLs on Windows.
if exist "%USERPROFILE%\.venv\aethervox-gw\Scripts\python.exe" set "PY=%USERPROFILE%\.venv\aethervox-gw\Scripts\python.exe"
if not defined PY if exist "%~dp0.venv\Scripts\python.exe" set "PY=%~dp0.venv\Scripts\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
if not defined PY set "PY=python"

set "PYW=%PY:python.exe=pythonw.exe%"
if not exist "%PYW%" set "PYW=%PY%"

"%PY%" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8788/health', timeout=1.2)" 1>nul 2>nul
if %ERRORLEVEL%==0 exit /b 0
start "" /B "%PYW%" "%~dp0server.py" 1>>"%~dp0.gateway.autostart.log" 2>&1
exit /b 0
