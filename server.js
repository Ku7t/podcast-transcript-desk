const { createServer } = require("node:http");
const { spawn } = require("node:child_process");
const { createWriteStream, promises: fs } = require("node:fs");
const { basename, extname, join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

require("dotenv").config();

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (resource, options) => {
  try {
    return await nativeFetch(resource, options);
  } catch (error) {
    throw statusError(`${inferFetchStage(resource)}: ${fetchFailureMessage(error)}`, 502);
  }
};

const PREFERRED_PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const TOOLS_BIN = join(ROOT, ".tools", "bin");
const MAX_AUDIO_BYTES = Number(process.env.MAX_AUDIO_BYTES || 500 * 1024 * 1024);
const TRANSCRIPTION_PROVIDER = (process.env.TRANSCRIPTION_PROVIDER || "siliconflow").toLowerCase();
const SUMMARY_PROVIDER = (process.env.SUMMARY_PROVIDER || "siliconflow").toLowerCase();
const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || process.env.TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
const OPENAI_SUMMARY_MODEL = process.env.OPENAI_SUMMARY_MODEL || process.env.SUMMARY_MODEL || "gpt-4.1-mini";
const SILICONFLOW_TRANSCRIPTION_MODEL = process.env.SILICONFLOW_TRANSCRIPTION_MODEL || process.env.TRANSCRIPTION_MODEL || "FunAudioLLM/SenseVoiceSmall";
const SILICONFLOW_SUMMARY_MODEL = process.env.SILICONFLOW_SUMMARY_MODEL || process.env.SUMMARY_MODEL || "Qwen/Qwen3.5-4B";
const SPEAKER_LABEL_MODEL = process.env.SPEAKER_LABEL_MODEL || SILICONFLOW_SUMMARY_MODEL;
const ENABLE_SPEAKER_LABELING = process.env.ENABLE_SPEAKER_LABELING !== "false";
const SILICONFLOW_API_BASE = process.env.SILICONFLOW_API_BASE || "https://api.siliconflow.cn/v1";
const TRANSCRIBE_LIMIT = Number(process.env.TRANSCRIBE_LIMIT || (TRANSCRIPTION_PROVIDER === "siliconflow" ? 15 * 1024 * 1024 : 24 * 1024 * 1024));
const CHUNK_SECONDS = Number(process.env.CHUNK_SECONDS || (TRANSCRIPTION_PROVIDER === "siliconflow" ? 900 : 3300));
const NORMALIZE_TRANSCRIPTION_AUDIO = process.env.NORMALIZE_TRANSCRIPTION_AUDIO !== "false";
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 30 * 60 * 1000);
const YTDLP_SOCKET_TIMEOUT_SECONDS = Number(process.env.YTDLP_SOCKET_TIMEOUT_SECONDS || 30);
const YTDLP_RETRIES = Number(process.env.YTDLP_RETRIES || 10);
const YTDLP_IMPERSONATE = process.env.YTDLP_IMPERSONATE || "chrome";
const TRANSCRIPTION_API_MAX_ATTEMPTS = Number(process.env.TRANSCRIPTION_API_MAX_ATTEMPTS || 3);
const TRANSCRIPTION_API_RETRY_DELAY_MS = Number(process.env.TRANSCRIPTION_API_RETRY_DELAY_MS || 1500);
const TEMP_CLEANUP_MAX_RETRIES = 8;
const TEMP_CLEANUP_RETRY_DELAY_MS = 250;
const FFMPEG_STATIC = optionalRequire("ffmpeg-static");
const FFMPEG_STATIC_EXE = join(ROOT, "node_modules", "ffmpeg-static", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/tools") return sendJson(res, 200, await toolStatus());
    if (req.method === "POST" && req.url === "/api/transcribe") {
      const body = await readJson(req);
      return sendJson(res, 200, await transcribePodcast(body));
    }
    if (req.method === "GET") return serveStatic(req, res);
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: friendlyError(error) });
  }
});

listenWithFallback(server, PREFERRED_PORT);

