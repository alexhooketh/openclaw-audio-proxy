import http from "node:http";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Busboy from "busboy";

const PORT = Number.parseInt(process.env.OPENCLAW_AUDIO_PROXY_PORT || "18793", 10);
const BIND = process.env.OPENCLAW_AUDIO_PROXY_BIND || "127.0.0.1";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_BASE_URL = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const TRANSCRIBE_MODEL = process.env.OPENCLAW_AUDIO_PROXY_MODEL || "openai/gpt-audio-mini";

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: { message: "Not found" } });
}

function methodNotAllowed(res) {
  json(res, 405, { error: { message: "Method not allowed" } });
}

function inferFormat(mime, filename) {
  const name = (filename || "").toLowerCase();
  const m = (mime || "").toLowerCase();
  if (m.includes("wav") || name.endsWith(".wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3") || name.endsWith(".mp3")) return "mp3";
  if (m.includes("ogg") || name.endsWith(".ogg") || name.endsWith(".oga")) return "ogg";
  if (m.includes("flac") || name.endsWith(".flac")) return "flac";
  if (m.includes("m4a") || m.includes("mp4") || name.endsWith(".m4a")) return "m4a";
  if (m.includes("aac") || name.endsWith(".aac")) return "aac";
  if (m.includes("opus") || name.endsWith(".opus")) return "opus";
  return "wav";
}

async function transcodeToWavIfNeeded(buf, format) {
  // In practice Telegram voice notes are OGG container with Opus audio.
  // Many providers are pickier about formats; WAV (PCM16) is the safest.
  if (format === "wav") {
    return { buf, format: "wav" };
  }

  const id = crypto.randomBytes(8).toString("hex");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-audio-${id}-`));
  const inPath = path.join(dir, `in.${format || "bin"}`);
  const outPath = path.join(dir, "out.wav");

  try {
    await fs.writeFile(inPath, buf);

    await new Promise((resolve, reject) => {
      const p = spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          inPath,
          "-ac",
          "1",
          "-ar",
          "16000",
          "-f",
          "wav",
          outPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );

      let err = "";
      p.stderr.on("data", (d) => {
        err += d.toString("utf8");
      });

      p.on("error", reject);
      p.on("close", (code) => {
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg failed (code ${code}): ${err.trim() || "unknown"}`));
      });
    });

    const wavBuf = await fs.readFile(outPath);
    return { buf: wavBuf, format: "wav" };
  } finally {
    // Best-effort cleanup.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function callOpenRouter({ audioBase64, format, promptText }) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set in environment");
  }

  const body = {
    model: TRANSCRIBE_MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              promptText ||
              "Transcribe the audio verbatim. Preserve punctuation. Do not add commentary. Output only the transcript.",
          },
          {
            type: "input_audio",
            // OpenAI-compatible schema expects snake_case.
            input_audio: { data: audioBase64, format },
          },
        ],
      },
    ],
  };

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "http-referer": "https://openclaw.ai",
      "x-title": "OpenClaw Audio Proxy",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenRouter error (HTTP ${res.status}): ${text || res.statusText}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("OpenRouter response missing transcript text");
  }
  return content.trim();
}

function handleTranscription(req, res) {
  // OpenAI-compatible multipart endpoint.
  const ct = String(req.headers["content-type"] || "");
  if (!ct.toLowerCase().includes("multipart/form-data")) {
    return json(res, 400, { error: { message: "Expected multipart/form-data" } });
  }
  const bb = Busboy({ headers: req.headers, limits: { files: 1 } });

  let fileBufs = [];
  let fileName = "audio";
  let mime = "application/octet-stream";
  let prompt = "";

  bb.on("file", (_name, file, info) => {
    fileName = info.filename || fileName;
    mime = info.mimeType || mime;
    file.on("data", (d) => fileBufs.push(d));
  });

  bb.on("field", (name, val) => {
    if (name === "prompt") prompt = val;
    // We ignore `model` on purpose; OpenClaw will send something like gpt-4o-mini-transcribe.
  });

  bb.on("error", (err) => {
    json(res, 400, { error: { message: `Bad multipart: ${err.message}` } });
  });

  bb.on("finish", async () => {
    try {
      const buf = Buffer.concat(fileBufs);
      if (!buf.length) {
        return json(res, 400, { error: { message: "Missing audio file" } });
      }
      const detected = inferFormat(mime, fileName);
      const { buf: wavBuf, format } = await transcodeToWavIfNeeded(buf, detected);
      const audioBase64 = wavBuf.toString("base64");
      const transcript = await callOpenRouter({
        audioBase64,
        format,
        promptText: prompt,
      });
      // OpenAI-style response
      return json(res, 200, { text: transcript });
    } catch (e) {
      return json(res, 500, { error: { message: String(e?.message || e) } });
    }
  });

  req.pipe(bb);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      model: TRANSCRIBE_MODEL,
      baseUrl: OPENROUTER_BASE_URL,
      hasKey: Boolean(OPENROUTER_API_KEY),
    });
  }

  const isTranscribePath =
    (req.method === "POST" && url.pathname === "/audio/transcriptions") ||
    (req.method === "POST" && url.pathname === "/v1/audio/transcriptions");

  if (isTranscribePath) {
    return handleTranscription(req, res);
  }

  if (req.method !== "GET" && req.method !== "POST") {
    return methodNotAllowed(res);
  }

  return notFound(res);
});

server.listen(PORT, BIND, () => {
  // eslint-disable-next-line no-console
  console.log(`openrouter-audio-proxy listening on http://${BIND}:${PORT}`);
});
