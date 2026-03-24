#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import TelegramBot from "node-telegram-bot-api";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "/tmp/telegram-mcp";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const EXTRA_ALLOWED_FILE_ROOTS = (process.env.ALLOWED_FILE_ROOTS || "")
  .split(",")
  .map((root) => root.trim())
  .filter(Boolean);

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error("TELEGRAM_TOKEN and CHAT_ID env vars required");
  process.exit(1);
}

const chatId = CHAT_ID;

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true, mode: 0o700 });
}

const WORKSPACE_ROOT = fs.realpathSync.native(process.cwd());
const DOWNLOAD_ROOT = fs.realpathSync.native(DOWNLOAD_DIR);
const SAFE_READ_ROOTS = Array.from(new Set([
  WORKSPACE_ROOT,
  DOWNLOAD_ROOT,
  ...EXTRA_ALLOWED_FILE_ROOTS.map((root) => {
    try {
      return fs.realpathSync.native(root);
    } catch {
      return path.resolve(root);
    }
  }),
]));

// --- Types ---

interface IncomingMessage {
  text: string;
  from: string;
  date: number;
  type: "text" | "photo" | "video" | "voice" | "audio" | "document" | "sticker" | "location" | "contact";
  filePath?: string;
  fileName?: string;
  caption?: string;
  mimeType?: string;
  fileSize?: number;
  location?: { latitude: number; longitude: number };
  contact?: { phone: string; firstName: string; lastName?: string };
}

interface CallbackData { id: string; data: string; from: string; messageId: number }

// --- State ---

const messageQueue: IncomingMessage[] = [];
const callbackQueue: CallbackData[] = [];
let callbackResolver: ((cb: CallbackData) => void) | null = null;
let waitingResolver: ((msg: IncomingMessage) => void) | null = null;
let mcpReady = false;
let lastSentMessageId: number | null = null;

// --- Bot ---

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
bot.on("polling_error", () => {});

// --- Helpers ---

async function downloadFile(fileId: string, suggestedName?: string): Promise<{ localPath: string; fileName: string }> {
  const file = await bot.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) throw new Error(`Telegram did not return a file path for ${fileId}`);
  const ext = path.extname(filePath) || "";
  const safeName = sanitizeDownloadFileName(suggestedName || `${fileId}${ext}`);
  const fileName = `${Date.now()}_${safeName}`;
  const localPath = path.join(DOWNLOAD_ROOT, fileName);
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram download failed with HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buffer, { mode: 0o600 });
  return { localPath, fileName };
}

function cleanupFile(filePath: string) {
  try {
    const resolvedPath = path.resolve(filePath);
    if (isWithinRoot(resolvedPath, DOWNLOAD_ROOT) && fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);
  } catch {}
}