async function transcribePodcast({ url, preferYtdlp = true, keepTranscriptStyle = true }) {
  assertProviderKeys();
  validateUrl(url);
  const workDir = await fs.mkdtemp(join(tmpdir(), "podcast-transcript-"));
  try {
    const audio = await resolveAndDownloadAudio(url, workDir, preferYtdlp);
    const chunks = await prepareChunks(audio.path, workDir);
    const parts = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const part = await transcribeAudio(chunks[index], keepTranscriptStyle, index + 1, chunks.length);
      if (part.trim()) parts.push(part.trim());
    }
    const rawTranscript = parts.join("\n\n").trim();
    if (!rawTranscript) throw statusError(`No speech was detected in the downloaded audio. Model: ${transcriptionModelLabel()}. Check that the episode contains audible speech.`, 422);
    const summaryResult = await summarizeTranscriptSafely(rawTranscript);
    const speakerResult = ENABLE_SPEAKER_LABELING
      ? await labelSpeakersSafely(rawTranscript)
      : { transcript: rawTranscript, warning: "Speaker labeling is disabled." };
    const transcript = speakerResult.transcript;
    return {
      sourceUrl: url,
      audioUrl: audio.audioUrl,
      transcript,
      summary: summaryResult.summary,
      warnings: [summaryResult.warning, speakerResult.warning].filter(Boolean),
      tools: await toolStatus(),
      models: {
        transcription: transcriptionModelLabel(),
        summary: summaryModelLabel(),
        speakerLabeling: ENABLE_SPEAKER_LABELING ? `siliconflow:${SPEAKER_LABEL_MODEL}` : "disabled",
      },
    };
  } finally {
    await cleanupWorkDir(workDir);
  }
}

async function resolveAndDownloadAudio(url, workDir, preferYtdlp) {
  const ytdlp = await findTool("yt-dlp");
  const forceYtdlp = isKnownPlatformPage(url);
  if ((preferYtdlp || forceYtdlp) && ytdlp) {
    try {
      const output = join(workDir, "episode.%(ext)s");
      await run(ytdlp, [
        "--no-playlist",
        "--no-update",
        "--impersonate", YTDLP_IMPERSONATE,
        "--socket-timeout", String(YTDLP_SOCKET_TIMEOUT_SECONDS),
        "--retries", String(YTDLP_RETRIES),
        "--fragment-retries", "3",
        "--extractor-retries", "5",
        "--retry-sleep", "http:exp=1:10",
        "-x",
        "--audio-format", "mp3",
        "-o", output,
        url,
      ], YTDLP_TIMEOUT_MS);
      const audioFile = (await fs.readdir(workDir)).find((file) => /^episode\./.test(file));
      if (audioFile) return { path: join(workDir, audioFile), audioUrl: "yt-dlp:" + url };
    } catch (error) {
      if (forceYtdlp) throw statusError(`yt-dlp failed for this platform page: ${error.message || String(error)}`, 400);
    }
  }

  const audioUrl = await discoverAudioUrl(url);
  const path = join(workDir, safeAudioName(audioUrl));
  await downloadFile(audioUrl, path);
  return { path, audioUrl };
}

function isKnownPlatformPage(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.includes("xiaoyuzhoufm.com") || host.includes("apple.com") || host.includes("ximalaya.com");
  } catch {
    return false;
  }
}

async function discoverAudioUrl(url) {
  const response = await fetchWithStage(url, { redirect: "follow" }, `podcast page fetch failed: ${url}`);
  if (!response.ok) throw statusError(`Link is not reachable: HTTP ${response.status}`, 400);
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("audio/") || /\.(mp3|m4a|aac|wav|ogg)(\?|$)/i.test(url)) return url;

  const text = await response.text();
  const enclosure = matchFirst(text, /<enclosure[^>]+url=["']([^"']+)["'][^>]*>/i);
  const ogAudio = matchFirst(text, /<meta[^>]+property=["']og:audio(?::url)?["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  const audioTag = matchFirst(text, /<audio[^>]+src=["']([^"']+)["']/i) || matchFirst(text, /<source[^>]+src=["']([^"']+)["'][^>]*type=["']audio\/[^"']+["']/i);
  const discovered = enclosure || ogAudio || audioTag;
  if (!discovered) throw statusError("No audio URL was found in the page or RSS feed. Try again with yt-dlp.", 400);
  return new URL(decodeHtml(discovered), url).toString();
}

async function downloadFile(url, path) {
  const response = await fetchWithStage(url, { redirect: "follow" }, `audio download request failed: ${url}`);
  if (!response.ok) throw statusError(`Audio download failed: HTTP ${response.status}`, 400);

  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_AUDIO_BYTES) throw statusError("Audio file is too large. Increase MAX_AUDIO_BYTES or use a shorter episode.", 400);

  let received = 0;
  const guard = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > MAX_AUDIO_BYTES) throw new Error("Audio file exceeded MAX_AUDIO_BYTES.");
      controller.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body.pipeThrough(guard)), createWriteStream(path));
}

