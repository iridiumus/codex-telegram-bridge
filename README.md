# Claude Telegram Bridge

Two-way Telegram chat for Claude Code. Text Claude from your phone, get instant responses in your existing session.

The official Claude Code Channels (Telegram plugin) only works in the CLI. This MCP server brings real-time two-way Telegram messaging to the **VS Code extension** — same session, same context, no compromises.

## Features

**Messaging**
- Send and receive text with markdown formatting (code blocks, bold, italic)
- Auto-chunking for long messages (4000 char limit per Telegram message)
- HTML parse mode with plain-text fallback

**Media**
- Receive photos, videos, voice messages, audio files, documents, stickers, locations, contacts
- Photos returned as base64 images — Claude can see them inline
- Send files with auto-type detection (images as photos, videos as video, everything else as documents)
- `.ts` files automatically renamed to `.txt` (Telegram treats TypeScript as MPEG Transport Stream)
- Downloaded media filenames are sanitized and kept inside a managed temp directory

**Interactive**
- Inline keyboard buttons — send choices, receive taps
- Edit messages in place (no notification spam for progress updates)
- Emoji reactions on messages
- Reply threading (reply_to parameter)

**Audio/Video Processing** *(optional — requires FFmpeg + OpenAI API key)*
- Transcribe voice messages and audio files via OpenAI Whisper
- Process videos: extract audio transcript + keyframes as images Claude can see
- Auto-cleanup of temporary files after processing

**Session Management**
- `wait_for_message` blocks until user sends anything (text, media, or button press)
- Stop codewords: `/done`, `/stop`, `/back`, `/desk` — cleanly end the listening loop
- `check_messages` for non-blocking queue reads
- MCP logging notifications when messages arrive while not listening

**Planned: Multi-Agent Shared Chat** *(design only — not implemented yet)*
- Multiple agents or subagents will be able to wait for replies at the same time in one shared Telegram chat
- Users should reply to a specific bot message to target one waiting agent
- A user message with no Telegram reply target will be treated as a broadcast and delivered to every agent currently waiting
- Agent-authored messages will carry a compact header with name, role, and agent ID so users can see who asked what

**Security**
- `send_file` is limited to the current workspace, downloaded Telegram media, and any extra roots declared in `ALLOWED_FILE_ROOTS`
- `transcribe_audio` and `process_video` only operate on files downloaded into `DOWNLOAD_DIR`
- FFmpeg and FFprobe are invoked without shell interpolation

## Tools

| Tool | Description |
|------|-------------|
| `send_message` | Send text with formatting, buttons, and reply threading |
| `wait_for_message` | Block until user sends a message or taps a button |
| `check_messages` | Non-blocking check for queued messages |
| `edit_message` | Edit a previously sent message in place |
| `send_file` | Send any file (auto-detects photo/video/document) |
| `react` | Add emoji reaction to a message |
| `transcribe_audio` | Transcribe audio/voice via Whisper *(optional)* |
| `process_video` | Extract transcript + keyframes from video *(optional)* |

## Setup

### 1. Create a Telegram bot

