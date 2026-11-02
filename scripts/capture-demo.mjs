import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const root = new URL("..", import.meta.url).pathname;
const data = join("/tmp", "school-pulse-capture");
const frames = join("/tmp", "pulse-frames");
rmSync(data, { recursive: true, force: true });
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
mkdirSync(join(root, "screenshots"), { recursive: true });

const child = spawn(
  "node",
  ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "src/cli.ts", "demo", "--data", data, "--port", "4173"],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);

let log = "";
child.stdout.on("data", (chunk) => {
  log += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

const started = Date.now();
while (!log.includes("listening http://127.0.0.1:4173") && Date.now() - started < 20000) {
  await delay(100);
}
if (!log.includes("listening http://127.0.0.1:4173")) {
  child.kill("SIGTERM");
  throw new Error(`demo did not start\n${log}`);
}
await delay(300);

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.innerText.includes("Student A") && document.body.innerText.includes("91"));

async function shot(name) {
  const path = join(frames, name);
  await page.screenshot({ path, type: "png" });
  return path;
}

await shot("01.png");
await delay(400);
await shot("02.png");
await shot("03.png");

copyFileSync(join(data, "examples", "powerschool-update.json"), join(data, "inbox", "powerschool", "powerschool-update.json"));
await page.waitForFunction(() => document.body.innerText.includes("Math 7 went from 91 to 84"), { timeout: 10000 });
await delay(250);
await shot("04.png");
await delay(350);
await shot("05.png");
await shot("06.png");

await page.screenshot({ path: join(root, "screenshots", "overview.png"), type: "png" });
await page.keyboard.press("t");
await delay(200);
await page.screenshot({ path: join(root, "screenshots", "overview-dark.png"), type: "png" });
await page.keyboard.press("t");
await page.setViewport({ width: 375, height: 812, deviceScaleFactor: 2 });
await delay(200);
await page.screenshot({ path: join(root, "screenshots", "phone.png"), type: "png" });
await browser.close();
child.kill("SIGTERM");
await delay(200);

const { spawn: spawnGif } = await import("node:child_process");
await new Promise((resolve, reject) => {
  const ffmpeg = spawnGif("ffmpeg", [
    "-y",
    "-framerate",
    "2",
    "-i",
    join(frames, "%02d.png"),
    "-vf",
    "fps=2,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse",
    join(root, "screenshots", "demo.gif"),
  ], { stdio: "inherit" });
  ffmpeg.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
});
console.log("wrote screenshots/demo.gif");