async function prepareChunks(audioPath, workDir) {
  const stat = await fs.stat(audioPath);
  const shouldNormalize = TRANSCRIPTION_PROVIDER === "siliconflow" && NORMALIZE_TRANSCRIPTION_AUDIO;
  if (stat.size <= TRANSCRIBE_LIMIT && !shouldNormalize) return [audioPath];

  const ffmpeg = await findTool("ffmpeg");
  if (!ffmpeg) {
    if (stat.size <= TRANSCRIBE_LIMIT) return [audioPath];
    const status = await toolStatus();
    throw statusError(`Audio is larger than the upload limit, but ffmpeg was not found. Run npm run tools:check and restart npm start. Tool status: ${JSON.stringify(status)}`, 400);
  }

  const chunkPattern = join(workDir, "chunk-%03d.mp3");
  await run(ffmpeg, [
    "-y",
    "-i",
    audioPath,
    "-f",
    "segment",
    "-segment_time",
    String(CHUNK_SECONDS),
    "-vn",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "64k",
    chunkPattern,
  ], 20 * 60 * 1000);

  const files = (await fs.readdir(workDir))
    .filter((file) => /^chunk-\d+\.mp3$/.test(file))
    .sort()
    .map((file) => join(workDir, file));
  if (!files.length) throw statusError("ffmpeg did not produce audio chunks.", 500);
  return files;
}

async function transcribeAudio(filePath, keepTranscriptStyle, index, total) {
  if (TRANSCRIPTION_PROVIDER === "openai") return transcribeWithOpenAI(filePath, keepTranscriptStyle, index, total);
  return transcribeWithSiliconFlow(filePath);
}

async function transcribeWithSiliconFlow(filePath) {
  const buffer = await fs.readFile(filePath);
  const response = await fetchMultipartWithRetry(
    `${SILICONFLOW_API_BASE}/audio/transcriptions`,
    () => {
      const data = new FormData();
      data.append("file", new Blob([buffer]), basename(filePath));
      data.append("model", SILICONFLOW_TRANSCRIPTION_MODEL);
      return data;
    },
    { Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}` },
    "audio transcription API request failed",
  );
  if (!response.ok) throw statusError(await responseErrorMessage("SiliconFlow transcription API failed", response), 502);
  const payload = await response.json();
  const text = extractTranscriptionText(payload);
  if (text === null) {
    const traceId = response.headers.get("x-siliconcloud-trace-id");
    const traceSuffix = traceId ? ` Trace ID: ${traceId}.` : "";
    throw statusError(`SiliconFlow transcription API returned an unexpected response: ${compactPayload(payload)}${traceSuffix}`, 502);
  }
  return text.trim();
}

async function transcribeWithOpenAI(filePath, keepTranscriptStyle, index, total) {
  const buffer = await fs.readFile(filePath);
  const response = await fetchMultipartWithRetry(
    "https://api.openai.com/v1/audio/transcriptions",
    () => {
      const data = new FormData();
      data.append("file", new Blob([buffer]), basename(filePath));
      data.append("model", OPENAI_TRANSCRIPTION_MODEL);
      data.append("language", "zh");
      data.append("response_format", "text");
      data.append("prompt", keepTranscriptStyle
        ? `This is podcast audio chunk ${index}/${total}. Transcribe it fully. Preserve spoken style and add Chinese punctuation where helpful.`
        : `This is podcast audio chunk ${index}/${total}. Transcribe it fully into clear Chinese text and add punctuation where helpful.`);
      return data;
    },
    { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    "audio transcription API request failed",
  );
  if (!response.ok) throw statusError(await responseErrorMessage("OpenAI transcription API failed", response), 502);
  return response.text();
}

async function summarizeTranscriptSafely(transcript) {
  try {
    return { summary: await summarizeTranscript(transcript), warning: "" };
  } catch (error) {
    return {
      summary: `摘要生成失败：${error.message || "unknown error"}`,
      warning: `Summary skipped: ${error.message || "unknown error"}`,
    };
  }
}


async function summarizeTranscript(transcript) {
  const trimmed = transcript.length > 55000
    ? transcript.slice(0, 55000) + "\n\n[Transcript is very long. Summary is based on the first 55000 characters.]"
    : transcript;
  const messages = cleanSummaryMessages(trimmed);
  if (SUMMARY_PROVIDER === "openai") return summarizeWithOpenAI(messages);
  return summarizeWithSiliconFlow(messages);
}

async function labelSpeakersSafely(transcript) {
  try {
    return { transcript: await labelSpeakers(transcript), warning: "" };
  } catch (error) {
    return {
      transcript,
      warning: `Speaker labeling skipped: ${error.message || "unknown error"}`,
    };
  }
}


async function labelSpeakers(transcript) {
  if (!transcript || transcript.length < 200) return transcript;
  if (!process.env.SILICONFLOW_API_KEY) return transcript;

  const chunks = splitText(transcript, 5000);
  const labeled = [];
  let speakerMap = "";
  for (let index = 0; index < chunks.length; index += 1) {
    const result = await labelSpeakerChunk(chunks[index], speakerMap, index + 1, chunks.length);
    labeled.push(result.text);
    if (result.map) speakerMap = result.map;
  }
  return labeled.join("\n\n").trim();
}

async function labelSpeakerChunk(text, speakerMap, index, total) {
  const messages = [
    {
      role: "system",
      content: "You edit podcast transcripts. Add speaker labels to each dialogue turn. Do not summarize. Do not delete content.",
    },
    {
      role: "user",
      content: `Task:
Rewrite the transcript into speaker-labeled dialogue. Every paragraph or dialogue turn must start with a speaker label, like "澶х寷锛?.

Rules:
- Infer names from self-introductions, host introductions, direct address, and context.
- If a real name is uncertain, use "璇磋瘽浜篈", "璇磋瘽浜築", etc.
- Keep labels consistent across chunks using the known mapping.
- Preserve the original meaning and order.
- Split long monologues into natural dialogue turns when the speaker changes.
- Do not output unlabeled paragraphs.
- Return only the labeled transcript, no notes, no markdown fences.

Known speaker mapping:
${speakerMap || "None yet."}

Chunk ${index}/${total}:
${text}`,
    },
  ];
  const response = await fetch(`${SILICONFLOW_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: SPEAKER_LABEL_MODEL,
      messages,
      stream: false,
      enable_thinking: false,
      temperature: 0.1,
      top_p: 0.8,
      max_tokens: 6000,
    }),
  });
  if (!response.ok) throw statusError(`Speaker labeling API failed: ${await response.text()}`, 502);
  const payload = await response.json();
  const labeledText = payload.choices?.[0]?.message?.content?.trim();
  if (!labeledText) throw statusError("Speaker labeling API returned no content.", 502);
  return { text: labeledText, map: extractSpeakerMap(labeledText, speakerMap) };
}

