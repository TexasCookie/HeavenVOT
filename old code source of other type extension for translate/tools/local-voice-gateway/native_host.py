#!/usr/bin/env python3
"""
AetherVox Chrome/Edge Native Messaging host.

Starts / stops / probes the local voice gateway (server.py on :8788).
Protocol: 4-byte little-endian length + UTF-8 JSON on stdin/stdout.
"""

from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "server.py"
PID_FILE = ROOT / ".gateway.pid"
HOST = os.environ.get("AV_GATEWAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("AV_GATEWAY_PORT", "8788"))
HEALTH = f"http://{HOST}:{PORT}/health"


def _read_message() -> dict | None:
    raw_len = sys.stdin.buffer.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    if length <= 0 or length > 1_048_576:
        return None
    data = sys.stdin.buffer.read(length)
    if len(data) < length:
        return None
    try:
        return json.loads(data.decode("utf-8"))
    except json.JSONDecodeError:
        return {"cmd": "__bad_json__"}


def _send_message(msg: dict) -> None:
    encoded = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _health(timeout: float = 1.2) -> dict:
    try:
        with urllib.request.urlopen(HEALTH, timeout=timeout) as res:
            body = res.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = {"ok": res.status == 200, "raw": body[:200]}
            return {"ok": True, "status": res.status, "data": data}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                capture_output=True,
                text=True,
                timeout=5,
                creationflags=subprocess.CREATE_NO_WINDOW,  # type: ignore[attr-defined]
            )
            from gateway_policy import pid_in_tasklist

            return pid_in_tasklist(pid, out.stdout or "")
        except Exception:  # noqa: BLE001
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _read_pid() -> int | None:
    try:
        pid = int(PID_FILE.read_text(encoding="utf-8").strip())
        return pid if _pid_alive(pid) else None
    except Exception:  # noqa: BLE001
        return None


def _write_pid(pid: int) -> None:
    PID_FILE.write_text(str(pid), encoding="utf-8")


def _find_python() -> str:
    # Prefer the interpreter running this host
    return sys.executable or "python"


def cmd_status() -> dict:
    health = _health()
    pid = _read_pid()
    return {
        "ok": True,
        "running": bool(health.get("ok")),
        "pid": pid,
        "health": health,
        "base": f"http://{HOST}:{PORT}/v1",
    }


def cmd_start(wait_s: float = 45.0) -> dict:
    health = _health()
    data = health.get("data") if isinstance(health.get("data"), dict) else {}
    if health.get("ok") and data.get("ok") is True:
        return {
            "ok": True,
            "already": True,
            "running": True,
            "pid": _read_pid(),
            "health": health,
        }
    if health.get("ok") and data.get("ok") is not True:
        return {
            "ok": False,
            "error": "gateway HTTP up but engines not ready",
            "running": True,
            "pid": _read_pid(),
            "health": health,
        }

    if not SERVER.is_file():
        return {"ok": False, "error": f"server.py not found: {SERVER}"}

    py = _find_python()
    creationflags = 0
    if os.name == "nt":
        creationflags = (
            subprocess.DETACHED_PROCESS  # type: ignore[attr-defined]
            | subprocess.CREATE_NEW_PROCESS_GROUP  # type: ignore[attr-defined]
            | subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
        )

    log_path = ROOT / ".gateway.autostart.log"
    log_f = open(log_path, "a", encoding="utf-8")  # noqa: SIM115
    try:
        proc = subprocess.Popen(
            [py, str(SERVER)],
            cwd=str(ROOT),
            stdout=log_f,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
            close_fds=os.name != "nt",
        )
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"spawn failed: {e}"}
    finally:
        try:
            log_f.close()
        except Exception:  # noqa: BLE001
            pass

    _write_pid(proc.pid)
    deadline = time.time() + max(3.0, float(wait_s))
    last = health
    while time.time() < deadline:
        time.sleep(0.4)
        last = _health()
        last_data = last.get("data") if isinstance(last.get("data"), dict) else {}
        if last.get("ok") and last_data.get("ok") is True:
            return {
                "ok": True,
                "started": True,
                "running": True,
                "pid": proc.pid,
                "health": last,
            }
        if proc.poll() is not None:
            return {
                "ok": False,
                "error": "gateway exited before becoming healthy",
                "pid": proc.pid,
                "health": last,
                "log": str(log_path),
            }

    return {
        "ok": False,
        "error": "gateway start timeout — check models / Python deps",
        "pid": proc.pid,
        "health": last,
        "log": str(log_path),
    }


def cmd_stop() -> dict:
    pid = _read_pid()
    stopped = False
    if pid:
        try:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    capture_output=True,
                    timeout=10,
                    creationflags=subprocess.CREATE_NO_WINDOW,  # type: ignore[attr-defined]
                )
            else:
                os.kill(pid, 15)
            stopped = True
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e), "pid": pid}
    try:
        PID_FILE.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "stopped": stopped, "pid": pid}


def main() -> int:
    while True:
        msg = _read_message()
        if msg is None:
            return 0
        cmd = str(msg.get("cmd") or msg.get("type") or "").lower()
        try:
            if cmd == "__bad_json__":
                out = {"ok": False, "error": "invalid native JSON"}
            elif cmd in ("ping", "hello"):
                out = {"ok": True, "pong": True, "root": str(ROOT)}
            elif cmd == "status":
                out = cmd_status()
            elif cmd == "start":
                from gateway_policy import native_wait_sec

                out = cmd_start(wait_s=native_wait_sec(msg.get("waitSec")))
            elif cmd == "stop":
                out = cmd_stop()
            else:
                out = {"ok": False, "error": f"unknown cmd: {cmd}"}
        except Exception as e:  # noqa: BLE001
            out = {"ok": False, "error": str(e)}
        _send_message(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