function cleanupDir(dirPath: string) {
  try {
    const resolvedPath = path.resolve(dirPath);
    if (isWithinRoot(resolvedPath, DOWNLOAD_ROOT) && fs.existsSync(resolvedPath)) {
      fs.rmSync(resolvedPath, { recursive: true, force: true });
    }
  } catch {}
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatForTelegram(text: string): string {
  let formatted = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return `<pre><code${cls}>${escapeHtml(code.trimEnd())}</code></pre>`;
  });
  formatted = formatted.replace(/`([^`]+)`/g, (_match, code) => `<code>${escapeHtml(code)}</code>`);
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  formatted = formatted.replace(/(?<![<\/\w])\*([^*]+)\*(?![>])/g, "<i>$1</i>");
  return formatted;
}

function sanitizeDownloadFileName(fileName: string): string {
  const baseName = fileName.split(/[\\/]/).pop() || "file";
  const sanitized = baseName
    .replace(/[\u0000-\u001f<>:"|?*]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return sanitized || "file";
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function ensureAbsoluteExistingFile(filePath: string): string {
  if (!path.isAbsolute(filePath)) throw new Error("File path must be absolute.");
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const resolvedPath = fs.realpathSync.native(filePath);
  if (!fs.statSync(resolvedPath).isFile()) throw new Error(`Not a file: ${resolvedPath}`);
  return resolvedPath;
}

function ensureReadableFilePath(filePath: string): string {
  const resolvedPath = ensureAbsoluteExistingFile(filePath);
  if (!SAFE_READ_ROOTS.some((rootPath) => isWithinRoot(resolvedPath, rootPath))) {
    throw new Error(`File path must be inside one of: ${SAFE_READ_ROOTS.join(", ")}`);
  }
  return resolvedPath;
}

function ensureManagedDownloadFilePath(filePath: string): string {
  const resolvedPath = ensureAbsoluteExistingFile(filePath);
  if (!isWithinRoot(resolvedPath, DOWNLOAD_ROOT)) {
    throw new Error(`File path must be inside managed download directory: ${DOWNLOAD_ROOT}`);
  }
  return resolvedPath;
}

function runCommand(command: string, args: string[], timeout: number): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(stderr || `${command} exited with code ${result.status}`);
  }

  return result.stdout || "";
}

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"];
const VIDEO_EXTS = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
const CONFUSING_EXTS = [".ts"]; // Telegram treats .ts as MPEG Transport Stream

// --- Message Processing ---

async function processMessage(msg: TelegramBot.Message): Promise<IncomingMessage> {
  const from = msg.from?.first_name || msg.from?.username || "User";
  const date = msg.date;
  const caption = msg.caption;

  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    const { localPath, fileName } = await downloadFile(largest.file_id, `photo_${date}.jpg`);
    return { text: caption || "[Photo]", from, date, type: "photo", filePath: localPath, fileName, caption, fileSize: largest.file_size };
  }
  if (msg.video) {
    const vidName = (msg.video as any).file_name || `video_${date}.mp4`;
    const { localPath, fileName } = await downloadFile(msg.video.file_id, vidName);
    return { text: caption || "[Video]", from, date, type: "video", filePath: localPath, fileName, caption, mimeType: msg.video.mime_type, fileSize: msg.video.file_size };
  }
  if (msg.voice) {
    const { localPath, fileName } = await downloadFile(msg.voice.file_id, `voice_${date}.ogg`);
    return { text: "[Voice message]", from, date, type: "voice", filePath: localPath, fileName, mimeType: msg.voice.mime_type, fileSize: msg.voice.file_size };
  }
  if (msg.audio) {
    const audioName = (msg.audio as any).file_name || `audio_${date}.mp3`;
    const { localPath, fileName } = await downloadFile(msg.audio.file_id, audioName);
    return { text: caption || `[Audio: ${msg.audio.title || fileName}]`, from, date, type: "audio", filePath: localPath, fileName, caption, mimeType: msg.audio.mime_type, fileSize: msg.audio.file_size };
  }
  if (msg.document) {
    const { localPath, fileName } = await downloadFile(msg.document.file_id, msg.document.file_name || `doc_${date}`);
    return { text: caption || `[Document: ${fileName}]`, from, date, type: "document", filePath: localPath, fileName, caption, mimeType: msg.document.mime_type, fileSize: msg.document.file_size };
  }
  if (msg.sticker) {
    return { text: `[Sticker: ${msg.sticker.emoji || ""} ${msg.sticker.set_name || ""}]`, from, date, type: "sticker" };
  }
  if (msg.location) {
    return { text: `[Location: ${msg.location.latitude}, ${msg.location.longitude}]`, from, date, type: "location", location: msg.location };
  }
  if (msg.contact) {
    return { text: `[Contact: ${msg.contact.first_name} ${msg.contact.last_name || ""} - ${msg.contact.phone_number}]`, from, date, type: "contact", contact: { phone: msg.contact.phone_number, firstName: msg.contact.first_name, lastName: msg.contact.last_name } };
  }
  return { text: msg.text || "[empty message]", from, date, type: "text" };
}

function formatMessage(msg: IncomingMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    from: msg.from, type: msg.type, message: msg.text,
    timestamp: new Date(msg.date * 1000).toISOString(),
  };
  if (msg.filePath) result.filePath = msg.filePath;
  if (msg.fileName) result.fileName = msg.fileName;
  if (msg.caption) result.caption = msg.caption;
  if (msg.mimeType) result.mimeType = msg.mimeType;
  if (msg.fileSize) result.fileSize = msg.fileSize;
  if (msg.location) result.location = msg.location;
  if (msg.contact) result.contact = msg.contact;
  return result;
}

function formatReturnContent(msg: IncomingMessage): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
  const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
    { type: "text", text: JSON.stringify(formatMessage(msg)) },
  ];
  if (msg.filePath && (msg.type === "photo" || msg.type === "sticker")) {
    try {
      const imageData = fs.readFileSync(msg.filePath);
      content.push({ type: "image", data: imageData.toString("base64"), mimeType: msg.type === "photo" ? "image/jpeg" : "image/webp" });
    } catch {}
  }
  return content;
}

// --- Event Listeners ---

bot.on("message", async (msg) => {
  if (msg.chat.id.toString() !== chatId) return;
  try {
    const incoming = await processMessage(msg);
    if (waitingResolver) {
      const resolve = waitingResolver;
      waitingResolver = null;
      resolve(incoming);
    } else {
      messageQueue.push(incoming);
      if (mcpReady) {
        const preview = incoming.type === "text"
          ? incoming.text.slice(0, 100)
          : `[${incoming.type}] ${incoming.caption || incoming.text}`.slice(0, 100);
        server.sendLoggingMessage({ level: "warning", logger: "telegram", data: `New Telegram ${incoming.type} from ${incoming.from}: "${preview}". Call check_messages to read it.` }).catch(() => {});
      }
    }
  } catch {
    const fallback: IncomingMessage = {
      text: msg.text || msg.caption || `[${msg.photo ? "photo" : msg.video ? "video" : "media"} - download failed]`,
      from: msg.from?.first_name || msg.from?.username || "User", date: msg.date, type: "text",
    };
    if (waitingResolver) { const resolve = waitingResolver; waitingResolver = null; resolve(fallback); }
    else messageQueue.push(fallback);
  }
});

bot.on("callback_query", async (query) => {
  if (!query.message || query.message.chat.id.toString() !== chatId) return;
  const cb: CallbackData = {
    id: query.id, data: query.data || "",
    from: query.from.first_name || query.from.username || "User",
    messageId: query.message.message_id,
  };
  await bot.answerCallbackQuery(query.id).catch(() => {});
  if (callbackResolver) { const resolve = callbackResolver; callbackResolver = null; resolve(cb); }
  else callbackQueue.push(cb);
});

// --- MCP Server ---

const server = new McpServer({ name: "telegram-chat-mcp", version: "3.1.0" });

const STOP_WORDS = ["/done", "/stop", "/back", "/desk"];

// TOOL: send_message
server.tool(
  "send_message",
  "Send a message to the user on Telegram. Supports markdown-style formatting: ```code blocks```, `inline code`, **bold**, *italic*. Returns the message_id which can be used with edit_message or reply_to.",
  {
    message: z.string().describe("The message text to send. Use ```lang for code blocks, `backticks` for inline code."),
    reply_to: z.number().optional().describe("Message ID to reply to (threads the conversation)"),
    buttons: z.array(z.array(z.object({ text: z.string(), data: z.string() }))).optional().describe("Inline keyboard buttons as rows of [{text, data}]. User taps are returned by wait_for_message."),
  },
  async ({ message, reply_to, buttons }) => {
    const formatted = formatForTelegram(message);
    const opts: TelegramBot.SendMessageOptions = { parse_mode: "HTML" };
    if (reply_to) opts.reply_to_message_id = reply_to;
    if (buttons) {
      opts.reply_markup = { inline_keyboard: buttons.map(row => row.map(btn => ({ text: btn.text, callback_data: btn.data }))) };
    }
    const chunks: string[] = [];
    for (let i = 0; i < formatted.length; i += 4000) chunks.push(formatted.slice(i, i + 4000));

    let sentMsg: TelegramBot.Message | undefined;
    for (const chunk of chunks) {
      try {
        sentMsg = await bot.sendMessage(chatId, chunk, opts);
        opts.reply_to_message_id = undefined;
        opts.reply_markup = undefined;
      } catch {
        sentMsg = await bot.sendMessage(chatId, chunk.replace(/<[^>]+>/g, "").slice(0, 4000));
      }
    }
    if (sentMsg) lastSentMessageId = sentMsg.message_id;
    return { content: [{ type: "text", text: JSON.stringify({ sent: true, message_id: sentMsg?.message_id }) }] };
  }
);