function extractSpeakerMap(text, previous) {
  const names = [...text.matchAll(/^([^\uFF1A:\n]{1,16})[\uFF1A:]/gm)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  const unique = [...new Set(names)].slice(0, 12);
  if (!unique.length) return previous;
  return unique.map((name, index) => `${String.fromCharCode(65 + index)}=${name}`).join("\n");
}

function splitText(text, maxChars) {
  const chunks = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf("\u3002", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function cleanSummaryMessages(transcript) {
  return [
    {
      role: "system",
      content: "You are a podcast editor. Summarize accurately in concise Simplified Chinese.",
    },
    {
      role: "user",
      content: `Summarize this podcast in Simplified Chinese. Use this exact structure:
## One-sentence summary
One sentence explaining the topic.

## Main points
- 3 to 6 bullet points

## Worth noting
- 2 to 4 insights, debates, or action suggestions

Transcript:
${transcript}`,
    },
  ];
}


async function summarizeWithSiliconFlow(messages) {
  const response = await fetch(`${SILICONFLOW_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SILICONFLOW_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: SILICONFLOW_SUMMARY_MODEL,
      messages,
      stream: false,
      enable_thinking: false,
      temperature: 0.3,
      top_p: 0.8,
      max_tokens: 1800,
    }),
  });
  if (!response.ok) throw statusError(`SiliconFlow summary API failed: ${await response.text()}`, 502);
  const payload = await response.json();
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw statusError("SiliconFlow summary API returned no content.", 502);
  return content.trim();
}

async function summarizeWithOpenAI(messages) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_SUMMARY_MODEL,
      input: messages,
    }),
  });
  if (!response.ok) throw statusError(`OpenAI summary API failed: ${await response.text()}`, 502);
  const payload = await response.json();
  const content = payload.output_text || payload.output?.flatMap((item) => item.content || []).map((item) => item.text || "").join("\n").trim();
  if (!content) throw statusError("OpenAI summary API returned no content.", 502);
  return content;
}

async function serveStatic(req, res) {
  const port = server.address()?.port || PREFERRED_PORT;
  const url = new URL(req.url, `http://${HOST}:${port}`);
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const fullPath = resolve(ROOT, file);
  if (!fullPath.startsWith(resolve(ROOT))) return sendJson(res, 403, { error: "Forbidden" });
  try {
    const content = await fs.readFile(fullPath);
    res.writeHead(200, { "Content-Type": contentType(fullPath) });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function readJson(req) {
  return new Promise((resolveJson, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(statusError("Request body is too large.", 413));
    });
    req.on("end", () => {
      try {
        resolveJson(JSON.parse(body || "{}"));
      } catch {
        reject(statusError("Request body must be valid JSON.", 400));
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json;charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function listenWithFallback(httpServer, port, attemptsLeft = 20) {
  httpServer.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use. Trying ${nextPort}...`);
      listenWithFallback(httpServer, nextPort, attemptsLeft - 1);
      return;
    }
    throw error;
  });
  httpServer.listen(port, HOST, () => {
    const actualPort = httpServer.address().port;
    console.log(`Podcast transcript desk running at http://${HOST}:${actualPort}`);
  });
}

function assertProviderKeys() {
  if (TRANSCRIPTION_PROVIDER === "siliconflow" && !process.env.SILICONFLOW_API_KEY) throw statusError("Set SILICONFLOW_API_KEY before transcribing with SiliconFlow.", 400);
  if (SUMMARY_PROVIDER === "siliconflow" && !process.env.SILICONFLOW_API_KEY) throw statusError("Set SILICONFLOW_API_KEY before summarizing with SiliconFlow.", 400);
  if (TRANSCRIPTION_PROVIDER === "openai" && !process.env.OPENAI_API_KEY) throw statusError("Set OPENAI_API_KEY before transcribing with OpenAI.", 400);
  if (SUMMARY_PROVIDER === "openai" && !process.env.OPENAI_API_KEY) throw statusError("Set OPENAI_API_KEY before summarizing with OpenAI.", 400);
}

function transcriptionModelLabel() {
  if (TRANSCRIPTION_PROVIDER === "openai") return `openai:${OPENAI_TRANSCRIPTION_MODEL}`;
  return `siliconflow:${SILICONFLOW_TRANSCRIPTION_MODEL}`;
}

function summaryModelLabel() {
  if (SUMMARY_PROVIDER === "openai") return `openai:${OPENAI_SUMMARY_MODEL}`;
  return `siliconflow:${SILICONFLOW_SUMMARY_MODEL}`;
}

function validateUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("bad protocol");
  } catch {
    throw statusError("Enter a valid http or https URL.", 400);
  }
}

async function toolStatus() {
  const ytdlp = await findTool("yt-dlp");
  const ffmpeg = await findTool("ffmpeg");
  return {
    ytdlp: ytdlp || null,
    ffmpeg: ffmpeg || null,
    toolsDir: TOOLS_BIN,
  };
}

async function findTool(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const local = join(TOOLS_BIN, exe);
  if (await executableWorks(name, local)) return local;
  if (name === "ffmpeg" && FFMPEG_STATIC && await executableWorks(name, FFMPEG_STATIC)) return FFMPEG_STATIC;
  if (name === "ffmpeg" && await executableWorks(name, FFMPEG_STATIC_EXE)) return FFMPEG_STATIC_EXE;
  if (await executableWorks(name, name)) return name;
  return null;
}

function optionalRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

function executableWorks(toolName, command) {
  return new Promise((resolveWorks) => {
    const versionArgs = toolName === "ffmpeg" ? ["-version"] : ["--version"];
    const child = spawn(command, versionArgs, { stdio: "ignore", shell: false });
    child.on("error", () => resolveWorks(false));
    child.on("close", (code) => resolveWorks(code === 0));
  });
}

function run(command, args, timeoutMs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child).finally(() => {
        if (settled) return;
        settled = true;
        rejectRun(statusError(`${basename(command)} timed out.`, 504));
      });
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (timedOut || settled) return;
      clearTimeout(timeout);
      settled = true;
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut || settled) return;
      settled = true;
      if (code === 0) resolveRun();
      else rejectRun(statusError(`${basename(command)} failed: ${stderr.slice(-1200)}`, 500));
    });
  });
}

