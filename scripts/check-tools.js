const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const ytdlp = join(root, ".tools", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
const ffmpeg = require("ffmpeg-static");

check("yt-dlp", ytdlp, ["--version"]);
check("ffmpeg", ffmpeg, ["-version"]);

function check(name, command, args) {
  if (!command || !existsSync(command)) {
    console.error(`${name}: missing`);
    process.exitCode = 1;
    return;
  }
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`${name}: failed`);
    console.error(result.stderr || result.stdout);
    process.exitCode = 1;
    return;
  }
  console.log(`${name}: ${firstLine(result.stdout).trim()}`);
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/)[0] || "ok";
}
