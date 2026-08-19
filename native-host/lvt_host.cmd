@echo off
setlocal
set PYTHONPATH=%~dp0
set PY=%~dp0..\.venv\Scripts\python.exe
if not exist "%PY%" set PY=python
set "PATH=%~dp0..\.venv\Lib\site-packages\nvidia\cublas\bin;%~dp0..\.venv\Lib\site-packages\nvidia\cudnn\bin;%~dp0..\.venv\Lib\site-packages\nvidia\cuda_nvrtc\bin;%PATH%"
"%PY%" -m lvt_host