// TOOL: edit_message
server.tool(
  "edit_message",
  "Edit a previously sent message on Telegram. Use for progress updates instead of sending new messages — avoids notification spam.",
  {
    message_id: z.number().optional().describe("ID of the message to edit. If omitted, edits the last sent message."),
    text: z.string().describe("New text content for the message"),
    buttons: z.array(z.array(z.object({ text: z.string(), data: z.string() }))).optional().describe("Updated inline keyboard buttons (omit to remove buttons)"),
  },
  async ({ message_id, text, buttons }) => {
    const targetId = message_id || lastSentMessageId;
    if (!targetId) return { content: [{ type: "text", text: "Error: No message to edit." }] };

    const formatted = formatForTelegram(text);
    const opts: TelegramBot.EditMessageTextOptions = { chat_id: chatId, message_id: targetId, parse_mode: "HTML" };
    if (buttons) {
      opts.reply_markup = { inline_keyboard: buttons.map(row => row.map(btn => ({ text: btn.text, callback_data: btn.data }))) } as TelegramBot.InlineKeyboardMarkup;
    }
    try { await bot.editMessageText(formatted, opts); }
    catch { try { await bot.editMessageText(text.slice(0, 4000), { ...opts, parse_mode: undefined }); } catch { return { content: [{ type: "text", text: "Error: Could not edit message." }] }; } }
    return { content: [{ type: "text", text: JSON.stringify({ edited: true, message_id: targetId }) }] };
  }
);

