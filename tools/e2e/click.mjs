import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
void here;

const URL = process.env.LVT_E2E_URL || "http://127.0.0.1:18766/watch?v=vGUNqq3jVLg";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 });
await page.waitForSelector("#lvt-toggle", { timeout: 10000 });
console.log("before", await page.locator("#lvt-toggle").innerText());
console.log("video", await page.evaluate(() => !!document.querySelector("video.html5-main-video")));
await page.locator("#lvt-toggle").click();
const labels = [];
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(300);
  const t = await page.locator("#lvt-toggle").innerText();
  if (!labels.length || labels[labels.length - 1] !== t) labels.push(t);
  if (t === "Выкл") break;
  if (["нет хоста", "нет дорожки", "ошибка", "нет видео"].includes(t) && i > 2) break;
}
console.log("LABELS", JSON.stringify(labels));
await browser.close();
if (labels[labels.length - 1] !== "Выкл") {
  console.log("FAIL last=" + labels[labels.length - 1]);
  process.exit(1);
}
console.log("PASS");