Open [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, and copy the token.

### 2. Get your chat ID

Send any message to your bot, then visit:
```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```
Find `"chat":{"id":YOUR_CHAT_ID}` in the response.

### 3. Install

```bash
git clone https://github.com/carlosvianney/claude-telegram-bridge.git
cd claude-telegram-bridge
npm install
npm run build
```

### 4. Configure Claude Code

Add to your `.mcp.json` (in your project root or `~/.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/path/to/claude-telegram-bridge/build/index.js"],
      "env": {
        "TELEGRAM_TOKEN": "your-bot-token",
        "CHAT_ID": "your-chat-id"
      }
    }
  }
}
```

### 4a. Optional: Run in Docker Compose

Copy `.env.example` to `.env`, fill in the Telegram values, and set `WORKSPACE_BIND` to the directory whose files Claude should be allowed to send to Telegram.

```bash
cp -f .env.example .env
docker compose run --rm -T telegram-bridge
```

For Claude Code, the MCP command can call Docker directly:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "docker",
      "args": [
        "compose",
        "-f",
        "/path/to/claude-telegram-bridge/docker-compose.yml",
        "run",
        "--rm",
        "-T",
        "telegram-bridge"
      ]
    }
  }
}
```

The Compose service uses a read-only root filesystem, drops Linux capabilities, enables `no-new-privileges`, and stores downloads in a tmpfs-mounted `/tmp`.

### 5. Optional: Audio/Video processing

For `transcribe_audio` and `process_video` tools:

1. Install FFmpeg: `sudo apt install ffmpeg` (Linux) or `brew install ffmpeg` (Mac)
2. Add your OpenAI API key to the env:

```json
{
  "env": {
    "TELEGRAM_TOKEN": "your-bot-token",
    "CHAT_ID": "your-chat-id",
    "OPENAI_API_KEY": "sk-..."
  }
}
```

Without these, the core messaging tools work fine — transcription and video processing are optional features.

## Usage

Once configured, tell Claude to pick up the Telegram loop:

> "Start listening on Telegram"

Claude will call `wait_for_message`, and you can text from your phone. Every message you send arrives in the VS Code session. Claude responds via `send_message`, and you see it in Telegram.

Send `/done` to stop the loop and return to the VS Code keyboard.

### Planned: Shared Chat Routing

This section describes the intended multi-agent design. It is documentation for the next implementation step, not current runtime behavior.

**User protocol**
- When multiple agents are active, the user should always use Telegram's **Reply** action on the specific bot message they are answering
- A reply to a specific bot message is a **direct reply** and should only wake the waiter attached to that message
- A normal chat message with no reply target is a **broadcast reply** and should wake every agent currently waiting
- If a user forgets to use Reply, the message is still accepted, but it is treated as shared input for all active waiters

**Agent header format**

Every outbound question should use a short, standardized first line:

```text
[Security Review | reviewer | sg-2]
```

Recommended field order:
- `label` first, because humans scan the chat by topic or name
- `role` second, because it explains why the agent is asking
- `id` last, because it is mainly for disambiguation and debugging

Example:

```text
[Security Review | reviewer | sg-2]

Can you confirm whether this token is still valid?
```

**Reply routing rules**
- Agent A sends a message and stores the returned Telegram `message_id`
- Agent A then waits for either:
  - a direct reply whose `reply_to_message_id` matches its own `message_id`
  - a broadcast reply with no `reply_to_message_id`
- Agent B can do the same at the same time with a different `message_id`
- If the user replies directly to Agent A, Agent B keeps waiting
- If the user sends a non-reply message, both Agent A and Agent B receive the same message and both waits resolve

**Buttons and callbacks**
- Inline button presses should follow the same routing rule as text
- A callback on a bot message belongs to the waiter registered for that Telegram `message_id`
- Button presses should not be broadcast unless they are attached to a deliberately shared prompt

### Inline Buttons

```
Claude sends: "Pick one" with buttons [Option A] [Option B]
You tap: Option A
Claude receives: { button_data: "option_a" }
```

Buttons and messages both come through `wait_for_message` — no separate tool needed.

### Voice Messages

Send a voice message from Telegram → Claude calls `transcribe_audio` → gets the text transcript. Works for any audio file (ogg, mp3, m4a, wav).

### Video Processing

Send a video → Claude calls `process_video` → gets:
- Full audio transcript (via Whisper)
- Keyframe images (Claude can see them)
- Metadata (duration, frame count)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_TOKEN` | Yes | Bot token from BotFather |
| `CHAT_ID` | Yes | Your Telegram chat ID |
| `OPENAI_API_KEY` | No | For audio transcription and video processing |
| `DOWNLOAD_DIR` | No | Where to save media files (default: `/tmp/telegram-mcp`) |
| `ALLOWED_FILE_ROOTS` | No | Extra comma-separated absolute paths that `send_file` may read from |

## How It Works

This is an MCP (Model Context Protocol) server that connects Claude Code to a Telegram bot via long polling. When Claude calls `wait_for_message`, the tool blocks until your Telegram bot receives a message. Both text messages and inline button presses resolve the same promise — unified input.