// TOOL: react
server.tool(
  "react",
  "Add an emoji reaction to a message on Telegram.",
  {
    message_id: z.number().describe("ID of the message to react to"),
    emoji: z.string().describe("Emoji to react with (e.g., '\ud83d\udc4d', '\ud83d\udd25', '\u2764\ufe0f', '\ud83d\ude02')"),
  },
  async ({ message_id, emoji }) => {
    try {
      await (bot as any).setMessageReaction(chatId, message_id, { reaction: [{ type: "emoji", emoji }] });
      return { content: [{ type: "text", text: "Reaction added." }] };
    } catch { return { content: [{ type: "text", text: "Error: Could not add reaction." }] }; }
  }
);

// TOOL: wait_for_message (unified — catches text, media, AND button presses)
server.tool(
  "wait_for_message",
  "Wait for the user to send a message on Telegram. Blocks until a message arrives. Handles text, photos, videos, voice, documents, stickers, locations, contacts, AND inline button presses. If the user sends /done, /stop, /back, or /desk, returns a stop signal. IMPORTANT: After processing the returned message, ALWAYS call wait_for_message again to keep listening. Only stop calling when you receive a stop signal.",
  {},
  async () => {
    // Drain queues first
    if (messageQueue.length > 0) {
      const msg = messageQueue.shift()!;
      if (msg.type === "text" && STOP_WORDS.includes(msg.text.trim().toLowerCase())) {
        return { content: [{ type: "text", text: JSON.stringify({ stop: true, codeword: msg.text.trim() }) }] };
      }
      return { content: formatReturnContent(msg) as any };
    }
    if (callbackQueue.length > 0) {
      const cb = callbackQueue.shift()!;
      return { content: [{ type: "text", text: JSON.stringify({ button_data: cb.data, from: cb.from, message_id: cb.messageId }) }] };
    }

    // Race: wait for either a message OR a button press
    const result = await new Promise<{ type: "message"; msg: IncomingMessage } | { type: "button"; cb: CallbackData }>((resolve) => {
      waitingResolver = (msg) => { callbackResolver = null; resolve({ type: "message", msg }); };
      callbackResolver = (cb) => { waitingResolver = null; resolve({ type: "button", cb }); };
    });

    if (result.type === "button") {
      return { content: [{ type: "text", text: JSON.stringify({ button_data: result.cb.data, from: result.cb.from, message_id: result.cb.messageId }) }] };
    }
    const msg = result.msg;
    if (msg.type === "text" && STOP_WORDS.includes(msg.text.trim().toLowerCase())) {
      return { content: [{ type: "text", text: JSON.stringify({ stop: true, codeword: msg.text.trim() }) }] };
    }
    return { content: formatReturnContent(msg) as any };
  }
);

