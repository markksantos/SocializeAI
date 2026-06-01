import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { latestInboundLine } from "./transcript.js";

const execFileAsync = promisify(execFile);

type AiProvider = "openai" | "ollama" | "local-openai";
type Platform = "imessage" | "whatsapp" | "manual";
type RiskLevel = "low" | "medium" | "high" | "blocked";

type AppSettings = {
  hasCompletedOnboarding: boolean;
  aiProvider: AiProvider;
  openAiApiKey: string;
  openAiModel: string;
  localBaseUrl: string;
  localModel: string;
  localOpenAiBaseUrl: string;
  localOpenAiModel: string;
  iMessageDryRun: boolean;
  whatsappDryRun: boolean;
  whatsappAccessToken: string;
  whatsappPhoneNumberId: string;
  whatsappGraphVersion: string;
  requireHumanApproval: boolean;
  autopilotEnabled: boolean;
  autopilotIntervalMinutes: number;
  maxAutoSendsPerRun: number;
  appendDisclosure: boolean;
  disclosureText: string;
  privacyBlurEnabled: boolean;
};

type Contact = {
  id: string;
  displayName: string;
  platform: Platform;
  handle: string;
  chatId?: string;
  chatGuid?: string;
  relationship: string;
  notes: string;
  allowAutopilot: boolean;
  optedOut: boolean;
  lastImportedAt?: string;
  lastAutopilotAt?: string;
  lastAutopilotInboundHash?: string;
};

type IMessageChat = {
  chatId: string;
  guid: string;
  displayName: string;
  contactName?: string;
  chatIdentifier: string;
  serviceName: string;
  participantHandles: string[];
  participantNames?: string[];
  lastMessageAt: string;
  lastText: string;
  isGroup: boolean;
};

type AuditEvent = {
  id: string;
  at: string;
  type: string;
  summary: string;
  detail?: string;
};

type AppState = {
  settings: AppSettings;
  contacts: Contact[];
  audits: AuditEvent[];
};