The bot runs inside the MCP server process. No separate service, no webhook setup, no public URL needed. It starts when Claude Code loads the MCP config and stops when the session ends.

## Planned Multi-Agent Design

The current implementation is single-waiter only. It keeps one `waitingResolver`, one `callbackResolver`, and one shared queue. To support multiple agents in the same chat, the server should move to explicit waiter registration and reply routing.

### 1. Replace single resolvers with a waiter registry

Planned in-memory structures:
- `pendingWaiters: Map<string, PendingWaiter>` keyed by a waiter token such as `agent_id:message_id`
- `waitersByMessageId: Map<number, Set<string>>` so a Telegram reply can be routed by `reply_to_message.message_id`
- `generalBacklog: RoutedEvent[]` for broadcast messages that arrive before any waiter consumes them
- `targetedBacklog: Map<number, RoutedEvent[]>` for direct replies that arrive before the matching waiter starts waiting

Each `PendingWaiter` should store:
- `agent.id`
- `agent.label`
- `agent.role`
- `target_message_id`
- `resolve`
- `created_at`
- `allow_broadcast` with default `true`

### 2. Add structured agent metadata to outbound messages

Planned `send_message` extension:

```json
{
  "message": "Question body",
  "agent": {
    "label": "Security Review",
    "role": "reviewer",
    "id": "sg-2"
  }
}
```

The MCP server should render the header itself instead of forcing every agent to hand-build it. That keeps formatting stable and makes routing metadata explicit.

### 3. Add reply-scoped waiting

Planned `wait_for_message` extension:

```json
{
  "agent": {
    "label": "Security Review",
    "role": "reviewer",
    "id": "sg-2"
  },
  "target_message_id": 12345,
  "allow_broadcast": true
}
```

Expected behavior:
- If a targeted backlog item already exists for `target_message_id`, return it immediately
- Else if a general backlog item exists and `allow_broadcast` is `true`, return that immediately
- Else register the waiter and block

`check_messages` should gain the same routing inputs for symmetry with `wait_for_message`.

### 4. Route incoming Telegram messages by reply target

Planned message routing:
- If the incoming Telegram message has `reply_to_message.message_id`, deliver it only to waiters registered for that target message
- If it has no reply target, deliver it to all currently waiting agents and mark the payload as `delivery: "broadcast"`
- If no waiter is active, store the event in `generalBacklog` or `targetedBacklog` instead of dropping it

Planned callback routing:
- Use `callback_query.message.message_id` as the routing key
- Deliver the callback only to waiters attached to that message

### 5. Return routing metadata to agents

Each delivered event should include enough context for the receiving agent to understand why it woke up. Planned additions to the payload:
- `delivery`: `"direct"` or `"broadcast"`
- `reply_to_message_id`: Telegram reply target when present
- `message_id`: Telegram message ID of the incoming user message
- `target_message_id`: the bot message this waiter was registered against
- `agent`: the waiter metadata for the waking agent

### 6. Preserve a compatibility path

For a staged rollout, the MCP server should keep the current single-agent behavior when no `agent` metadata or `target_message_id` is provided. That allows existing callers to continue working while new multi-agent clients adopt the routed mode explicitly.

### 7. Suggested rollout order

1. Introduce shared routing data structures and direct-reply matching.
2. Add server-rendered agent headers in `send_message`.
3. Extend `wait_for_message` and `check_messages` with `target_message_id` and `agent` metadata.
4. Route callback queries by `message_id`.
5. Add tests for direct reply, broadcast reply, backlog replay, and concurrent waiters.

## Limitations

- **One chat only** — the `CHAT_ID` env var locks it to a single conversation
- **VS Code keyboard blocked** while `wait_for_message` is active (you're on Telegram instead)
- **No push notifications** — Claude can't initiate a turn from Telegram. You text first, Claude responds.
- **Telegram file size limit** — 50MB for downloads, 10MB for photos
- **Media-processing tools are scoped** — `transcribe_audio` and `process_video` only accept files under `DOWNLOAD_DIR`
- **Multi-agent shared routing is still planned** — the current runtime still resolves only one waiter at a time

## License

MIT — OCS CommTech LLC