// TOOL: check_messages (non-blocking)
server.tool(
  "check_messages",
  "Check for any unread Telegram messages without blocking. Returns all queued messages or empty array.",
  {},
  async () => {
    const messages = messageQueue.splice(0);
    return { content: [{ type: "text", text: JSON.stringify(messages.map(formatMessage)) }] };
  }
);

// TOOL: send_file (unified — auto-detects photo/video/document, renames .ts to .txt)
server.tool(
  "send_file",
  "Send a file to the user on Telegram. Auto-detects type: images sent as photos (inline preview), videos sent as video (inline playback), everything else as document. Renames .ts files to .txt to prevent Telegram treating them as video.",
  {
    filePath: z.string().describe("Absolute path to the file to send"),
    caption: z.string().optional().describe("Optional caption"),
  },
  async ({ filePath, caption }) => {
    const safeFilePath = ensureReadableFilePath(filePath);
    const ext = path.extname(safeFilePath).toLowerCase();

    // Handle confusing extensions (.ts = TypeScript but Telegram thinks MPEG Transport Stream)
    if (CONFUSING_EXTS.includes(ext)) {
      const safeName = sanitizeDownloadFileName(path.basename(safeFilePath).replace(/\.ts$/i, ".txt"));
      const tmpPath = path.join(DOWNLOAD_ROOT, `${Date.now()}_${safeName}`);
      fs.copyFileSync(safeFilePath, tmpPath);
      await bot.sendDocument(chatId, tmpPath, { caption: caption ? `${caption} (renamed .ts → .txt)` : `${path.basename(safeFilePath)} (renamed .ts → .txt)` });
      cleanupFile(tmpPath);
      return { content: [{ type: "text", text: `File sent: ${safeFilePath} (as .txt)` }] };
    }

    if (IMAGE_EXTS.includes(ext)) {
      await bot.sendPhoto(chatId, safeFilePath, { caption });
    } else if (VIDEO_EXTS.includes(ext)) {
      await bot.sendVideo(chatId, safeFilePath, { caption });
    } else {
      await bot.sendDocument(chatId, safeFilePath, { caption });
    }
    return { content: [{ type: "text", text: `File sent: ${safeFilePath}` }] };
  }
);

// --- Audio/Video Processing ---

async function transcribeAudio(audioPath: string): Promise<string> {
  if (!OPENAI_API_KEY) return "[Transcription unavailable — no OPENAI_API_KEY configured]";

  const audioData = fs.readFileSync(audioPath);
  const blob = new Blob([audioData], { type: "audio/mpeg" });
  const formData = new FormData();
  formData.append("file", blob, path.basename(audioPath));
  formData.append("model", "whisper-1");
  formData.append("response_format", "json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData,
  });
  if (!response.ok) { const err = await response.text(); throw new Error(`Whisper API error ${response.status}: ${err}`); }
  return ((await response.json()) as { text: string }).text;
}

