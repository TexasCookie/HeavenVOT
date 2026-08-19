import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXT_ID = "jmommfeoeeajjaekfgbknapfnibehgac"


def test_host_allow_list_matches_stable_extension_id():
    root_manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    nested = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    host = json.loads((ROOT / "native-host" / "com.lvt.host.json").read_text(encoding="utf-8"))
    assert root_manifest["manifest_version"] == 3
    assert root_manifest["key"] == nested["key"]
    assert root_manifest["background"]["service_worker"] == "extension/background.js"
    assert (ROOT / root_manifest["background"]["service_worker"]).is_file()
    assert (ROOT / root_manifest["action"]["default_popup"]).is_file()
    for block in root_manifest["content_scripts"]:
        for rel in block["js"]:
            assert (ROOT / rel).is_file()
    early = root_manifest["content_scripts"][0]
    assert early.get("world") == "MAIN"
    assert early.get("run_at") == "document_start"
    assert any(str(item).endswith("session-hook.js") for item in early["js"])
    assert f"chrome-extension://{EXT_ID}/" in host["allowed_origins"]
    assert host["type"] == "stdio"
    assert host["name"] == "com.lvt.host"
    assert "nativeMessaging" in root_manifest["permissions"]
    assert "http://127.0.0.1/*" in root_manifest["host_permissions"]


def test_watch_only_content_script():
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    matches = manifest["content_scripts"][0]["matches"]
    assert any("youtube.com" in item for item in matches)
    assert (ROOT / "native-host" / "lvt_host.cmd").is_file()
    assert (ROOT / "native-host" / "register.ps1").is_file()
    assert (ROOT / "extension" / "background.js").is_file()
    assert (ROOT / "extension" / "content.js").is_file()