type DraftResult = {
  draftText: string;
  messageParts: string[];
  confidence: number;
  riskLevel: RiskLevel;
  requiresHumanReview: boolean;
  reasonCodes: string[];
  sendEligibility: {
    canAutoSend: boolean;
    explanation: string;
  };
  memoryUpdates: Array<{
    kind: "fact" | "style" | "boundary" | "cadence";
    value: string;
    confidence: number;
  }>;
  provider: AiProvider | "heuristic";
  model: string;
  raw?: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

const defaultSettings: AppSettings = {
  hasCompletedOnboarding: false,
  aiProvider: "openai",
  openAiApiKey: "",
  openAiModel: "gpt-5.5",
  localBaseUrl: "http://127.0.0.1:11434",
  localModel: "qwen3:8b",
  localOpenAiBaseUrl: "http://127.0.0.1:1234",
  localOpenAiModel: "qwen3.7",
  iMessageDryRun: true,
  whatsappDryRun: true,
  whatsappAccessToken: "",
  whatsappPhoneNumberId: "",
  whatsappGraphVersion: "v25.0",
  requireHumanApproval: true,
  autopilotEnabled: false,
  autopilotIntervalMinutes: 10,
  maxAutoSendsPerRun: 3,
  appendDisclosure: false,
  disclosureText: "Sent with AI assistance.",
  privacyBlurEnabled: false
};

let autopilotTimer: NodeJS.Timeout | null = null;

function nowIso() {
  return new Date().toISOString();
}

function createAudit(type: AuditEvent["type"], summary: string, detail?: string): AuditEvent {
  return {
    id: randomUUID(),
    at: nowIso(),
    type,
    summary,
    detail
  };
}

function createDefaultState(): AppState {
  return {
    settings: { ...defaultSettings },
    contacts: [
      {
        id: randomUUID(),
        displayName: "Demo contact",
        platform: "manual",
        handle: "",
        relationship: "friend",
        notes: "Use this contact to test draft generation before connecting a real message channel.",
        allowAutopilot: false,
        optedOut: false
      }
    ],
    audits: [createAudit("settings_saved", "Created local SocializeAI state")]
  };
}

function getStatePath() {
  return path.join(app.getPath("userData"), "socializeai-state.json");
}

function encryptSecret(value: string) {
  if (!value) return "";
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:${safeStorage.encryptString(value).toString("base64")}`;
  }
  return `plain:${value}`;
}

function decryptSecret(value: string | undefined) {
  if (!value) return "";
  if (value.startsWith("safe:")) {
    if (!safeStorage.isEncryptionAvailable()) return "";
    return safeStorage.decryptString(Buffer.from(value.slice(5), "base64"));
  }
  if (value.startsWith("plain:")) return value.slice(6);
  return value;
}

type DiskState = Omit<AppState, "settings"> & {
  settings: Omit<AppSettings, "openAiApiKey" | "whatsappAccessToken"> & {
    openAiApiKeyCipher?: string;
    whatsappAccessTokenCipher?: string;
  };
};

function toDiskState(state: AppState): DiskState {
  const { openAiApiKey, whatsappAccessToken, ...settings } = state.settings;
  return {
    ...state,
    settings: {
      ...settings,
      openAiApiKeyCipher: encryptSecret(openAiApiKey),
      whatsappAccessTokenCipher: encryptSecret(whatsappAccessToken)
    }
  };
}

function fromDiskState(state: Partial<DiskState>): AppState {
  const settings = (state.settings ?? {}) as Partial<DiskState["settings"]>;
  return {
    settings: {
      ...defaultSettings,
      ...settings,
      openAiApiKey: decryptSecret(settings.openAiApiKeyCipher),
      whatsappAccessToken: decryptSecret(settings.whatsappAccessTokenCipher)
    },
    contacts: Array.isArray(state.contacts) ? state.contacts : [],
    audits: Array.isArray(state.audits) ? state.audits : []
  };
}

async function readState(): Promise<AppState> {
  try {
    const raw = await readFile(getStatePath(), "utf8");
    return fromDiskState(JSON.parse(raw) as DiskState);
  } catch {
    const state = createDefaultState();
    await writeState(state);
    return state;
  }
}

async function writeState(state: AppState) {
  const statePath = getStatePath();
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(toDiskState(state), null, 2), "utf8");
}

async function rescheduleAutopilot() {
  if (autopilotTimer) {
    clearInterval(autopilotTimer);
    autopilotTimer = null;
  }
  // The renderer owns live bot checks so it can show a 10-second cancel window before sending.
}

function getSelectedModel(settings: AppSettings) {
  if (settings.aiProvider === "openai") return settings.openAiModel.trim() || "gpt-5.5";
  if (settings.aiProvider === "ollama") return settings.localModel.trim() || "qwen3:8b";
  return settings.localOpenAiModel.trim() || "qwen3.7";
}

const draftSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "draft_text",
    "message_parts",
    "confidence",
    "risk_level",
    "requires_human_review",
    "reason_codes",
    "send_eligibility",
    "memory_updates"
  ],
  properties: {
    draft_text: { type: "string" },
    message_parts: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: { type: "string" }
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    risk_level: { type: "string", enum: ["low", "medium", "high", "blocked"] },
    requires_human_review: { type: "boolean" },
    reason_codes: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "routine_ack",
          "scheduling",
          "emotional_context",
          "medical_or_health",
          "financial",
          "legal",
          "romantic_or_sensitive",
          "conflict",
          "unknown_context",
          "recipient_opted_out",
          "platform_policy",
          "password_or_secret",
          "self_harm_or_emergency"
        ]
      }
    },
    send_eligibility: {
      type: "object",
      additionalProperties: false,
      required: ["can_auto_send", "explanation"],
      properties: {
        can_auto_send: { type: "boolean" },
        explanation: { type: "string" }
      }
    },
    memory_updates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value", "confidence"],
        properties: {
          kind: { type: "string", enum: ["fact", "style", "boundary", "cadence"] },
          value: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    }
  }
};

function buildSystemPrompt() {
  return [
    "You draft personal text replies on behalf of the app user.",
    "Match the user's relationship-specific tone without inventing facts, plans, feelings, locations, money commitments, or promises.",
    "Use message_parts for separate outgoing text bubbles. Use 1 part for a normal reply, or 2-4 short parts when double/triple texting would sound more natural.",
    "draft_text must equal message_parts joined with a blank line between parts.",
    "If the other person sent multiple consecutive messages, reply to the full cluster, not only the last line.",
    "If the reply needs a personal fact that is not in the conversation, relationship memory, contact notes, or user instruction, do not guess and do not use placeholders. Return draft_text as NEEDS_USER_INPUT: followed by the missing fact.",
    "If context is ambiguous or sensitive, require human review.",
    "Never claim the user did something they did not say they did.",
    "Return only JSON matching the requested schema."
  ].join("\n");
}

function buildDraftPrompt(input: {
  contact: Contact;
  currentMessage: string;
  conversationContext: string;
  relationshipMemory: string;
  userInstruction: string;
}) {
  return [
    `Contact: ${input.contact.displayName || "Unknown"}`,
    `Platform: ${input.contact.platform}`,
    `Relationship: ${input.contact.relationship || "unspecified"}`,
    `Contact notes: ${input.contact.notes || "none"}`,
    `Relationship memory: ${input.relationshipMemory || "none"}`,
    `User instruction: ${input.userInstruction || "none"}`,
    "",
    "Recent conversation:",
    input.conversationContext || "No pasted or imported context.",
    "",
    "Latest inbound message to reply to:",
    input.currentMessage || "No latest inbound message provided.",
    "",
    "Draft a concise reply in the user's voice. Include memory_updates only for durable facts or style observations worth saving.",
    "Use separate message_parts when the user's style or the conversation cadence would make short double/triple texts feel more natural."
  ].join("\n");
}

function extractJsonText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const data = value as Record<string, unknown>;
  if (typeof data.output_text === "string") return data.output_text;
  const output = data.output;
  if (Array.isArray(output)) {
    const chunks: string[] = [];
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const partObj = part as Record<string, unknown>;
        if (typeof partObj.text === "string") chunks.push(partObj.text);
      }
    }
    return chunks.join("\n");
  }
  return "";
}

function splitOutgoingText(rawText: string) {
  return rawText
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function normalizeMessageParts(value: unknown, fallbackText: string) {
  const rawParts = Array.isArray(value) ? value.map((part) => String(part).trim()).filter(Boolean) : [];
  const parts = rawParts.length > 0 ? rawParts : splitOutgoingText(fallbackText);
  return (parts.length > 0 ? parts : [fallbackText.trim()]).filter(Boolean).slice(0, 4);
}

function joinMessageParts(parts: string[]) {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

function parseDraft(raw: string, provider: AiProvider | "heuristic", model: string): DraftResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("The model did not return JSON.");
    parsed = JSON.parse(match[0]);
  }

  const parsedText = String(parsed.draft_text ?? parsed.draftText ?? "").trim();
  const messageParts = normalizeMessageParts(parsed.message_parts ?? parsed.messageParts, parsedText);
  const draftText = parsedText || joinMessageParts(messageParts);
  const result: DraftResult = {
    draftText,
    messageParts,
    confidence: clampNumber(Number(parsed.confidence ?? 0.5), 0, 1),
    riskLevel: normalizeRisk(parsed.risk_level),
    requiresHumanReview: Boolean(parsed.requires_human_review ?? true),
    reasonCodes: Array.isArray(parsed.reason_codes) ? parsed.reason_codes.map(String) : ["unknown_context"],
    sendEligibility: normalizeSendEligibility(parsed.send_eligibility),
    memoryUpdates: normalizeMemoryUpdates(parsed.memory_updates),
    provider,
    model,
    raw
  };

  if (!result.draftText || result.messageParts.length === 0) throw new Error("The model returned an empty draft.");
  return applySafetyOverlay(result, `${result.draftText}\n${raw}`);
}

function normalizeRisk(value: unknown): RiskLevel {
  if (value === "low" || value === "medium" || value === "high" || value === "blocked") return value;
  return "medium";
}

function normalizeSendEligibility(value: unknown) {
  if (!value || typeof value !== "object") {
    return { canAutoSend: false, explanation: "Human approval is required by default." };
  }
  const obj = value as Record<string, unknown>;
  return {
    canAutoSend: Boolean(obj.can_auto_send ?? obj.canAutoSend ?? false),
    explanation: String(obj.explanation ?? "Human approval is required by default.")
  };
}

function normalizeMemoryUpdates(value: unknown): DraftResult["memoryUpdates"] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const obj = item as Record<string, unknown>;
      const kind = String(obj.kind ?? "fact");
      if (!["fact", "style", "boundary", "cadence"].includes(kind)) return null;
      return {
        kind: kind as "fact" | "style" | "boundary" | "cadence",
        value: String(obj.value ?? "").trim(),
        confidence: clampNumber(Number(obj.confidence ?? 0.5), 0, 1)
      };
    })
    .filter((item): item is DraftResult["memoryUpdates"][number] => Boolean(item?.value));
}

function clampNumber(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function detectSensitiveReasons(text: string) {
  const lower = text.toLowerCase();
  const reasons = new Set<string>();
  if (/(password|passcode|2fa|verification code|social security|ssn|bank login|private key)/.test(lower)) {
    reasons.add("password_or_secret");
  }
  if (/(kill myself|hurt myself|suicide|self harm|emergency|911|overdose)/.test(lower)) {
    reasons.add("self_harm_or_emergency");
  }
  if (/(diagnosis|medication|doctor|hospital|therapy|medical|pregnan|cancer|surgery)/.test(lower)) {
    reasons.add("medical_or_health");
  }
  if (/(\$|venmo|paypal|wire|loan|borrow|debt|rent|mortgage|bank|crypto|refund|invoice)/.test(lower)) {
    reasons.add("financial");
  }
  if (/(lawyer|attorney|court|lawsuit|contract|legal|police|arrest)/.test(lower)) {
    reasons.add("legal");
  }
  if (/(break up|divorce|love you|romantic|sex|cheat|dating)/.test(lower)) {
    reasons.add("romantic_or_sensitive");
  }
  if (/(angry|mad at me|fight|argument|upset|betray|lied|hate)/.test(lower)) {
    reasons.add("conflict");
  }
  return [...reasons];
}

function applySafetyOverlay(result: DraftResult, textForScan: string): DraftResult {
  const sensitiveReasons = detectSensitiveReasons(textForScan);
  const reasonCodes = Array.from(new Set([...result.reasonCodes, ...sensitiveReasons]));
  const blocked = sensitiveReasons.includes("password_or_secret") || sensitiveReasons.includes("self_harm_or_emergency");
  const highRisk = blocked || sensitiveReasons.length > 0;
  return {
    ...result,
    reasonCodes,
    riskLevel: blocked ? "blocked" : highRisk && result.riskLevel === "low" ? "high" : result.riskLevel,
    requiresHumanReview: result.requiresHumanReview || highRisk,
    sendEligibility: highRisk
      ? {
          canAutoSend: false,
          explanation: blocked
            ? "Blocked or emergency-sensitive content requires direct human handling."
            : "Sensitive content requires human review before sending."
        }
      : result.sendEligibility
  };
}

async function generateDraftWithOpenAI(settings: AppSettings, request: unknown) {
  if (!settings.openAiApiKey.trim()) throw new Error("Add an OpenAI API key in onboarding or settings.");
  const input = request as {
    contact: Contact;
    currentMessage: string;
    conversationContext: string;
    relationshipMemory: string;
    userInstruction: string;
  };
  const model = settings.openAiModel.trim() || "gpt-5.5";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.openAiApiKey.trim()}`
    },
    body: JSON.stringify({
      model,
      store: false,
      instructions: buildSystemPrompt(),
      input: buildDraftPrompt(input),
      text: {
        format: {
          type: "json_schema",
          name: "socializeai_draft",
          strict: true,
          schema: draftSchema
        }
      },
      safety_identifier: "local-user"
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(extractApiError(data, `OpenAI request failed with ${response.status}.`));
  return parseDraft(extractJsonText(data), "openai", model);
}

async function generateDraftWithOllama(settings: AppSettings, request: unknown) {
  const input = request as {
    contact: Contact;
    currentMessage: string;
    conversationContext: string;
    relationshipMemory: string;
    userInstruction: string;
  };
  const baseUrl = trimTrailingSlash(settings.localBaseUrl || "http://127.0.0.1:11434");
  const model = settings.localModel.trim() || "qwen3:8b";
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: buildSystemPrompt() },
        {
          role: "user",
          content: `${buildDraftPrompt(input)}\n\nReturn JSON with keys: draft_text, message_parts, confidence, risk_level, requires_human_review, reason_codes, send_eligibility, memory_updates.`
        }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(extractApiError(data, `Ollama request failed with ${response.status}.`));
  const text = typeof data?.message?.content === "string" ? data.message.content : JSON.stringify(data);
  return parseDraft(text, "ollama", model);
}

async function generateDraftWithLocalOpenAI(settings: AppSettings, request: unknown) {
  const input = request as {
    contact: Contact;
    currentMessage: string;
    conversationContext: string;
    relationshipMemory: string;
    userInstruction: string;
  };
  const baseUrl = trimTrailingSlash(settings.localOpenAiBaseUrl || "http://127.0.0.1:1234");
  const model = settings.localOpenAiModel.trim() || "qwen3.7";
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildSystemPrompt() },
        {
          role: "user",
          content: `${buildDraftPrompt(input)}\n\nReturn JSON with keys: draft_text, message_parts, confidence, risk_level, requires_human_review, reason_codes, send_eligibility, memory_updates.`
        }
      ]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(extractApiError(data, `Local OpenAI-compatible request failed with ${response.status}.`));
  const text = data?.choices?.[0]?.message?.content;
  return parseDraft(typeof text === "string" ? text : JSON.stringify(data), "local-openai", model);
}

