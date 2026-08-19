@echo off
setlocal
set PYTHONPATH=%~dp0
set PY=%~dp0..\.venv\Scripts\python.exe
if not exist "%PY%" set PY=python
set LVT_PORT=17890
set LVT_STANDALONE=1
set "PATH=%~dp0..\.venv\Lib\site-packages\nvidia\cublas\bin;%~dp0..\.venv\Lib\site-packages\nvidia\cudnn\bin;%~dp0..\.venv\Lib\site-packages\nvidia\cuda_nvrtc\bin;%PATH%"
"%PY%" -m lvt_host --standalone