// TOOL: transcribe_audio
server.tool(
  "transcribe_audio",
  "Transcribe an audio or voice file previously downloaded by this bridge using OpenAI Whisper. Returns the transcribed text. Auto-cleans up the file after processing.",
  { filePath: z.string().describe("Absolute path to a bridge-managed audio file inside DOWNLOAD_DIR (ogg, mp3, m4a, wav, etc.)") },
  async ({ filePath }) => {
    let sourcePath: string | null = null;
    let convertedPath: string | null = null;

    try {
      sourcePath = ensureManagedDownloadFilePath(filePath);
      let audioPath = sourcePath;
      if (sourcePath.endsWith(".ogg") || sourcePath.endsWith(".oga")) {
        convertedPath = sourcePath.replace(/\.[^.]+$/, ".mp3");
        runCommand("ffmpeg", ["-y", "-i", sourcePath, "-acodec", "libmp3lame", "-q:a", "2", convertedPath], 60000);
        audioPath = convertedPath;
      }
      const transcript = await transcribeAudio(audioPath);
      return { content: [{ type: "text", text: JSON.stringify({ transcript, sourceFile: sourcePath }) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Transcription error: ${err.message}` }] };
    } finally {
      if (convertedPath) cleanupFile(convertedPath);
      if (sourcePath) cleanupFile(sourcePath);
    }
  }
);

// TOOL: process_video
server.tool(
  "process_video",
  "Process a bridge-managed video file: extracts audio transcript via Whisper + keyframes as inline images Claude can see. Auto-cleans up all temp files after processing.",
  {
    filePath: z.string().describe("Absolute path to a bridge-managed video file inside DOWNLOAD_DIR"),
    extractFrames: z.boolean().optional().describe("Whether to extract keyframes (default: true)"),
    maxFrames: z.number().optional().describe("Maximum number of keyframes to extract (default: 10)"),
  },
  async ({ filePath, extractFrames, maxFrames }) => {
    const doFrames = extractFrames !== false;
    const frameLimit = Math.min(Math.max(Math.trunc(maxFrames ?? 10), 1), 20);
    let sourcePath: string | null = null;
    try {
      sourcePath = ensureManagedDownloadFilePath(filePath);
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }] };
    }

    const results: Record<string, unknown> = { sourceFile: sourcePath };
    let audioPath: string | null = null;
    let framesDir: string | null = null;

    try {
      // Transcribe audio
      try {
        audioPath = sourcePath.replace(/\.[^.]+$/, ".mp3");
        runCommand("ffmpeg", ["-y", "-i", sourcePath, "-vn", "-acodec", "libmp3lame", "-q:a", "2", audioPath], 120000);
        results.transcript = await transcribeAudio(audioPath);
      } catch (err: any) {
        results.transcript = `[Audio extraction/transcription failed: ${err.message}]`;
      }

      // Extract keyframes
      const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
      if (doFrames) {
        try {
          framesDir = path.join(DOWNLOAD_ROOT, `frames_${Date.now()}`);
          fs.mkdirSync(framesDir, { recursive: true, mode: 0o700 });

          let duration = 10;
          try {
            const probe = runCommand("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", sourcePath], 30000).trim();
            duration = parseFloat(probe) || 10;
          } catch {}

          const interval = Math.max(duration / frameLimit, 2);
          runCommand("ffmpeg", ["-y", "-i", sourcePath, "-vf", `fps=1/${interval}`, "-frames:v", String(frameLimit), path.join(framesDir, "frame_%03d.jpg")], 120000);

          const frameFiles = fs.readdirSync(framesDir).sort().filter(f => f.endsWith(".jpg"));
          results.keyframeCount = frameFiles.length;

          for (const file of frameFiles) {
            try {
              const imgData = fs.readFileSync(path.join(framesDir, file));
              content.push({ type: "image", data: imgData.toString("base64"), mimeType: "image/jpeg" });
            } catch {}
          }
        } catch (err: any) {
          results.keyframeError = err.message;
        }
      }

      content.unshift({ type: "text", text: JSON.stringify(results) });
      return { content: content as any };
    } finally {
      if (audioPath) cleanupFile(audioPath);
      if (framesDir) cleanupDir(framesDir);
      if (sourcePath) cleanupFile(sourcePath);
    }
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpReady = true;
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
