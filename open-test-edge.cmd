@echo off
set EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
set EXT=I:\my-files\my-browser-extensions\my-new-browser-translate-extension
set PROFILE=C:\Users\Daniil\AppData\Local\Temp\grok-goal-91821e0f377e\implementer\edge-profile
if not exist "%PROFILE%" mkdir "%PROFILE%"
start "" "%EDGE%" --user-data-dir="%PROFILE%" --disable-features=DisableLoadExtensionCommandLineSwitch --load-extension="%EXT%" --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check --new-window "https://www.youtube.com/watch?v=vGUNqq3jVLg"
