<div align="center">

# 💬 SocializeAI

**Local-first macOS messaging assistant for iMessage and personal WhatsApp threads, relationship-aware AI replies, and guarded autopilot.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=111111)](https://react.dev/)
[![Electron](https://img.shields.io/badge/Electron-39-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://www.electronjs.org/)
[![OpenAI](https://img.shields.io/badge/OpenAI-Ready-111111?style=for-the-badge&logo=openai&logoColor=white)](https://platform.openai.com/)
[![macOS](https://img.shields.io/badge/macOS-iMessage-000000?style=for-the-badge&logo=apple&logoColor=white)](https://www.apple.com/macos/)
[![WhatsApp](https://img.shields.io/badge/WhatsApp-Bridge-25D366?style=for-the-badge&logo=whatsapp&logoColor=111111)](https://github.com/verygoodplugins/whatsapp-mcp)
[![License](https://img.shields.io/badge/License-MIT-22C55E?style=for-the-badge)](LICENSE)

[Features](#features) · [Getting Started](#getting-started) · [Permissions](#macos-permissions) · [Privacy](#privacy--safety)

</div>

---

## Features

- **Real iMessage Thread Picker** — Reads local iMessage chats from the Mac Messages database and lets you search by name, handle, group, or recent text
- **Personal WhatsApp Thread Picker** — Connects to a local whatsmeow-based bridge, reads WhatsApp chats from SQLite, and sends through the bridge REST API
- **Contact Name Resolution** — Resolves phone numbers and Apple IDs to Apple Contacts names when macOS permissions allow it
- **Chat-First Workbench** — Shows the selected conversation as message bubbles instead of forcing pasted context or manual transcript entry
- **One-Button Bot Mode** — Select a chat, press **Start bot**, and SocializeAI watches that thread without stopping other running chats
- **10-Second Pending Send** — Before a live bot reply sends, the app shows the generated text with **Cancel**, **Regenerate**, and **Send now**
- **Activity Log** — Shows what the bot is doing: queued replies, held messages, sends, blocked attempts, and permission issues
- **Global LLM Context** — Adds a reusable Settings prompt for your personal facts, links, and standing style instructions on every generated reply
- **Permission Modes** — Choose Extra safe, Safe, Auto review, or Dangerously skip depending on how much approval you want before sends
- **Screen-Share Privacy Mode** — Blurs names, phone numbers, message text, inputs, activity details, and audit logs while leaving controls usable
- **OpenAI + Local Model Routing** — Supports OpenAI, Ollama, and OpenAI-compatible local servers
- **WhatsApp Bridge Settings** — Supports the maintained `verygoodplugins/whatsapp-mcp` bridge by default, with the WhatsApp Business Cloud API path still available as an advanced connector
- **Local-First State** — Stores settings, contacts, relationship memory, and audit events locally through the Electron app
- **Safety Gates** — Dry run, human approval, opt-out, sensitive-topic blocking, audit logs, and per-chat autopilot allow-listing

## Getting Started

### Prerequisites

- macOS with Messages.app signed in
- Node.js 20+
- npm
- OpenAI API key, Ollama, or another OpenAI-compatible local model server
- Optional for WhatsApp: internet access for first-time bridge setup

### Install

```bash
git clone https://github.com/markksantos/SocializeAI.git
cd SocializeAI
npm install
```

### Run the Desktop App

```bash
npm run desktop
```

For active development with Vite hot reload:

```bash
npm run dev
```

### Package for macOS

```bash
npm run package:mac
open release/mac-arm64/SocializeAI.app
```

## macOS Permissions

SocializeAI uses local macOS data and automation, so permissions matter.

Grant **Full Disk Access** to the app that launches SocializeAI:

- Development: grant it to the terminal app running `npm run desktop` or `npm run dev`
- Packaged app: grant it to `SocializeAI.app`

For full functionality, macOS may also prompt for:

1. **Contacts** — lets SocializeAI show names instead of raw phone numbers or Apple IDs
2. **Automation** — lets SocializeAI ask Messages.app to send an approved/live iMessage

Inside the app, use **Settings → Mac access → Check access** to verify:

- Messages database access
- Contacts database access
- Messages.app automation

## Personal WhatsApp Setup

SocializeAI expects a local WhatsApp bridge that stores messages in SQLite and exposes a loopback REST API.

Open **Settings → WhatsApp → Personal bridge** and click **Start bridge**. SocializeAI will:

1. Use an existing Go runtime if one is installed.
2. Otherwise download a private app-managed Go runtime into SocializeAI's app data folder.
3. Clone the maintained [`verygoodplugins/whatsapp-mcp`](https://github.com/verygoodplugins/whatsapp-mcp) bridge into SocializeAI's app data folder if needed.
4. Open the bridge in Terminal so you can scan the WhatsApp QR code.

On first run, scan the QR code with WhatsApp on your phone. After pairing, the bridge stores:

- REST API token: `whatsapp-bridge/store/.bridge-token`
- Message database: `whatsapp-bridge/store/messages.db`
- Default API URL: `http://127.0.0.1:8080/api`

Click **Check bridge** or refresh WhatsApp chats after pairing. If the bridge database already exists in a common checkout path, SocializeAI auto-detects the `messages.db` path.

The app reads WhatsApp history locally from the bridge database and sends through `/api/send`. It does not copy bridge code into this repository.

## Privacy & Safety

SocializeAI is intentionally local-first.

- Raw iMessage history is read locally from your Mac
- Raw WhatsApp history is read locally from your WhatsApp bridge database
- API keys are stored through Electron's secure local storage path
- The app does not include analytics, telemetry, cloud accounts, or background sync
- Autopilot only runs for chats explicitly enabled by the user
- Sensitive content is blocked or held for human handling
- Screen-share mode can blur private names, numbers, messages, inputs, and logs

Use automated sending responsibly. Laws, platform rules, and personal expectations around automated messages can vary by context.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Desktop Shell | Electron |
| Frontend | React 19 + Vite |
| Language | TypeScript |
| AI Providers | OpenAI, Ollama, OpenAI-compatible local APIs |
| Local Messaging | macOS Messages database + Messages.app AppleScript |
| WhatsApp Messaging | Local whatsmeow bridge SQLite + REST API |
| Contact Resolution | Apple AddressBook local database |
| State | Local JSON state under Electron user data |
| Packaging | electron-builder |

## Project Structure

```text
SocializeAI/
├── docs/
│   └── ai-messaging-blueprint.md
├── electron/
│   ├── main.ts
│   └── preload.ts
├── src/
│   ├── App.tsx
│   ├── browserApi.ts
│   ├── main.tsx
│   ├── shared.ts
│   └── styles.css
├── package.json
└── vite.config.ts
```

## Verification

```bash
npm run typecheck
npm run build
npm run package:mac
```

Current verification status:

- TypeScript checks: passing
- Production build: passing
- macOS app packaging: passing
- Packaged app launch: verified locally
- iMessage chat loading: verified locally with Full Disk Access
- WhatsApp bridge integration: typechecked and UI-previewed; requires a running personal bridge for live sends

## License

MIT License © 2026 Mark Santos

---

<div align="center">

Built with ❤️ by [NoSleepLab](https://nosleeplab.com)

</div>