async function cleanupWorkDir(workDir) {
  try {
    await fs.rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: TEMP_CLEANUP_MAX_RETRIES,
      retryDelay: TEMP_CLEANUP_RETRY_DELAY_MS,
    });
  } catch (error) {
    console.warn(`Temporary directory cleanup deferred for ${workDir}: ${error.message || String(error)}`);
    const retry = setTimeout(() => {
      fs.rm(workDir, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 500,
      }).catch((retryError) => {
        console.warn(`Temporary directory cleanup failed for ${workDir}: ${retryError.message || String(retryError)}`);
      });
    }, 3000);
    retry.unref?.();
  }
}

function terminateProcessTree(child) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  if (process.platform !== "win32" || !child.pid) {
    child.kill();
    return Promise.resolve();
  }

  return new Promise((resolveTerminate) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const finish = () => resolveTerminate();
    killer.once("error", () => {
      child.kill();
      finish();
    });
    killer.once("close", finish);
  });
}

function matchFirst(text, regex) {
  return text.match(regex)?.[1];
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function safeAudioName(url) {
  const name = basename(new URL(url).pathname) || "episode.mp3";
  const ext = extname(name) || ".mp3";
  return "episode" + ext.replace(/[^.\w-]/g, "");
}

function contentType(path) {
  if (path.endsWith(".html")) return "text/html;charset=utf-8";
  if (path.endsWith(".css")) return "text/css;charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript;charset=utf-8";
  return "application/octet-stream";
}

async function responseErrorMessage(prefix, response) {
  const body = (await response.text().catch(() => "")).trim();
  const status = `HTTP ${response.status}${response.statusText ? " " + response.statusText : ""}`;
  return `${prefix}: ${status}${body ? " - " + body : " - empty response body"}`;
}

function extractTranscriptionText(payload) {
  if (typeof payload === "string") return payload;
  if (typeof payload?.text === "string") return payload.text;
  if (typeof payload?.data?.text === "string") return payload.data.text;
  return null;
}

function compactPayload(payload) {
  try {
    return JSON.stringify(payload).slice(0, 500);
  } catch {
    return "[unserializable response]";
  }
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function fetchMultipartWithRetry(resource, createBody, headers, stage) {
  let lastError;
  for (let attempt = 1; attempt <= TRANSCRIPTION_API_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await nativeFetch(resource, {
        method: "POST",
        headers,
        body: createBody(),
      });
      if (attempt < TRANSCRIPTION_API_MAX_ATTEMPTS && isRetryableResponse(response.status)) {
        await response.arrayBuffer().catch(() => {});
        console.warn(`${stage}: upstream returned HTTP ${response.status}; retrying (${attempt}/${TRANSCRIPTION_API_MAX_ATTEMPTS})`);
        await waitBeforeRetry(response, attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= TRANSCRIPTION_API_MAX_ATTEMPTS || !isRetryableNetworkError(error)) {
        throw statusError(`${stage}: ${fetchFailureMessage(error)}`, 502);
      }
      console.warn(`${stage}: ${fetchFailureMessage(error)}; retrying (${attempt}/${TRANSCRIPTION_API_MAX_ATTEMPTS})`);
      await waitBeforeRetry(null, attempt);
    }
  }
  throw statusError(`${stage}: ${fetchFailureMessage(lastError)}`, 502);
}

function isRetryableResponse(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableNetworkError(error) {
  const code = error?.cause?.code || error?.code || "";
  const message = `${code} ${error?.cause?.message || error?.message || ""}`;
  return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]
    .some((candidate) => code === candidate || message.includes(candidate));
}

async function waitBeforeRetry(response, attempt) {
  const retryAfter = Number(response?.headers?.get("retry-after"));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0;
  const backoffMs = TRANSCRIPTION_API_RETRY_DELAY_MS * (2 ** (attempt - 1));
  await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(retryAfterMs, backoffMs)));
}

async function fetchWithStage(resource, options, stage) {
  try {
    return await nativeFetch(resource, options);
  } catch (error) {
    throw statusError(`${stage}: ${fetchFailureMessage(error)}`, 502);
  }
}

function inferFetchStage(resource) {
  const target = String(resource?.url || resource || "");
  if (target.includes("/audio/transcriptions")) return "audio transcription API request failed";
  if (target.includes("/chat/completions")) return "SiliconFlow chat API request failed";
  if (target.includes("api.openai.com")) return "OpenAI API request failed";
  return `network request failed for ${target || "unknown target"}`;
}

function fetchFailureMessage(error) {
  return error?.cause?.message || error?.message || "fetch failed";
}
function friendlyError(error) {
  return error.message || "Unknown error";
}