function extractApiError(data: unknown, fallback: string) {
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const error = obj.error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    if (typeof obj.message === "string") return obj.message;
  }
  return fallback;
}

function trimTrailingSlash(url: string) {
  return url.replace(/\/+$/, "");
}

async function testProvider(settings: AppSettings) {
  try {
    if (settings.aiProvider === "openai") {
      if (!settings.openAiApiKey.trim()) return { ok: false, message: "OpenAI API key is missing." };
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${settings.openAiApiKey.trim()}` }
      });
      if (!response.ok) return { ok: false, message: `OpenAI returned ${response.status}.` };
      return { ok: true, message: `OpenAI key works. Selected model: ${settings.openAiModel || "gpt-5.5"}.` };
    }
    if (settings.aiProvider === "ollama") {
      const response = await fetch(`${trimTrailingSlash(settings.localBaseUrl)}/api/tags`);
      if (!response.ok) return { ok: false, message: `Ollama returned ${response.status}.` };
      const data = await response.json().catch(() => ({}));
      const names = Array.isArray(data.models) ? data.models.map((model: { name?: string }) => model.name).filter(Boolean) : [];
      return {
        ok: true,
        message: names.includes(settings.localModel)
          ? `Ollama is reachable and ${settings.localModel} is installed.`
          : `Ollama is reachable. Install or select a model. Found: ${names.slice(0, 5).join(", ") || "none"}.`
      };
    }
    const response = await fetch(`${trimTrailingSlash(settings.localOpenAiBaseUrl)}/v1/models`);
    if (!response.ok) return { ok: false, message: `Local server returned ${response.status}.` };
    return { ok: true, message: `Local OpenAI-compatible server is reachable. Selected model: ${settings.localOpenAiModel}.` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Provider test failed."
    };
  }
}

async function sendIMessage(handle: string, text: string, chatGuid?: string) {
  if (chatGuid?.trim()) {
    const script = [
      "on run argv",
      "set targetChatId to item 1 of argv",
      "set messageText to item 2 of argv",
      "tell application \"Messages\"",
      "set targetChat to chat id targetChatId",
      "send messageText to targetChat",
      "end tell",
      "end run"
    ];
    const args = script.flatMap((line) => ["-e", line]).concat([chatGuid, text]);
    const { stderr } = await execFileAsync("osascript", args, { timeout: 20000 });
    if (stderr) return stderr.trim();
    return "";
  }
  const script = [
    "on run argv",
    "set targetHandle to item 1 of argv",
    "set messageText to item 2 of argv",
    "tell application \"Messages\"",
    "set targetService to 1st service whose service type = iMessage",
    "set targetBuddy to buddy targetHandle of targetService",
    "send messageText to targetBuddy",
    "end tell",
    "end run"
  ];
  const args = script.flatMap((line) => ["-e", line]).concat([handle, text]);
  const { stderr } = await execFileAsync("osascript", args, { timeout: 20000 });
  if (stderr) return stderr.trim();
  return "";
}

async function sendWhatsApp(settings: AppSettings, handle: string, text: string) {
  if (!settings.whatsappAccessToken.trim()) throw new Error("WhatsApp access token is missing.");
  if (!settings.whatsappPhoneNumberId.trim()) throw new Error("WhatsApp phone number ID is missing.");
  const version = settings.whatsappGraphVersion.trim() || "v25.0";
  const url = `https://graph.facebook.com/${version}/${settings.whatsappPhoneNumberId.trim()}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${settings.whatsappAccessToken.trim()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: handle.replace(/[^\d+]/g, ""),
      type: "text",
      text: {
        preview_url: false,
        body: text
      }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(extractApiError(data, `WhatsApp returned ${response.status}.`));
  const receiptId = data?.messages?.[0]?.id;
  return typeof receiptId === "string" ? receiptId : undefined;
}

function messagesDbPath() {
  return path.join(homedir(), "Library", "Messages", "chat.db");
}

let contactNameMap: Map<string, string> | null = null;

function addressBookSourcesPath() {
  return path.join(homedir(), "Library", "Application Support", "AddressBook", "Sources");
}

function escapeSql(value: string) {
  return value.replace(/'/g, "''");
}

async function querySqliteDb<T>(dbPath: string, query: string) {
  const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, query], {
    timeout: 20000,
    maxBuffer: 1024 * 1024 * 8
  });
  return JSON.parse(stdout || "[]") as T[];
}

async function queryMessagesDb<T>(query: string) {
  return querySqliteDb<T>(messagesDbPath(), query);
}

function normalizePhone(handle: string) {
  const digits = handle.replace(/\D/g, "");
  if (digits.length === 10) return `1${digits}`;
  return digits;
}

function addContactKey(map: Map<string, string>, key: string, name: string) {
  const normalizedKey = key.trim().toLowerCase();
  if (normalizedKey && !map.has(normalizedKey)) map.set(normalizedKey, name);
}

function addPhoneContactKeys(map: Map<string, string>, phone: string, name: string) {
  addContactKey(map, phone, name);
  const normalized = normalizePhone(phone);
  if (normalized.length < 7) return;
  addContactKey(map, normalized, name);
  addContactKey(map, `+${normalized}`, name);
  addContactKey(map, normalized.slice(-10), name);
  if (normalized.startsWith("1") && normalized.length === 11) {
    addContactKey(map, normalized.slice(1), name);
    addContactKey(map, `+${normalized.slice(1)}`, name);
  }
}

function buildContactName(row: { first?: string | null; last?: string | null; organization?: string | null; nickname?: string | null }) {
  const fullName = [row.first, row.last]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return fullName || row.organization?.trim() || row.nickname?.trim() || "";
}

async function getAddressBookDbPaths() {
  const sources = await readdir(addressBookSourcesPath(), { withFileTypes: true });
  const dbPaths: string[] = [];
  for (const source of sources) {
    if (!source.isDirectory()) continue;
    const sourcePath = path.join(addressBookSourcesPath(), source.name);
    const files = await readdir(sourcePath, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (file.isFile() && /^AddressBook-v.*\.abcddb$/.test(file.name)) {
        dbPaths.push(path.join(sourcePath, file.name));
      }
    }
  }
  return dbPaths;
}

async function loadContactNameMap() {
  if (contactNameMap) return contactNameMap;
  const map = new Map<string, string>();
  const dbPaths = await getAddressBookDbPaths().catch(() => []);

  for (const dbPath of dbPaths) {
    const phoneRows = await querySqliteDb<{
      first: string | null;
      last: string | null;
      organization: string | null;
      nickname: string | null;
      phone: string;
    }>(
      dbPath,
      `
        SELECT
          r.ZFIRSTNAME AS first,
          r.ZLASTNAME AS last,
          r.ZORGANIZATION AS organization,
          r.ZNICKNAME AS nickname,
          p.ZFULLNUMBER AS phone
        FROM ZABCDRECORD r
        JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
        WHERE p.ZFULLNUMBER IS NOT NULL;
      `
    ).catch(() => []);

    for (const row of phoneRows) {
      const name = buildContactName(row);
      if (name) addPhoneContactKeys(map, row.phone, name);
    }

    const emailRows = await querySqliteDb<{
      first: string | null;
      last: string | null;
      organization: string | null;
      nickname: string | null;
      email: string;
    }>(
      dbPath,
      `
        SELECT
          r.ZFIRSTNAME AS first,
          r.ZLASTNAME AS last,
          r.ZORGANIZATION AS organization,
          r.ZNICKNAME AS nickname,
          e.ZADDRESS AS email
        FROM ZABCDRECORD r
        JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
        WHERE e.ZADDRESS IS NOT NULL;
      `
    ).catch(() => []);

    for (const row of emailRows) {
      const name = buildContactName(row);
      if (name) addContactKey(map, row.email, name);
    }
  }

  if (map.size > 0) contactNameMap = map;
  return map;
}

function stripMessageHandlePrefix(handle: string) {
  const trimmed = handle.trim();
  for (const prefix of ["iMessage;-;", "iMessage;+;", "SMS;-;", "SMS;+;", "any;-;", "any;+;"]) {
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return trimmed;
}

function handleFromGuid(guid?: string) {
  const parts = guid?.split(";") ?? [];
  return parts.length >= 3 ? parts.slice(2).join(";") : "";
}

function resolveContactName(handle: string | undefined, map: Map<string, string>) {
  if (!handle) return "";
  const stripped = stripMessageHandlePrefix(handle);
  const direct = map.get(stripped.toLowerCase());
  if (direct) return direct;

  const normalized = normalizePhone(stripped);
  const keys = [
    normalized,
    `+${normalized}`,
    normalized.length >= 10 ? normalized.slice(-10) : "",
    normalized.length === 10 ? `1${normalized}` : "",
    normalized.length === 10 ? `+1${normalized}` : ""
  ];
  for (const key of keys) {
    const match = key ? map.get(key.toLowerCase()) : undefined;
    if (match) return match;
  }
  return "";
}

function formatResolvedHandle(handle: string | undefined, map: Map<string, string>) {
  const stripped = stripMessageHandlePrefix(handle || "");
  const name = resolveContactName(stripped, map);
  return name && stripped ? `${name} (${stripped})` : name || stripped || "Them";
}

function readTypedstreamLength(buffer: Buffer, offset: number) {
  if (offset >= buffer.length) return { length: -1, dataOffset: offset };
  const first = buffer[offset];
  if (first < 0x80) return { length: first, dataOffset: offset + 1 };
  if (first === 0x81 && offset + 3 <= buffer.length) return { length: buffer.readUInt16LE(offset + 1), dataOffset: offset + 3 };
  if (first === 0x82 && offset + 4 <= buffer.length) {
    return {
      length: buffer[offset + 1] | (buffer[offset + 2] << 8) | (buffer[offset + 3] << 16),
      dataOffset: offset + 4
    };
  }
  if (first === 0x83 && offset + 5 <= buffer.length) return { length: buffer.readUInt32LE(offset + 1), dataOffset: offset + 5 };
  return { length: -1, dataOffset: offset };
}

function extractAttributedTextFromHex(hexValue?: string | null) {
  if (!hexValue) return "";
  try {
    const buffer = Buffer.from(hexValue, "hex");
    if (buffer.length < 20 || buffer[0] !== 0x04 || buffer[1] !== 0x0b) return "";

    const markerIndex = buffer.indexOf("NSString", 0, "utf8");
    const candidateOffsets: number[] = [];
    if (markerIndex >= 0) candidateOffsets.push(markerIndex + "NSString".length + 5);

    for (let index = 0; index < buffer.length - 2; index += 1) {
      if (buffer[index] === 0x01 && buffer[index + 1] === 0x2b) candidateOffsets.push(index + 2);
    }

    for (const offset of candidateOffsets) {
      const { length, dataOffset } = readTypedstreamLength(buffer, offset);
      if (length <= 0 || length > 200000 || dataOffset + length > buffer.length) continue;
      const text = buffer.subarray(dataOffset, dataOffset + length).toString("utf8").trim();
      if (!text) continue;
      return text.replace(/\uFFFC/g, "[Attachment]");
    }
  } catch {
    return "";
  }
  return "";
}

function messageBody(text?: string | null, attributedBodyHex?: string | null) {
  return text?.trim() || extractAttributedTextFromHex(attributedBodyHex);
}

async function listIMessageChats(): Promise<IMessageChat[]> {
  const query = `
    SELECT
      chat.ROWID AS chatId,
      chat.guid AS guid,
      chat.display_name AS rawDisplayName,
      COALESCE(NULLIF(chat.display_name, ''), chat.chat_identifier, 'Unnamed chat') AS displayName,
      chat.chat_identifier AS chatIdentifier,
      chat.service_name AS serviceName,
      chat.last_addressed_handle AS lastAddressedHandle,
      datetime(
        CASE
          WHEN max(message.date) > 1000000000000 THEN max(message.date) / 1000000000 + strftime('%s','2001-01-01')
          ELSE max(message.date) + strftime('%s','2001-01-01')
        END,
        'unixepoch',
        'localtime'
      ) AS lastMessageAt,
      (
        SELECT m2.text
        FROM message m2
        JOIN chat_message_join cmj2 ON cmj2.message_id = m2.ROWID
        WHERE cmj2.chat_id = chat.ROWID
          AND (m2.text IS NOT NULL OR m2.attributedBody IS NOT NULL)
        ORDER BY m2.date DESC
        LIMIT 1
      ) AS lastText,
      (
        SELECT hex(m2.attributedBody)
        FROM message m2
        JOIN chat_message_join cmj2 ON cmj2.message_id = m2.ROWID
        WHERE cmj2.chat_id = chat.ROWID
          AND (m2.text IS NOT NULL OR m2.attributedBody IS NOT NULL)
        ORDER BY m2.date DESC
        LIMIT 1
      ) AS lastAttributedBodyHex,
      COUNT(DISTINCT chat_handle_join.handle_id) AS participantCount,
      GROUP_CONCAT(DISTINCT handle.id) AS participantHandles
    FROM chat
    LEFT JOIN chat_message_join ON chat_message_join.chat_id = chat.ROWID
    LEFT JOIN message ON message.ROWID = chat_message_join.message_id
    LEFT JOIN chat_handle_join ON chat_handle_join.chat_id = chat.ROWID
    LEFT JOIN handle ON handle.ROWID = chat_handle_join.handle_id
    WHERE chat.service_name = 'iMessage'
    GROUP BY chat.ROWID
    HAVING max(message.date) IS NOT NULL
    ORDER BY max(message.date) DESC
    LIMIT 200;
  `;
  const rows = await queryMessagesDb<{
    chatId: number;
    guid: string;
    displayName: string;
    chatIdentifier: string;
    serviceName: string;
    lastAddressedHandle?: string;
    lastMessageAt: string;
    lastText?: string;
    lastAttributedBodyHex?: string;
    rawDisplayName?: string;
    participantCount: number;
    participantHandles?: string;
  }>(query);
  const contacts = await loadContactNameMap().catch(() => new Map<string, string>());

  return rows.map((row) => {
    let participants = (row.participantHandles || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const isGroup = participants.length > 1 || row.guid.includes(";+;");
    const guidHandle = handleFromGuid(row.guid);
    const directHandle = participants[0] || row.chatIdentifier || row.lastAddressedHandle || guidHandle;
    if (!isGroup && participants.length === 0 && directHandle) participants = [directHandle];
    const participantNames = participants.map((handle) => resolveContactName(handle, contacts)).filter(Boolean);
    const contactName = !isGroup ? resolveContactName(directHandle, contacts) : "";
    const fallbackGroupName = participantNames.length > 0 ? participantNames.join(", ") : participants.join(", ");
    const displayName = isGroup
      ? row.rawDisplayName || fallbackGroupName || row.displayName || "Unnamed group"
      : contactName || row.displayName || directHandle || "Unnamed chat";
    return {
      chatId: String(row.chatId),
      guid: row.guid || "",
      displayName,
      contactName,
      chatIdentifier: row.chatIdentifier || row.lastAddressedHandle || directHandle || "",
      serviceName: row.serviceName || "iMessage",
      participantHandles: participants,
      participantNames,
      lastMessageAt: row.lastMessageAt || "",
      lastText: messageBody(row.lastText, row.lastAttributedBodyHex),
      isGroup
    };
  });
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function appendDisclosureToText(settings: AppSettings, rawText: string) {
  return joinMessageParts(appendDisclosureToParts(settings, splitOutgoingText(rawText)));
}

function appendDisclosureToParts(settings: AppSettings, rawParts: string[]) {
  const parts = rawParts.map((part) => part.trim()).filter(Boolean).slice(0, 4);
  if (parts.length === 0) throw new Error("Message is empty.");
  const disclosure = settings.appendDisclosure ? settings.disclosureText.trim() : "";
  if (!disclosure) return parts;
  const last = parts[parts.length - 1];
  if (last === disclosure && parts.length > 1) {
    return [...parts.slice(0, -2), `${parts[parts.length - 2]}\n\n${disclosure}`];
  }
  if (last.endsWith(disclosure)) return parts;
  return [...parts.slice(0, -1), `${last}\n\n${disclosure}`];
}

function outgoingPartsFromTextOrParts(settings: AppSettings, rawText: string, rawParts?: string[]) {
  const parts = rawParts?.length ? rawParts : splitOutgoingText(rawText);
  return appendDisclosureToParts(settings, parts);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatchApprovedMessage(state: AppState, contact: Contact, rawText: string, dryRunOverride?: boolean, rawParts?: string[]) {
  const parts = outgoingPartsFromTextOrParts(state.settings, rawText, rawParts);
  const text = joinMessageParts(parts);

  const dryRun =
    typeof dryRunOverride === "boolean"
      ? dryRunOverride
      : contact.platform === "whatsapp"
        ? state.settings.whatsappDryRun
        : contact.platform === "imessage"
          ? state.settings.iMessageDryRun
          : true;
  if (dryRun || contact.platform === "manual") {
    return {
      ok: true,
      dryRun: true,
      message: "Dry run recorded. No message was sent.",
      detail: text
    };
  }

  if (contact.platform === "imessage") {
    if (!contact.handle.trim()) throw new Error("This iMessage contact needs a phone number or Apple ID handle.");
    const details: string[] = [];
    for (const [index, part] of parts.entries()) {
      const detail = await sendIMessage(contact.handle, part, contact.chatGuid);
      if (detail) details.push(detail);
      if (index < parts.length - 1) await sleep(900);
    }
    return {
      ok: true,
      dryRun: false,
      message: "iMessage send command completed.",
      detail: details.join("\n") || text
    };
  }

  if (contact.platform === "whatsapp") {
    let receiptId: string | undefined;
    for (const [index, part] of parts.entries()) {
      receiptId = await sendWhatsApp(state.settings, contact.handle, part);
      if (index < parts.length - 1) await sleep(900);
    }
    return {
      ok: true,
      dryRun: false,
      message: "WhatsApp Cloud API accepted the message.",
      receiptId,
      detail: text
    };
  }

  throw new Error("Unsupported platform.");
}

async function generateDraftWithSettings(settings: AppSettings, request: unknown) {
  if (settings.aiProvider === "openai") return generateDraftWithOpenAI(settings, request);
  if (settings.aiProvider === "ollama") return generateDraftWithOllama(settings, request);
  return generateDraftWithLocalOpenAI(settings, request);
}

function contactMatchesContact(candidate: Contact, target: Contact) {
  return (
    (!!candidate.chatId && candidate.chatId === target.chatId) ||
    (!!candidate.chatGuid && candidate.chatGuid === target.chatGuid) ||
    candidate.id === target.id
  );
}

function findStoredContact(state: AppState, contact: Contact) {
  return state.contacts.find((item) => contactMatchesContact(item, contact));
}

function canAutoSendDraft(state: AppState, inbound: string, draft: { riskLevel: RiskLevel; requiresHumanReview: boolean; draftText: string; sendEligibility: { canAutoSend: boolean } }) {
  return (
    draft.riskLevel === "low" &&
    !draft.requiresHumanReview &&
    draft.sendEligibility.canAutoSend &&
    !state.settings.requireHumanApproval &&
    detectSensitiveReasons(`${inbound}\n${draft.draftText}`).length === 0
  );
}

function parseTranscriptTimestamp(line: string) {
  const match = line.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

function secondsUntilInboundSettles(inbound: string, waitSeconds = 45) {
  const sentAt = parseTranscriptTimestamp(inbound);
  if (!sentAt) return 0;
  const elapsed = (Date.now() - sentAt.getTime()) / 1000;
  if (elapsed < -5 || elapsed >= waitSeconds) return 0;
  return Math.ceil(waitSeconds - Math.max(0, elapsed));
}

function detectUserInputNeed(inbound: string, draft: DraftResult, availableContext: string, userInstruction: string) {
  const draftText = `${draft.draftText}\n${draft.messageParts.join("\n")}`;
  const reasons: string[] = [];
  if (/NEEDS_USER_INPUT\s*:/i.test(draftText)) {
    reasons.push(draftText.replace(/^.*?NEEDS_USER_INPUT\s*:\s*/is, "").trim() || "The reply needs information from you.");
  }
  if (/\[[^\]]*(?:link|url|site|website|github|email|phone|insert|placeholder)[^\]]*\]/i.test(draftText)) {
    reasons.push("The draft contains placeholder text instead of a real answer.");
  }
  if (/\b(?:site|website|github|portfolio|email|phone|linkedin|instagram)\s+link\b/i.test(draftText)) {
    reasons.push("The draft contains a generic link label instead of a real answer.");
  }

  const asksForPersonalReference =
    /\b(?:what'?s|what is|send|share|drop|remind|again|link)\b[\s\S]{0,120}\b(?:website|site|github|portfolio|email|phone|number|address|linkedin|instagram)\b/i.test(inbound);
  const knownReference = /(https?:\/\/|github\.com\/|[a-z0-9-]+\.(?:com|ai|io|co|net|org|dev|studio|app)\b|@[a-z0-9_.-]{3,})/i.test(
    `${availableContext}\n${userInstruction}`
  );
  if (asksForPersonalReference && !knownReference && !userInstruction.trim()) {
    reasons.push("They asked for a personal link or contact detail, and the app does not have that answer.");
  }

  return Array.from(new Set(reasons.filter(Boolean)));
}

async function prepareAutopilotReply(request: Contact | { contact: Contact; regenerate?: boolean; forceReply?: boolean; skipWait?: boolean; userInstruction?: string }) {
  const state = await readState();
  const contactRequest = "contact" in request ? request.contact : request;
  const regenerate = "contact" in request ? Boolean(request.regenerate) : false;
  const forceReply = "contact" in request ? Boolean(request.forceReply) : false;
  const skipWait = "contact" in request ? Boolean(request.skipWait) : false;
  const userSuppliedInstruction = "contact" in request ? String(request.userInstruction || "").trim() : "";
  const contact = findStoredContact(state, contactRequest) || contactRequest;
  const details: string[] = [];
  if (!contact.allowAutopilot) {
    return { ok: false, status: "idle", message: "Bot is not enabled for this chat.", contact, details };
  }
  if (contact.optedOut) {
    return { ok: false, status: "blocked", message: "This chat is marked opted out.", contact, details };
  }
  if (contact.platform !== "imessage") {
    return { ok: false, status: "blocked", message: "Automatic replies currently support iMessage chats only.", contact, details };
  }

  try {
    const imported = await importIMessageHistory(contact.handle, 40, contact.chatId);
    const inbound = latestInboundLine(imported.messages);
    if (!inbound) {
      return { ok: false, status: "idle", message: "No inbound iMessage found.", contact, details };
    }
    const waitSeconds = !skipWait && !regenerate && !userSuppliedInstruction ? secondsUntilInboundSettles(inbound) : 0;
    if (waitSeconds > 0) {
      return {
        ok: false,
        status: "waiting",
        message: `Waiting ${waitSeconds}s to see if they keep texting before replying.`,
        contact,
        inboundText: inbound,
        waitSeconds,
        details: [`Latest inbound message is still fresh. Waiting avoids replying before a double/triple text finishes.`]
      };
    }
    const inboundHash = hashText(inbound);
    if (!forceReply && contact.lastAutopilotInboundHash === inboundHash) {
      return { ok: false, status: "idle", message: "Latest inbound message already handled.", contact, inboundHash, inboundText: inbound, details };
    }

    const draft = await generateDraftWithSettings(state.settings, {
      contact,
      currentMessage: inbound,
      conversationContext: imported.messages,
      relationshipMemory: contact.notes,
      userInstruction: [
        regenerate
          ? "Autopilot mode. Regenerate a different concise, natural reply in the user's voice. Avoid repeating the previous wording. Only set can_auto_send true and requires_human_review false for simple low-risk acknowledgements, casual replies, or scheduling."
          : "Autopilot mode. Produce a concise, natural reply in the user's voice. Only set can_auto_send true and requires_human_review false for simple low-risk acknowledgements, casual replies, or scheduling.",
        userSuppliedInstruction ? `User-provided answer/instruction: ${userSuppliedInstruction}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    });
    const userInputReasons = detectUserInputNeed(inbound, draft, `${imported.messages}\n${contact.notes}`, userSuppliedInstruction);
    if (userInputReasons.length > 0) {
      contact.lastAutopilotInboundHash = inboundHash;
      contact.lastAutopilotAt = nowIso();
      state.audits = [
        createAudit("message_blocked", `Bot needs input for ${contact.displayName}`, userInputReasons.join(" ")),
        ...state.audits
      ].slice(0, 500);
      await writeState(state);
      return {
        ok: false,
        status: "needs_input",
        message: "I need your answer before replying.",
        contact,
        inboundHash,
        inboundText: inbound,
        draftText: draft.draftText,
        messageParts: draft.messageParts,
        draft,
        details: [...userInputReasons, "Add the answer in Optional instruction for the next reply, then press Start bot again."]
      };
    }

    const preparedParts = appendDisclosureToParts(state.settings, draft.messageParts);
    const preparedText = joinMessageParts(preparedParts);

    if ((!forceReply || draft.riskLevel === "high") && !canAutoSendDraft(state, inbound, draft)) {
      contact.lastAutopilotInboundHash = inboundHash;
      contact.lastAutopilotAt = nowIso();
      state.audits = [
        createAudit("draft_generated", `Bot held reply for ${contact.displayName}`, draft.sendEligibility.explanation),
        ...state.audits
      ].slice(0, 500);
      await writeState(state);
      return {
        ok: false,
        status: "held",
        message: `Bot drafted a reply but held it for review (${draft.riskLevel}).`,
        contact,
        inboundHash,
        inboundText: inbound,
        draftText: preparedText,
        messageParts: preparedParts,
        draft,
        details: [draft.sendEligibility.explanation]
      };
    }

    state.audits = [
      createAudit(
        "draft_generated",
        `Bot ${regenerate ? "regenerated" : forceReply ? "queued fresh" : "queued"} reply for ${contact.displayName}`,
        `Waiting 10 seconds before send. Risk: ${draft.riskLevel}.`
      ),
      ...state.audits
    ].slice(0, 500);
    await writeState(state);
    return {
      ok: true,
      status: "ready",
      message: "Bot reply is ready to send.",
      contact,
      inboundHash,
      inboundText: inbound,
      draftText: preparedText,
      messageParts: preparedParts,
      draft,
      details
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.audits = [createAudit("message_blocked", `Bot could not prepare reply for ${contact.displayName}`, message), ...state.audits].slice(0, 500);
    await writeState(state);
    return { ok: false, status: "blocked", message, contact, details: [message] };
  }
}

async function sendPreparedAutopilotReply(request: { contact: Contact; inboundHash: string; text: string; textParts?: string[] }) {
  const state = await readState();
  const contact = findStoredContact(state, request.contact) || request.contact;
  try {
    const result = await dispatchApprovedMessage(state, contact, request.text, undefined, request.textParts);
    if (result.ok) {
      const stored = findStoredContact(state, contact);
      if (stored) {
        stored.lastAutopilotInboundHash = request.inboundHash;
        stored.lastAutopilotAt = nowIso();
      }
      state.audits = [
        createAudit(result.dryRun ? "message_dry_run" : "message_sent", `Bot ${result.dryRun ? "recorded dry run" : "sent reply"} for ${contact.displayName}`, result.detail || request.text),
        ...state.audits
      ].slice(0, 500);
      await writeState(state);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Send failed.";
    state.audits = [createAudit("message_blocked", `Bot send failed for ${contact.displayName}`, message), ...state.audits].slice(0, 500);
    await writeState(state);
    return { ok: false, dryRun: false, message, detail: message };
  }
}

async function cancelPreparedAutopilotReply(request: { contact: Contact; inboundHash: string; reason?: string }) {
  const state = await readState();
  const contact = findStoredContact(state, request.contact) || request.contact;
  const stored = findStoredContact(state, contact);
  if (stored) {
    stored.lastAutopilotInboundHash = request.inboundHash;
    stored.lastAutopilotAt = nowIso();
  }
  const reason = request.reason || "User cancelled the pending bot send.";
  state.audits = [createAudit("message_blocked", `Cancelled bot reply for ${contact.displayName}`, reason), ...state.audits].slice(0, 500);
  await writeState(state);
  return { ok: true, dryRun: false, message: "Pending bot reply cancelled.", detail: reason };
}

async function runAutopilotOnce(source: "manual" | "timer") {
  const state = await readState();
  const details: string[] = [];
  let scanned = 0;
  let drafted = 0;
  let sent = 0;
  let dryRuns = 0;
  let skipped = 0;
  const maxSends = Math.floor(clampNumber(Number(state.settings.maxAutoSendsPerRun) || 3, 1, 20));

  if (!state.settings.autopilotEnabled && source !== "manual") {
    return { ok: true, scanned, drafted, sent, dryRuns, skipped, message: "Autopilot is disabled.", details };
  }

  for (const contact of state.contacts) {
    if (sent >= maxSends) break;
    if (!contact.allowAutopilot || contact.optedOut || contact.platform !== "imessage") {
      skipped += 1;
      continue;
    }
    scanned += 1;
    try {
      const imported = await importIMessageHistory(contact.handle, 30, contact.chatId);
      const inbound = latestInboundLine(imported.messages);
      if (!inbound) {
        skipped += 1;
        details.push(`${contact.displayName}: no inbound iMessage found.`);
        continue;
      }
      const waitSeconds = secondsUntilInboundSettles(inbound);
      if (waitSeconds > 0) {
        skipped += 1;
        details.push(`${contact.displayName}: waiting ${waitSeconds}s to see if they keep texting.`);
        continue;
      }
      const inboundHash = hashText(inbound);
      if (contact.lastAutopilotInboundHash === inboundHash) {
        const lastFailure = contact.lastAutopilotAt
          ? state.audits.some(
              (event) =>
                event.type === "message_blocked" &&
                event.summary.includes(contact.displayName) &&
                /send failed/i.test(event.summary) &&
                event.at >= contact.lastAutopilotAt!
            )
          : false;
        if (lastFailure) {
          details.push(`${contact.displayName}: retrying latest inbound message after the last send failure.`);
        } else {
          skipped += 1;
          details.push(`${contact.displayName}: latest inbound message already handled.`);
          continue;
        }
      }

      const draft = await generateDraftWithSettings(state.settings, {
        contact,
        currentMessage: inbound,
        conversationContext: imported.messages,
        relationshipMemory: contact.notes,
        userInstruction:
          "Autopilot mode. Only mark can_auto_send true and requires_human_review false for simple low-risk acknowledgements or scheduling replies."
      });
      drafted += 1;

      const userInputReasons = detectUserInputNeed(inbound, draft, `${imported.messages}\n${contact.notes}`, "");
      if (userInputReasons.length > 0) {
        contact.lastAutopilotInboundHash = inboundHash;
        contact.lastAutopilotAt = nowIso();
        skipped += 1;
        details.push(`${contact.displayName}: needs your input before replying.`);
        state.audits = [
          createAudit("message_blocked", `Autopilot needs input for ${contact.displayName}`, userInputReasons.join(" ")),
          ...state.audits
        ].slice(0, 500);
        continue;
      }

      const canAutoSend =
        draft.riskLevel === "low" &&
        !draft.requiresHumanReview &&
        draft.sendEligibility.canAutoSend &&
        !state.settings.requireHumanApproval &&
        detectSensitiveReasons(`${inbound}\n${draft.draftText}`).length === 0;

      if (!canAutoSend) {
        contact.lastAutopilotInboundHash = inboundHash;
        contact.lastAutopilotAt = nowIso();
        skipped += 1;
        details.push(`${contact.displayName}: drafted but held for review (${draft.riskLevel}).`);
        state.audits = [
          createAudit("draft_generated", `Autopilot held draft for ${contact.displayName}`, draft.sendEligibility.explanation),
          ...state.audits
        ].slice(0, 500);
        continue;
      }

      const result = await dispatchApprovedMessage(state, contact, draft.draftText, undefined, draft.messageParts);
      if (result.dryRun) dryRuns += 1;
      else sent += 1;
      contact.lastAutopilotInboundHash = inboundHash;
      contact.lastAutopilotAt = nowIso();
      details.push(`${contact.displayName}: ${result.message}`);
      state.audits = [
        createAudit(result.dryRun ? "message_dry_run" : "message_sent", `Autopilot ${result.dryRun ? "dry run" : "sent"} for ${contact.displayName}`, result.detail),
        ...state.audits
      ].slice(0, 500);
    } catch (error) {
      skipped += 1;
      const message = error instanceof Error ? error.message : String(error);
      details.push(`${contact.displayName}: ${message}`);
      state.audits = [createAudit("message_blocked", `Autopilot skipped ${contact.displayName}`, message), ...state.audits].slice(0, 500);
    }
  }

  state.audits = [
    createAudit("provider_test", `Autopilot ${source} run completed`, `Scanned ${scanned}, drafted ${drafted}, sent ${sent}, dry runs ${dryRuns}, skipped ${skipped}`),
    ...state.audits
  ].slice(0, 500);
  await writeState(state);
  return {
    ok: true,
    scanned,
    drafted,
    sent,
    dryRuns,
    skipped,
    message: `Scanned ${scanned}, drafted ${drafted}, sent ${sent}, dry runs ${dryRuns}, skipped ${skipped}.`,
    details
  };
}

async function importIMessageHistory(handle: string, limit: number, chatId?: string) {
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 500);
  const safeChatId = chatId ? Math.floor(Number(chatId)) : null;
  if (!safeChatId && !handle.trim()) throw new Error("Select an iMessage chat or enter a phone number / Apple ID handle first.");
  const safeHandle = escapeSql(handle);
  const whereClause = safeChatId
    ? `cmj.chat_id = ${safeChatId}`
    : `(handle.id = '${safeHandle}' OR handle.id LIKE '%${safeHandle}%')`;
  const query = `
    SELECT
      message.ROWID AS id,
      message.is_from_me AS is_from_me,
      handle.id AS handle,
      message.text AS text,
      hex(message.attributedBody) AS attributedBodyHex,
      datetime(
        CASE
          WHEN message.date > 1000000000000 THEN message.date / 1000000000 + strftime('%s','2001-01-01')
          ELSE message.date + strftime('%s','2001-01-01')
        END,
        'unixepoch',
        'localtime'
      ) AS sent_at
    FROM message
    JOIN chat_message_join cmj ON cmj.message_id = message.ROWID
    LEFT JOIN handle ON message.handle_id = handle.ROWID
    WHERE (message.text IS NOT NULL OR message.attributedBody IS NOT NULL)
      AND ${whereClause}
    ORDER BY message.date DESC
    LIMIT ${safeLimit};
  `;
  const rows = await queryMessagesDb<{
    is_from_me: number;
    handle: string;
    text: string;
    attributedBodyHex?: string;
    sent_at: string;
  }>(query);
  const contacts = await loadContactNameMap().catch(() => new Map<string, string>());
  const lines = rows
    .reverse()
    .map((row) => {
      const body = messageBody(row.text, row.attributedBodyHex) || "[No text content]";
      return `${row.sent_at} ${row.is_from_me ? "Me" : formatResolvedHandle(row.handle || handle, contacts)}: ${body}`;
    })
    .join("\n");
  return {
    messages: lines,
    count: rows.length
  };
}

async function checkMacPermissions() {
  let messagesDatabase = {
    ok: false,
    label: "Messages database",
    detail: "Cannot read ~/Library/Messages/chat.db."
  };
  let contactsDatabase = {
    ok: false,
    label: "Contacts database",
    detail: "Cannot read Apple Contacts names."
  };
  let messagesAutomation = {
    ok: false,
    label: "Messages automation",
    detail: "Messages.app automation is not available yet."
  };

  try {
    const rows = await queryMessagesDb<{ count: number }>("SELECT COUNT(*) AS count FROM chat;");
    messagesDatabase = {
      ok: true,
      label: "Messages database",
      detail: `Readable. Found ${rows[0]?.count ?? 0} chats.`
    };
  } catch (error) {
    messagesDatabase = {
      ...messagesDatabase,
      detail: `Grant Full Disk Access to this app or the terminal launching it. ${error instanceof Error ? error.message : String(error)}`
    };
  }

  try {
    const dbPaths = await getAddressBookDbPaths();
    const names = new Set((await loadContactNameMap()).values());
    contactsDatabase = {
      ok: dbPaths.length > 0 && names.size > 0,
      label: "Contacts database",
      detail:
        dbPaths.length === 0
          ? "No AddressBook database files were found."
          : names.size > 0
            ? `Readable. Resolved ${names.size} contact names.`
            : "AddressBook files exist, but no readable contact names were found. Check Contacts permission."
    };
  } catch (error) {
    contactsDatabase = {
      ...contactsDatabase,
      detail: `Grant Contacts or Full Disk Access to this app. ${error instanceof Error ? error.message : String(error)}`
    };
  }

  try {
    await execFileAsync("osascript", ["-e", 'tell application "Messages" to get name'], { timeout: 10000 });
    messagesAutomation = {
      ok: true,
      label: "Messages automation",
      detail: "Messages.app accepted AppleScript automation."
    };
  } catch (error) {
    messagesAutomation = {
      ...messagesAutomation,
      detail: `Run a send once and allow Automation for Messages.app if macOS prompts. ${error instanceof Error ? error.message : String(error)}`
    };
  }

  return { messagesDatabase, contactsDatabase, messagesAutomation };
}

async function createWindow() {
  const preload = path.join(__dirname, "preload.js");
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1060,
    minHeight: 760,
    title: "SocializeAI",
    backgroundColor: "#f4efe5",
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

ipcMain.handle("state:get", async () => readState());

ipcMain.handle("state:save", async (_event, state: AppState) => {
  const normalized: AppState = {
    settings: { ...defaultSettings, ...state.settings },
    contacts: Array.isArray(state.contacts) ? state.contacts : [],
    audits: Array.isArray(state.audits) ? state.audits.slice(-500) : []
  };
  await writeState(normalized);
  await rescheduleAutopilot();
  return normalized;
});

ipcMain.handle("onboarding:complete", async (_event, settings: AppSettings) => {
  const state = await readState();
  const next: AppState = {
    ...state,
    settings: { ...defaultSettings, ...state.settings, ...settings, hasCompletedOnboarding: true },
    audits: [
      createAudit("onboarding_completed", "Completed onboarding", `Provider: ${settings.aiProvider}`),
      ...state.audits
    ].slice(0, 500)
  };
  await writeState(next);
  await rescheduleAutopilot();
  return next;
});

ipcMain.handle("provider:test", async (_event, settings: AppSettings) => {
  const result = await testProvider({ ...defaultSettings, ...settings });
  const state = await readState();
  state.audits = [
    createAudit("provider_test", result.ok ? "Provider test passed" : "Provider test failed", result.message),
    ...state.audits
  ].slice(0, 500);
  await writeState(state);
  return result;
});

ipcMain.handle("draft:generate", async (_event, request: unknown) => {
  const state = await readState();
  try {
    const settings = state.settings;
    let result: DraftResult;
    if (settings.aiProvider === "openai") result = await generateDraftWithOpenAI(settings, request);
    else if (settings.aiProvider === "ollama") result = await generateDraftWithOllama(settings, request);
    else result = await generateDraftWithLocalOpenAI(settings, request);

    state.audits = [
      createAudit("draft_generated", `Draft generated with ${result.provider}`, `Model: ${result.model}; risk: ${result.riskLevel}`),
      ...state.audits
    ].slice(0, 500);
    await writeState(state);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Draft generation failed.";
    state.audits = [createAudit("draft_failed", "Draft generation failed", message), ...state.audits].slice(0, 500);
    await writeState(state);
    throw error;
  }
});

ipcMain.handle("message:send", async (_event, request: { contact: Contact; text: string; dryRunOverride?: boolean }) => {
  const state = await readState();
  const contact = request.contact;
  if (!contact) throw new Error("Choose a contact and write a message first.");
  const text = joinMessageParts(outgoingPartsFromTextOrParts(state.settings, request.text));
  if (contact.optedOut) {
    state.audits = [createAudit("message_blocked", `Blocked send to ${contact.displayName}`, "Contact is opted out."), ...state.audits].slice(0, 500);
    await writeState(state);
    return { ok: false, dryRun: false, message: "Blocked: this contact is opted out." };
  }
  const sensitive = detectSensitiveReasons(text);
  if (sensitive.includes("password_or_secret") || sensitive.includes("self_harm_or_emergency")) {
    state.audits = [createAudit("message_blocked", `Blocked send to ${contact.displayName}`, sensitive.join(", ")), ...state.audits].slice(0, 500);
    await writeState(state);
    return { ok: false, dryRun: false, message: "Blocked: sensitive or emergency content needs direct human handling.", detail: sensitive.join(", ") };
  }

  try {
    const result = await dispatchApprovedMessage(state, contact, request.text, request.dryRunOverride);
    state.audits = [
      createAudit(
        result.dryRun ? "message_dry_run" : "message_sent",
        result.dryRun ? `Dry run for ${contact.displayName}` : `Sent ${contact.platform === "whatsapp" ? "WhatsApp message" : "iMessage"} to ${contact.displayName}`,
        result.detail || text
      ),
      ...state.audits
    ].slice(0, 500);
    await writeState(state);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Send failed.";
    state.audits = [createAudit("message_blocked", `Send failed for ${contact.displayName}`, message), ...state.audits].slice(0, 500);
    await writeState(state);
    return { ok: false, dryRun: false, message, detail: message };
  }
});

ipcMain.handle("imessage:list-chats", async () => {
  try {
    return await listIMessageChats();
  } catch (error) {
    throw new Error("Messages access is blocked. Grant Full Disk Access to SocializeAI, then quit and relaunch the app.");
  }
});

ipcMain.handle("imessage:import-history", async (_event, request: { handle: string; chatId?: string; limit: number }) => {
  const state = await readState();
  try {
    const result = await importIMessageHistory(request.handle, request.limit, request.chatId);
    state.audits = [
      createAudit("history_imported", `Imported ${result.count} iMessage rows`, request.chatId ? `Chat: ${request.chatId}` : `Handle: ${request.handle}`),
      ...state.audits
    ].slice(0, 500);
    await writeState(state);
    return { ok: true, count: result.count, messages: result.messages, message: `Imported ${result.count} messages.` };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      messages: "",
      message: "Could not import iMessage history. Grant Full Disk Access to this app or paste context manually.",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
});

ipcMain.handle("autopilot:run-once", async () => runAutopilotOnce("manual"));

ipcMain.handle("autopilot:prepare-reply", async (_event, request: Contact | { contact: Contact; regenerate?: boolean; forceReply?: boolean; skipWait?: boolean; userInstruction?: string }) =>
  prepareAutopilotReply(request)
);

ipcMain.handle("autopilot:send-prepared", async (_event, request: { contact: Contact; inboundHash: string; text: string; textParts?: string[] }) =>
  sendPreparedAutopilotReply(request)
);

ipcMain.handle("autopilot:cancel-prepared", async (_event, request: { contact: Contact; inboundHash: string; reason?: string }) => cancelPreparedAutopilotReply(request));

ipcMain.handle("mac:check-permissions", async () => checkMacPermissions());

ipcMain.handle("mac:open-full-disk-access", async () => {
  await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles");
});

ipcMain.handle("app:reveal-data-folder", async () => {
  await shell.openPath(app.getPath("userData"));
});

app.whenReady().then(async () => {
  await createWindow();
  await rescheduleAutopilot();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
