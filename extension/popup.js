const lang = document.getElementById("lang");
const gain = document.getElementById("gain");
const waitFull = document.getElementById("waitFull");
const status = document.getElementById("status");

function persist() {
  const settings = {
    targetLang: lang.value,
    originalGain: Number(gain.value) / 100,
    playMode: waitFull && waitFull.checked ? "full" : "ready",
  };
  chrome.storage.local.set({ lvtSettings: settings });
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "lvt-settings", settings: settings });
    }
  });
}

chrome.storage.local.get(["lvtSettings", "lvtStatus"], (stored) => {
  if (stored.lvtSettings) {
    lang.value = stored.lvtSettings.targetLang || "ru";
    gain.value = String(Math.round((stored.lvtSettings.originalGain ?? 0.25) * 100));
    if (waitFull) waitFull.checked = stored.lvtSettings.playMode === "full";
  }
  if (stored.lvtStatus) {
    if (stored.lvtStatus.error) status.textContent = stored.lvtStatus.error;
    else if (stored.lvtStatus.host === "up") status.textContent = "хост запущен";
  }
});

chrome.runtime.sendMessage({ type: "lvt-status" }, (reply) => {
  if (!reply || !reply.httpBase) status.textContent = reply && reply.error ? reply.error : "нет хоста";
  else status.textContent = "хост запущен";
});

lang.addEventListener("change", persist);
gain.addEventListener("input", persist);
if (waitFull) waitFull.addEventListener("change", persist);

const go = document.getElementById("go");
if (go) {
  go.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: "lvt-toggle" }, () => {
        void chrome.runtime.lastError;
      });
    });
  });
}
