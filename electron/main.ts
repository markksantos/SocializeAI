import { app, BrowserWindow, ipcMain, safeStorage, shell } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { arch, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { latestInboundLine } from "./transcript.js";

const execFileAsync = promisify(execFile);

type AiProvider = "openai" | "ollama" | "local-openai";
type Platform = "imessage" | "whatsapp" | "manual";
type WhatsAppProvider = "personal_bridge" | "business_cloud";
type PermissionMode = "extra_safe" | "safe" | "auto_review" | "dangerously_skip";
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
  globalUserContext: string;
  iMessageDryRun: boolean;
  whatsappDryRun: boolean;
  whatsappProvider: WhatsAppProvider;
  whatsappBridgeUrl: string;
  whatsappBridgeToken: string;
  whatsappMessagesDbPath: string;
  whatsappAccessToken: string;
  whatsappPhoneNumberId: string;
  whatsappGraphVersion: string;
  permissionMode: PermissionMode;
  requireHumanApproval: boolean;
  autopilotEnabled: boolean;
  autopilotIntervalMinutes: number;
  maxAutoSendsPerRun: number;
  appendDisclosure: boolean;
  disclosureText: string;
  privacyBlurEnabled: boolean;
  darkModeEnabled: boolean;
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
  userInstruction?: string;
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

type WhatsAppChat = {
  chatId: string;
  jid: string;
  displayName: string;
  contactName?: string;
  chatIdentifier: string;
  serviceName: "WhatsApp";
  participantHandles: string[];
  participantNames?: string[];
  lastMessageAt: string;
  lastText: string;
  isGroup: boolean;
};

type WhatsAppBridgeStatus = {
  ok: boolean;
  connected: boolean;
  message: string;
  bridgeUrl: string;
  tokenConfigured: boolean;
  databasePath?: string;
  bridgePath?: string;
  setupAction?: string;
  detail?: string;
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
  globalUserContext: "",
  iMessageDryRun: true,
  whatsappDryRun: true,
  whatsappProvider: "personal_bridge",
  whatsappBridgeUrl: "http://127.0.0.1:8080/api",
  whatsappBridgeToken: "",
  whatsappMessagesDbPath: "",
  whatsappAccessToken: "",
  whatsappPhoneNumberId: "",
  whatsappGraphVersion: "v25.0",
  permissionMode: "safe",
  requireHumanApproval: true,
  autopilotEnabled: false,
  autopilotIntervalMinutes: 10,
  maxAutoSendsPerRun: 3,
  appendDisclosure: false,
  disclosureText: "Sent with AI assistance.",
  privacyBlurEnabled: false,
  darkModeEnabled: true
};

let autopilotTimer: NodeJS.Timeout | null = null;
let managedWhatsAppBridgeProcess: ChildProcess | null = null;
let managedWhatsAppBridgeRestartTimer: NodeJS.Timeout | null = null;
let managedWhatsAppBridgeDesired = false;
let managedWhatsAppBridgeLastSettings: AppSettings | null = null;
let managedWhatsAppBridgeStarting: Promise<void> | null = null;
let managedWhatsAppBridgeExitCount = 0;
let managedWhatsAppBridgeFirstExitAt = 0;

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
  settings: Omit<AppSettings, "openAiApiKey" | "whatsappAccessToken" | "whatsappBridgeToken"> & {
    openAiApiKeyCipher?: string;
    whatsappAccessTokenCipher?: string;
    whatsappBridgeTokenCipher?: string;
  };
};

function toDiskState(state: AppState): DiskState {
  const { openAiApiKey, whatsappAccessToken, whatsappBridgeToken, ...settings } = state.settings;
  return {
    ...state,
    settings: {
      ...settings,
      openAiApiKeyCipher: encryptSecret(openAiApiKey),
      whatsappAccessTokenCipher: encryptSecret(whatsappAccessToken),
      whatsappBridgeTokenCipher: encryptSecret(whatsappBridgeToken)
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
      whatsappAccessToken: decryptSecret(settings.whatsappAccessTokenCipher),
      whatsappBridgeToken: decryptSecret(settings.whatsappBridgeTokenCipher)
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

function permissionModePrompt(settings: AppSettings) {
  switch (settings.permissionMode) {
    case "extra_safe":
      return "Permission mode: extra safe. Draft normally, but assume the app will ask the user before any message sends.";
    case "auto_review":
      return "Permission mode: auto review. Only require review for ultra-sensitive medical, legal, financial, password/secret, emergency/self-harm, or truly unknown personal facts. Routine affection in established relationships and casual personal chat should not require review.";
    case "dangerously_skip":
      return "Permission mode: dangerously skip permissions. Do not return NEEDS_USER_INPUT and do not ask for review. If a personal fact is missing, write the most plausible casual answer from context, keep it vague when uncertain, and never use bracket placeholders.";
    case "safe":
    default:
      return "Permission mode: safe. Require review for genuinely sensitive or ambiguous messages, but routine casual replies and established-relationship affection should be allowed.";
  }
}

function buildSystemPrompt(settings: AppSettings) {
  const missingFactRule =
    settings.permissionMode === "dangerously_skip"
      ? "If the reply needs a personal fact that is not in the conversation, make the most plausible casual answer from context. Keep it vague if uncertain. Do not return NEEDS_USER_INPUT and do not use placeholders."
      : "If the reply needs a personal fact that is not in the conversation, global user context, relationship memory, contact notes, or user instruction, do not guess and do not use placeholders. This includes website, GitHub, Discord, Telegram, email, phone, social handles, or contact details. Return draft_text as NEEDS_USER_INPUT: followed by the missing fact.";
  const reviewRule =
    settings.permissionMode === "dangerously_skip"
      ? "Do not require human review. Draft the best reply the user would plausibly send based on context."
      : "If context is ambiguous or sensitive, require human review.";
  return [
    "You draft personal text replies on behalf of the app user.",
    "Use the global user context for stable facts about the app user and standing style instructions.",
    permissionModePrompt(settings),
    "Match the user's relationship-specific tone without inventing facts, plans, feelings, locations, money commitments, or promises.",
    "Use message_parts for separate outgoing text bubbles. Use 1 part for a normal reply, or 2-4 short parts when double/triple texting would sound more natural.",
    "draft_text must equal message_parts joined with a blank line between parts.",
    "If the other person sent multiple consecutive messages, reply to the full cluster, not only the last line.",
    missingFactRule,
    reviewRule,
    "Never claim the user did something they did not say they did.",
    "Return only JSON matching the requested schema."
  ].join("\n");
}

function buildDraftPrompt(settings: AppSettings, input: {
  contact: Contact;
  currentMessage: string;
  conversationContext: string;
  relationshipMemory: string;
  userInstruction: string;
}) {
  return [
    "Global user context and standing instructions:",
    settings.globalUserContext.trim() || "none",
    "",
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
  if (/(break up|divorce|romantic|sex|cheat|dating)/.test(lower)) {
    reasons.add("romantic_or_sensitive");
  }
  if (/(angry|mad at me|fight|argument|upset|betray|lied|hate)/.test(lower)) {
    reasons.add("conflict");
  }
  return [...reasons];
}

function getPermissionMode(settings: AppSettings): PermissionMode {
  return settings.permissionMode || "safe";
}

function hasUltraSensitiveReason(reasons: string[]) {
  return reasons.some((reason) =>
    ["password_or_secret", "self_harm_or_emergency", "medical_or_health", "financial", "legal", "platform_policy"].includes(reason)
  );
}

function isEstablishedRomanticRelationship(contact: Contact) {
  return /\b(fianc[eé]e?|wife|husband|spouse|partner|girlfriend|boyfriend)\b/i.test(`${contact.relationship}\n${contact.notes}`);
}

function isRoutineAffectionText(text: string) {
  return /\b(i\s+love\s+you|love\s+you|ily)\b/i.test(text) && !/(break up|divorce|sex|cheat|dating|angry|fight|argument|upset|hate)/i.test(text);
}

function relaxRoutineAffectionRisk(contact: Contact, inbound: string, draft: DraftResult): DraftResult {
  const combined = `${inbound}\n${draft.draftText}\n${draft.messageParts.join("\n")}`;
  if (!isEstablishedRomanticRelationship(contact) || !isRoutineAffectionText(combined)) return draft;
  const nonRomanticSensitive = detectSensitiveReasons(combined).filter((reason) => reason !== "romantic_or_sensitive");
  if (nonRomanticSensitive.length > 0) return draft;
  return {
    ...draft,
    riskLevel: draft.riskLevel === "blocked" ? "blocked" : "low",
    requiresHumanReview: false,
    reasonCodes: draft.reasonCodes.filter((reason) => reason !== "romantic_or_sensitive"),
    sendEligibility: {
      canAutoSend: true,
      explanation: "Routine affection in an established relationship."
    }
  };
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
      instructions: buildSystemPrompt(settings),
      input: buildDraftPrompt(settings, input),
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
        { role: "system", content: buildSystemPrompt(settings) },
        {
          role: "user",
          content: `${buildDraftPrompt(settings, input)}\n\nReturn JSON with keys: draft_text, message_parts, confidence, risk_level, requires_human_review, reason_codes, send_eligibility, memory_updates.`
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
        { role: "system", content: buildSystemPrompt(settings) },
        {
          role: "user",
          content: `${buildDraftPrompt(settings, input)}\n\nReturn JSON with keys: draft_text, message_parts, confidence, risk_level, requires_human_review, reason_codes, send_eligibility, memory_updates.`
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

async function sendWhatsAppBusiness(settings: AppSettings, handle: string, text: string) {
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

function whatsappBridgeApiUrl(settings: AppSettings) {
  const raw = trimTrailingSlash(settings.whatsappBridgeUrl.trim() || defaultSettings.whatsappBridgeUrl);
  return raw.endsWith("/api") ? raw : `${raw}/api`;
}

const WHATSAPP_BRIDGE_REPO_URL = "https://github.com/verygoodplugins/whatsapp-mcp.git";
const GO_DOWNLOAD_INDEX_URL = "https://go.dev/dl/?mode=json";

function managedWhatsAppRepoPath() {
  return path.join(app.getPath("userData"), "whatsapp-mcp");
}

function managedWhatsAppBridgePath() {
  return path.join(managedWhatsAppRepoPath(), "whatsapp-bridge");
}

function managedWhatsAppMessagesDbPath() {
  return path.join(managedWhatsAppBridgePath(), "store", "messages.db");
}

function managedWhatsAppTokenPath() {
  return path.join(managedWhatsAppBridgePath(), "store", ".bridge-token");
}

function managedWhatsAppBridgeLogPath() {
  return path.join(app.getPath("userData"), "whatsapp-bridge.log");
}

function managedRuntimePath() {
  return path.join(app.getPath("userData"), "runtime");
}

function managedGoRootPath() {
  return path.join(managedRuntimePath(), "go");
}

function managedGoBinaryPath() {
  return path.join(managedGoRootPath(), "bin", "go");
}

function normalizeLocalPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return path.join(homedir(), trimmed.slice(2));
  return trimmed;
}

function uniqueNonEmpty(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandPath(command: string) {
  const commonMacPaths: Record<string, string[]> = {
    go: [managedGoBinaryPath(), "/usr/local/go/bin/go", "/opt/homebrew/bin/go", "/usr/local/bin/go"],
    git: ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]
  };
  try {
    const { stdout } = await execFileAsync("which", [command]);
    const resolved = stdout.trim().split("\n")[0];
    if (resolved) return resolved;
  } catch {
    // GUI-launched apps often have a smaller PATH than Terminal.
  }
  for (const candidate of commonMacPaths[command] || []) {
    if (await fileExists(candidate)) return candidate;
  }
  return "";
}

function goDownloadArch() {
  const cpu = arch();
  if (cpu === "arm64") return "arm64";
  if (cpu === "x64") return "amd64";
  return "";
}

async function resolveGoDownload() {
  if (process.platform !== "darwin") {
    throw new Error("Automatic WhatsApp runtime setup currently supports macOS only.");
  }
  const fileArch = goDownloadArch();
  if (!fileArch) throw new Error(`Unsupported Mac architecture for automatic Go setup: ${arch()}.`);

  const response = await fetch(GO_DOWNLOAD_INDEX_URL);
  if (!response.ok) throw new Error(`Go download index returned ${response.status}.`);
  const releases = (await response.json()) as Array<{
    version?: string;
    stable?: boolean;
    files?: Array<{ filename?: string; os?: string; arch?: string; kind?: string }>;
  }>;
  const release = releases.find((item) => item.stable && item.files?.some((file) => file.os === "darwin" && file.arch === fileArch && file.kind === "archive"));
  const file = release?.files?.find((item) => item.os === "darwin" && item.arch === fileArch && item.kind === "archive");
  if (!release?.version || !file?.filename) throw new Error("Could not find a stable macOS Go archive.");
  return {
    version: release.version,
    url: `https://go.dev/dl/${file.filename}`
  };
}

async function installManagedGoRuntime() {
  const existing = managedGoBinaryPath();
  if (await fileExists(existing)) return existing;

  const download = await resolveGoDownload();
  const runtimePath = managedRuntimePath();
  const archivePath = path.join(runtimePath, `${download.version}.darwin-${goDownloadArch()}.tar.gz`);
  await mkdir(runtimePath, { recursive: true });
  await rm(managedGoRootPath(), { recursive: true, force: true });

  const response = await fetch(download.url);
  if (!response.ok) throw new Error(`Go runtime download returned ${response.status}.`);
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
  try {
    await execFileAsync("tar", ["-xzf", archivePath, "-C", runtimePath], { timeout: 120000, maxBuffer: 1024 * 1024 * 10 });
  } finally {
    await rm(archivePath, { force: true }).catch(() => undefined);
  }

  if (!(await fileExists(existing))) throw new Error("The Go runtime archive extracted, but the go binary was not found.");
  return existing;
}

async function ensureGoRuntime() {
  const existing = await resolveCommandPath("go");
  if (existing) return existing;
  return installManagedGoRuntime();
}

function whatsAppDbCandidates(settings: AppSettings) {
  const configured = normalizeLocalPath(settings.whatsappMessagesDbPath);
  const repoNames = ["whatsapp-mcp", "whatsapp-mcp-main", "verygoodplugins-whatsapp-mcp"];
  const roots = [
    homedir(),
    path.join(homedir(), "Documents"),
    path.join(homedir(), "Developer"),
    path.join(homedir(), "Projects"),
    process.cwd()
  ];
  const commonCheckoutPaths = roots.flatMap((root) =>
    repoNames.flatMap((repoName) => [
      path.join(root, repoName, "whatsapp-bridge", "store", "messages.db"),
      path.join(root, repoName, "store", "messages.db")
    ])
  );

  return uniqueNonEmpty([
    configured,
    process.env.WHATSAPP_DB_PATH || "",
    managedWhatsAppMessagesDbPath(),
    path.join(app.getPath("userData"), "whatsapp-bridge", "store", "messages.db"),
    path.join(process.cwd(), "whatsapp-bridge", "store", "messages.db"),
    ...commonCheckoutPaths
  ]);
}

async function resolveWhatsAppMessagesDbPath(settings: AppSettings) {
  const configured = normalizeLocalPath(settings.whatsappMessagesDbPath);
  const candidates = whatsAppDbCandidates(settings);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }

  const managedCandidates = new Set([managedWhatsAppMessagesDbPath(), path.join(app.getPath("userData"), "whatsapp-bridge", "store", "messages.db")]);
  const configuredLooksManaged = configured && managedCandidates.has(configured);
  throw new Error(
    configured && !configuredLooksManaged
      ? `WhatsApp messages database was not found at ${configured}. Choose the bridge messages.db path or run Start bridge again.`
      : "WhatsApp is not paired yet. Click Start bridge, scan the QR code in Terminal, then refresh WhatsApp chats."
  );
}

async function resolveWhatsAppBridgeToken(settings: AppSettings) {
  const configured = settings.whatsappBridgeToken.trim();
  if (configured) return configured;
  if (process.env.WHATSAPP_BRIDGE_TOKEN?.trim()) return process.env.WHATSAPP_BRIDGE_TOKEN.trim();

  const tokenCandidates: string[] = [managedWhatsAppTokenPath()];
  try {
    const dbPath = await resolveWhatsAppMessagesDbPath(settings);
    tokenCandidates.unshift(path.join(path.dirname(dbPath), ".bridge-token"));
  } catch {
    // The bridge may be starting before messages.db exists; still check the managed token path.
  }

  for (const tokenPath of uniqueNonEmpty(tokenCandidates)) {
    try {
      return (await readFile(tokenPath, "utf8")).trim();
    } catch {
      // Try the next likely token location.
    }
  }

  return "";
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function ensureWhatsAppBridgeCheckout() {
  const repoPath = managedWhatsAppRepoPath();
  const bridgePath = managedWhatsAppBridgePath();
  if (await fileExists(bridgePath)) return bridgePath;

  const gitPath = await resolveCommandPath("git");
  if (!gitPath) throw new Error("Git is required to install the WhatsApp bridge. Install Git or Xcode Command Line Tools first, then click Start bridge again.");

  await mkdir(path.dirname(repoPath), { recursive: true });
  if (await fileExists(repoPath)) await rm(repoPath, { recursive: true, force: true });
  await execFileAsync(gitPath, ["clone", WHATSAPP_BRIDGE_REPO_URL, repoPath], { maxBuffer: 1024 * 1024 * 10 });
  return bridgePath;
}

async function appendWhatsAppBridgeLog(message: string) {
  const logPath = managedWhatsAppBridgeLogPath();
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, `${message}\n`, { flag: "a" });
}

function whatsAppBridgeEnv(goPath: string) {
  const goRoot = path.dirname(path.dirname(goPath));
  return {
    ...process.env,
    GOROOT: goRoot,
    PATH: `${path.dirname(goPath)}:${process.env.PATH || ""}`
  };
}

async function fetchWhatsAppBridgeHealth(settings: AppSettings, timeoutMs = 2500) {
  const token = await resolveWhatsAppBridgeToken(settings);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${whatsappBridgeApiUrl(settings)}/health`, {
      headers: whatsAppBridgeHeaders(token),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    return { response, data, token };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForWhatsAppBridgeHealth(settings: AppSettings, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const health = await fetchWhatsAppBridgeHealth(settings, 1500);
      if (health.response.status !== 0) return health;
    } catch {
      await sleep(700);
    }
  }
  return null;
}

async function openWhatsAppBridgeLogTerminal() {
  const logPath = managedWhatsAppBridgeLogPath();
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeFile(logPath, "", { flag: "a" });
  const command = `echo 'SocializeAI WhatsApp bridge log. Scan the QR code here when it appears.' && tail -n 200 -f ${shellQuote(logPath)}`;
  const script = `
    tell application "Terminal"
      activate
      do script ${JSON.stringify(command)}
    end tell
  `;
  await execFileAsync("osascript", ["-e", script]);
}

async function startManagedWhatsAppBridgeProcess(settings: AppSettings, reason: string) {
  if (settings.whatsappProvider !== "personal_bridge") return;
  if (managedWhatsAppBridgeProcess && !managedWhatsAppBridgeProcess.killed) return;
  if (managedWhatsAppBridgeStarting) return managedWhatsAppBridgeStarting;

  managedWhatsAppBridgeDesired = true;
  managedWhatsAppBridgeLastSettings = settings;

  managedWhatsAppBridgeStarting = (async () => {
    const bridgePath = await ensureWhatsAppBridgeCheckout();
    const goPath = await ensureGoRuntime();
    const logPath = managedWhatsAppBridgeLogPath();
    await mkdir(path.dirname(logPath), { recursive: true });
    await appendWhatsAppBridgeLog(`[${nowIso()}] Starting WhatsApp bridge (${reason}) from ${bridgePath}`);

    const output = createWriteStream(logPath, { flags: "a" });
    const child = spawn(goPath, ["run", "."], {
      cwd: bridgePath,
      env: whatsAppBridgeEnv(goPath),
      stdio: ["ignore", "pipe", "pipe"]
    });
    managedWhatsAppBridgeProcess = child;
    child.stdout.pipe(output, { end: false });
    child.stderr.pipe(output, { end: false });
    setTimeout(() => {
      if (managedWhatsAppBridgeProcess === child) {
        managedWhatsAppBridgeExitCount = 0;
        managedWhatsAppBridgeFirstExitAt = 0;
      }
    }, 30000);
    child.on("exit", (code, signal) => {
      output.write(`\n[${nowIso()}] WhatsApp bridge exited with code ${code ?? "null"} signal ${signal ?? "none"}.\n`);
      output.end();
      if (managedWhatsAppBridgeProcess === child) managedWhatsAppBridgeProcess = null;
      const exitedAt = Date.now();
      if (!managedWhatsAppBridgeFirstExitAt || exitedAt - managedWhatsAppBridgeFirstExitAt > 60000) {
        managedWhatsAppBridgeFirstExitAt = exitedAt;
        managedWhatsAppBridgeExitCount = 0;
      }
      managedWhatsAppBridgeExitCount += 1;
      if (managedWhatsAppBridgeExitCount > 5) {
        void appendWhatsAppBridgeLog(`[${nowIso()}] WhatsApp bridge restart paused after repeated exits. Click Start bridge after checking the log.`);
        return;
      }
      if (managedWhatsAppBridgeDesired && managedWhatsAppBridgeLastSettings && !managedWhatsAppBridgeRestartTimer) {
        managedWhatsAppBridgeRestartTimer = setTimeout(() => {
          managedWhatsAppBridgeRestartTimer = null;
          void startManagedWhatsAppBridgeProcess(managedWhatsAppBridgeLastSettings!, "restart after exit").catch((error) =>
            appendWhatsAppBridgeLog(`[${nowIso()}] Bridge restart failed: ${errorMessage(error)}`)
          );
        }, 4000);
      }
    });
    child.on("error", (error) => {
      void appendWhatsAppBridgeLog(`[${nowIso()}] WhatsApp bridge process error: ${errorMessage(error)}`);
    });
  })();

  try {
    await managedWhatsAppBridgeStarting;
  } finally {
    managedWhatsAppBridgeStarting = null;
  }
}

async function ensureWhatsAppBridgeRunning(settings: AppSettings, reason: string) {
  if (settings.whatsappProvider !== "personal_bridge") return;
  try {
    await fetchWhatsAppBridgeHealth(settings);
    return;
  } catch {
    await startManagedWhatsAppBridgeProcess(settings, reason);
    await waitForWhatsAppBridgeHealth(settings, 8000);
  }
}

async function startWhatsAppBridge(settings: AppSettings): Promise<WhatsAppBridgeStatus> {
  const bridgeUrl = whatsappBridgeApiUrl(settings);
  const bridgePath = managedWhatsAppBridgePath();
  const expectedDbPath = managedWhatsAppMessagesDbPath();
  const hadManagedRuntimeBeforeStart = await fileExists(managedGoBinaryPath());
  try {
    await startManagedWhatsAppBridgeProcess(settings, "manual start");
    await openWhatsAppBridgeLogTerminal();
  } catch (error) {
    return {
      ok: false,
      connected: false,
      bridgeUrl,
      tokenConfigured: Boolean(await resolveWhatsAppBridgeToken(settings)),
      databasePath: (await fileExists(expectedDbPath)) ? expectedDbPath : undefined,
      bridgePath,
      setupAction: errorMessage(error).includes("Git is required") ? "install_git" : "runtime_install_failed",
      message: "Could not start the WhatsApp bridge.",
      detail: errorMessage(error)
    };
  }

  const health = await waitForWhatsAppBridgeHealth(settings, 6000);
  const connected = Boolean(health && health.response.ok && (health.data as Record<string, unknown>).connected);
  const databasePath = (await fileExists(expectedDbPath)) ? expectedDbPath : undefined;
  const installedManagedRuntime = !hadManagedRuntimeBeforeStart && (await fileExists(managedGoBinaryPath()));
  return {
    ok: connected && Boolean(databasePath),
    connected,
    bridgeUrl,
    tokenConfigured: Boolean(await resolveWhatsAppBridgeToken(settings)),
    databasePath,
    bridgePath,
    setupAction: connected && databasePath ? undefined : "scan_qr",
    message: connected ? "WhatsApp bridge is running." : "WhatsApp bridge is starting.",
    detail: `${installedManagedRuntime ? "SocializeAI installed a private Go runtime for the bridge. " : ""}Terminal now shows the bridge log and QR code if pairing is needed. SocializeAI will keep the bridge running while the app is open.`
  };
}

function whatsAppBridgeHeaders(token: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function normalizeWhatsAppRecipient(handle: string) {
  const trimmed = handle.trim();
  if (!trimmed) throw new Error("This WhatsApp chat needs a recipient JID or phone number.");
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) throw new Error("This WhatsApp chat needs a recipient JID or phone number.");
  return `${digits}@s.whatsapp.net`;
}

async function sendWhatsAppPersonal(settings: AppSettings, handle: string, text: string) {
  await ensureWhatsAppBridgeRunning(settings, "send");
  const apiUrl = whatsappBridgeApiUrl(settings);
  const token = await resolveWhatsAppBridgeToken(settings);
  const response = await fetch(`${apiUrl}/send`, {
    method: "POST",
    headers: whatsAppBridgeHeaders(token),
    body: JSON.stringify({
      recipient: normalizeWhatsAppRecipient(handle),
      message: text
    })
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    throw new Error("WhatsApp bridge rejected the request. Paste the bridge token from store/.bridge-token in Settings, then save.");
  }
  if (!response.ok) throw new Error(extractApiError(data, `WhatsApp bridge returned ${response.status}.`));
  if (data && typeof data === "object" && (data as Record<string, unknown>).success === false) {
    throw new Error(extractApiError(data, "WhatsApp bridge could not send the message."));
  }
  const message = data && typeof data === "object" ? (data as Record<string, unknown>).message : undefined;
  return typeof message === "string" && message ? message : "sent";
}

function messagesDbPath() {
  return path.join(homedir(), "Library", "Messages", "chat.db");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isMessagesDbAccessDenied(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("authorization denied") ||
    message.includes("operation not permitted") ||
    message.includes("not authorized") ||
    (message.includes("unable to open database") && message.includes("library/messages/chat.db"))
  );
}

function messagesFullDiskAccessDetail() {
  return "macOS is blocking SocializeAI from reading Messages. Open Full Disk Access, add SocializeAI, then quit and relaunch the app. If it is already listed, remove it and add the rebuilt app again.";
}

function compactSqliteDiagnostic(error: unknown) {
  const message = errorMessage(error);
  if (/authorization denied/i.test(message)) return "sqlite3 could not open the Messages database: authorization denied.";
  if (/operation not permitted/i.test(message)) return "sqlite3 could not open the Messages database: operation not permitted.";
  if (/unable to open database/i.test(message)) return "sqlite3 could not open the Messages database.";
  return message.replace(/\s+/g, " ").slice(0, 260);
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

function sqliteBool(value: unknown) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function formatLocalDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatWhatsAppTimestamp(value: unknown) {
  if (value === null || typeof value === "undefined" || value === "") return "";
  if (typeof value === "number") {
    const ms = value > 1000000000000 ? value : value * 1000;
    return formatLocalDateTime(new Date(ms));
  }
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    const ms = numeric > 1000000000000 ? numeric : numeric * 1000;
    return formatLocalDateTime(new Date(ms));
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return formatLocalDateTime(parsed);
  return raw.slice(0, 19);
}

function whatsAppNameFromJid(jid: string) {
  return jid
    .replace(/@s\.whatsapp\.net$/i, "")
    .replace(/@g\.us$/i, "")
    .replace(/@lid$/i, "")
    .replace(/@c\.us$/i, "");
}

function whatsAppDisplayName(name: string | null | undefined, jid: string) {
  const resolved = name?.trim();
  return resolved || whatsAppNameFromJid(jid) || jid || "WhatsApp chat";
}

function whatsAppMessageBody(content?: string | null, mediaType?: string | null, filename?: string | null) {
  const text = content?.trim();
  if (text) return text;
  const media = mediaType?.trim();
  if (media) return filename?.trim() ? `[${media}: ${filename.trim()}]` : `[${media}]`;
  return "[No text content]";
}

async function sqliteColumnNames(dbPath: string, table: string) {
  const rows = await querySqliteDb<{ name: string }>(dbPath, `PRAGMA table_info(${table});`);
  return new Set(rows.map((row) => row.name));
}

async function listVeryGoodWhatsAppChats(dbPath: string): Promise<WhatsAppChat[]> {
  const rows = await querySqliteDb<{
    jid: string;
    name?: string | null;
    rawLastMessageAt?: string | number | null;
    lastText?: string | null;
    lastMediaType?: string | null;
    lastFilename?: string | null;
  }>(
    dbPath,
    `
      SELECT
        c.jid AS jid,
        c.name AS name,
        COALESCE(
          (SELECT m.timestamp FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1),
          c.last_message_time
        ) AS rawLastMessageAt,
        (SELECT m.content FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) AS lastText,
        (SELECT m.media_type FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) AS lastMediaType,
        (SELECT m.filename FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) AS lastFilename
      FROM chats c
      ORDER BY rawLastMessageAt DESC
      LIMIT 250;
    `
  );

  return rows.map((row) => {
    const isGroup = row.jid.endsWith("@g.us");
    const displayName = whatsAppDisplayName(row.name, row.jid);
    return {
      chatId: row.jid,
      jid: row.jid,
      displayName,
      contactName: isGroup ? undefined : displayName,
      chatIdentifier: whatsAppNameFromJid(row.jid),
      serviceName: "WhatsApp",
      participantHandles: [row.jid],
      participantNames: displayName ? [displayName] : [],
      lastMessageAt: formatWhatsAppTimestamp(row.rawLastMessageAt),
      lastText: whatsAppMessageBody(row.lastText, row.lastMediaType, row.lastFilename),
      isGroup
    };
  });
}

async function listFelipeWhatsAppChats(dbPath: string): Promise<WhatsAppChat[]> {
  const rows = await querySqliteDb<{
    jid: string;
    pushName?: string | null;
    contactName?: string | null;
    rawLastMessageAt?: string | number | null;
    unreadCount?: number;
    isGroup?: unknown;
    lastText?: string | null;
    lastMessageType?: string | null;
  }>(
    dbPath,
    `
      SELECT
        c.jid AS jid,
        c.push_name AS pushName,
        c.contact_name AS contactName,
        c.last_message_time AS rawLastMessageAt,
        c.unread_count AS unreadCount,
        c.is_group AS isGroup,
        (SELECT m.text FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) AS lastText,
        (SELECT m.message_type FROM messages m WHERE m.chat_jid = c.jid ORDER BY m.timestamp DESC LIMIT 1) AS lastMessageType
      FROM chats c
      ORDER BY c.last_message_time DESC
      LIMIT 250;
    `
  );

  return rows.map((row) => {
    const isGroup = sqliteBool(row.isGroup) || row.jid.endsWith("@g.us");
    const displayName = whatsAppDisplayName(row.contactName || row.pushName, row.jid);
    return {
      chatId: row.jid,
      jid: row.jid,
      displayName,
      contactName: row.contactName || row.pushName || undefined,
      chatIdentifier: whatsAppNameFromJid(row.jid),
      serviceName: "WhatsApp",
      participantHandles: [row.jid],
      participantNames: displayName ? [displayName] : [],
      lastMessageAt: formatWhatsAppTimestamp(row.rawLastMessageAt),
      lastText: whatsAppMessageBody(row.lastText, row.lastMessageType),
      isGroup
    };
  });
}

async function listWhatsAppChats(settings: AppSettings): Promise<WhatsAppChat[]> {
  const dbPath = await resolveWhatsAppMessagesDbPath(settings);
  const chatColumns = await sqliteColumnNames(dbPath, "chats");
  if (chatColumns.has("contact_name") || chatColumns.has("push_name")) return listFelipeWhatsAppChats(dbPath);
  return listVeryGoodWhatsAppChats(dbPath);
}

async function importVeryGoodWhatsAppHistory(dbPath: string, chatJid: string, limit: number) {
  const rows = await querySqliteDb<{
    sender: string;
    content: string | null;
    timestamp: string | number | null;
    is_from_me: unknown;
    media_type?: string | null;
    filename?: string | null;
  }>(
    dbPath,
    `
      SELECT sender, content, timestamp, is_from_me, media_type, filename
      FROM messages
      WHERE chat_jid = '${escapeSql(chatJid)}'
      ORDER BY timestamp DESC
      LIMIT ${limit};
    `
  );
  const chatRows = await querySqliteDb<{ name?: string | null }>(dbPath, `SELECT name FROM chats WHERE jid = '${escapeSql(chatJid)}' LIMIT 1;`).catch(() => []);
  const chatName = chatRows[0]?.name || "";
  return rows
    .reverse()
    .map((row) => {
      const fromMe = sqliteBool(row.is_from_me);
      const sender = fromMe ? "Me" : whatsAppDisplayName(chatName || row.sender, row.sender || chatJid);
      return `${formatWhatsAppTimestamp(row.timestamp)} ${sender}: ${whatsAppMessageBody(row.content, row.media_type, row.filename)}`;
    })
    .join("\n");
}

async function importFelipeWhatsAppHistory(dbPath: string, chatJid: string, limit: number) {
  const rows = await querySqliteDb<{
    sender_jid: string;
    sender_push_name?: string | null;
    sender_contact_name?: string | null;
    chat_name?: string | null;
    text: string | null;
    timestamp: string | number | null;
    is_from_me: unknown;
    message_type?: string | null;
  }>(
    dbPath,
    `
      SELECT sender_jid, sender_push_name, sender_contact_name, chat_name, text, timestamp, is_from_me, message_type
      FROM messages_with_names
      WHERE chat_jid = '${escapeSql(chatJid)}'
      ORDER BY timestamp DESC
      LIMIT ${limit};
    `
  );
  return rows
    .reverse()
    .map((row) => {
      const fromMe = sqliteBool(row.is_from_me);
      const sender = fromMe ? "Me" : whatsAppDisplayName(row.sender_contact_name || row.sender_push_name || row.chat_name, row.sender_jid || chatJid);
      return `${formatWhatsAppTimestamp(row.timestamp)} ${sender}: ${whatsAppMessageBody(row.text, row.message_type)}`;
    })
    .join("\n");
}

async function importWhatsAppHistory(settings: AppSettings, handle: string, limit: number, chatId?: string) {
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 500);
  const chatJid = chatId || normalizeWhatsAppRecipient(handle);
  if (settings.whatsappProvider === "personal_bridge") await ensureWhatsAppBridgeRunning(settings, "history import");
  const dbPath = await resolveWhatsAppMessagesDbPath(settings);
  const chatColumns = await sqliteColumnNames(dbPath, "chats");
  const messages = chatColumns.has("contact_name") || chatColumns.has("push_name")
    ? await importFelipeWhatsAppHistory(dbPath, chatJid, safeLimit)
    : await importVeryGoodWhatsAppHistory(dbPath, chatJid, safeLimit);
  return {
    messages,
    count: messages ? messages.split("\n").filter((line) => /^\d{4}-\d{2}-\d{2}/.test(line)).length : 0
  };
}

async function getWhatsAppBridgeStatus(settings: AppSettings): Promise<WhatsAppBridgeStatus> {
  const bridgeUrl = whatsappBridgeApiUrl(settings);
  const token = await resolveWhatsAppBridgeToken(settings);
  const bridgePath = managedWhatsAppBridgePath();
  let databasePath = "";
  let databaseDetail = "";
  try {
    databasePath = await resolveWhatsAppMessagesDbPath(settings);
    databaseDetail = `Database found at ${databasePath}.`;
  } catch (error) {
    databaseDetail = error instanceof Error ? error.message : String(error);
  }

  try {
    const response = await fetch(`${bridgeUrl}/health`, {
      headers: whatsAppBridgeHeaders(token)
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      return {
        ok: false,
        connected: false,
        bridgeUrl,
        tokenConfigured: Boolean(token),
        databasePath,
        bridgePath,
        setupAction: "check_token",
        message: "WhatsApp bridge is running but rejected the token.",
        detail: "Paste the token from whatsapp-bridge/store/.bridge-token in Settings, then save."
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        connected: false,
        bridgeUrl,
        tokenConfigured: Boolean(token),
        databasePath,
        bridgePath,
        setupAction: databasePath ? "check_bridge" : "start_bridge",
        message: `WhatsApp bridge returned ${response.status}.`,
        detail: databaseDetail
      };
    }
    const connected = Boolean((data as Record<string, unknown>).connected);
    return {
      ok: connected && Boolean(databasePath),
      connected,
      bridgeUrl,
      tokenConfigured: Boolean(token),
      databasePath,
      bridgePath,
      setupAction: connected && databasePath ? undefined : connected ? "wait_for_database" : "scan_qr",
      message: connected ? "WhatsApp bridge is connected." : "WhatsApp bridge is reachable, but WhatsApp is not connected.",
      detail: databaseDetail
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const networkDetail = /fetch failed|ECONNREFUSED|ECONNRESET|ECONNREFUSED|Failed to fetch/i.test(rawMessage) ? "" : ` ${rawMessage}`;
    const detail = databasePath
      ? `Click Start bridge to open the WhatsApp QR pairing window, then refresh WhatsApp chats.${networkDetail}`
      : `Click Start bridge. SocializeAI will set up the local bridge runtime if needed, open Terminal, and show the WhatsApp QR code.${networkDetail}`;
    return {
      ok: false,
      connected: false,
      bridgeUrl,
      tokenConfigured: Boolean(token),
      databasePath,
      bridgePath,
      setupAction: "start_bridge",
      message: "WhatsApp bridge is not running.",
      detail: detail.trim()
    };
  }
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
      receiptId =
        state.settings.whatsappProvider === "business_cloud"
          ? await sendWhatsAppBusiness(state.settings, contact.handle, part)
          : await sendWhatsAppPersonal(state.settings, contact.chatId || contact.handle, part);
      if (index < parts.length - 1) await sleep(900);
    }
    return {
      ok: true,
      dryRun: false,
      message: state.settings.whatsappProvider === "business_cloud" ? "WhatsApp Cloud API accepted the message." : "WhatsApp bridge sent the message.",
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
  if (candidate.platform !== target.platform) return false;
  return (
    (!!candidate.chatId && candidate.chatId === target.chatId) ||
    (!!candidate.chatGuid && candidate.chatGuid === target.chatGuid) ||
    candidate.id === target.id
  );
}

function contactRoutingKey(contact: Contact) {
  const channelId =
    contact.platform === "imessage"
      ? contact.chatGuid || contact.chatId || contact.handle || contact.id
      : contact.chatId || contact.handle || contact.id;
  return `${contact.platform}:${channelId}`;
}

function findStoredContact(state: AppState, contact: Contact) {
  return state.contacts.find((item) => contactMatchesContact(item, contact));
}

async function importHistoryForContact(state: AppState, contact: Contact, limit: number) {
  if (contact.platform === "imessage") return importIMessageHistory(contact.handle, limit, contact.chatId);
  if (contact.platform === "whatsapp") return importWhatsAppHistory(state.settings, contact.handle, limit, contact.chatId);
  throw new Error("Automatic replies need an iMessage or WhatsApp chat.");
}

function canAutoSendDraft(state: AppState, inbound: string, draft: { riskLevel: RiskLevel; requiresHumanReview: boolean; draftText: string; sendEligibility: { canAutoSend: boolean } }) {
  const mode = getPermissionMode(state.settings);
  const sensitiveReasons = detectSensitiveReasons(`${inbound}\n${draft.draftText}`);
  if (mode === "extra_safe") return false;
  if (mode === "dangerously_skip") return true;
  if (mode === "auto_review") return draft.riskLevel !== "blocked" && !hasUltraSensitiveReason(sensitiveReasons);
  return (
    draft.riskLevel === "low" &&
    !draft.requiresHumanReview &&
    draft.sendEligibility.canAutoSend &&
    sensitiveReasons.length === 0
  );
}

function shouldHoldPreparedDraft(state: AppState, inbound: string, draft: DraftResult, forceReply: boolean) {
  const mode = getPermissionMode(state.settings);
  const sensitiveReasons = detectSensitiveReasons(`${inbound}\n${draft.draftText}\n${draft.messageParts.join("\n")}`);
  if (mode === "extra_safe") return true;
  if (mode === "dangerously_skip") return false;
  if (mode === "auto_review") return draft.riskLevel === "blocked" || hasUltraSensitiveReason(sensitiveReasons);
  if (forceReply) return draft.riskLevel === "high" || draft.riskLevel === "blocked" || sensitiveReasons.length > 0;
  return !canAutoSendDraft(state, inbound, draft);
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
  const needsUserInputReason = draftText
    .split(/\n+/)
    .map((line) => line.match(/NEEDS_USER_INPUT\s*:\s*(.+)/i)?.[1]?.trim())
    .find(Boolean);
  if (needsUserInputReason) {
    reasons.push(needsUserInputReason);
  }
  if (/\[[^\]]*(?:link|url|site|website|github|discord|telegram|email|phone|handle|insert|placeholder)[^\]]*\]/i.test(draftText)) {
    reasons.push("The draft contains placeholder text instead of a real answer.");
  }
  if (/\b(?:site|website|github|portfolio|discord|telegram|email|phone|linkedin|instagram)\s+(?:link|handle)\b/i.test(draftText)) {
    reasons.push("The draft contains a generic link label instead of a real answer.");
  }

  const asksForPersonalReference =
    /\b(?:what'?s|what is|send|share|drop|remind|again|link|handle)\b[\s\S]{0,120}\b(?:website|site|github|portfolio|discord|telegram|email|phone|number|address|linkedin|instagram)\b/i.test(inbound);
  const knownReference = /(https?:\/\/|github\.com\/|t\.me\/|telegram\.me\/|discord(?:\.gg|app\.com)\/|[a-z0-9-]+\.(?:com|ai|io|co|net|org|dev|studio|app)\b|@[a-z0-9_.-]{3,})/i.test(
    `${availableContext}\n${userInstruction}`
  );
  if (asksForPersonalReference && !knownReference && !userInstruction.trim()) {
    reasons.push("They asked for a personal handle, link, or contact detail, and the app does not have that answer.");
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
  const storedContact = findStoredContact(state, contactRequest);
  const contact = storedContact
    ? {
        ...storedContact,
        notes: contactRequest.notes ?? storedContact.notes,
        userInstruction: contactRequest.userInstruction ?? storedContact.userInstruction
      }
    : contactRequest;
  const storedInstruction = String(contact.userInstruction || "").trim();
  const combinedInstruction = [storedInstruction, userSuppliedInstruction].filter(Boolean).join("\n");
  const details: string[] = [];
  if (!contact.allowAutopilot) {
    return { ok: false, status: "idle", message: "Bot is not enabled for this chat.", contact, details };
  }
  if (contact.optedOut) {
    return { ok: false, status: "blocked", message: "This chat is marked opted out.", contact, details };
  }
  if (contact.platform !== "imessage" && contact.platform !== "whatsapp") {
    return { ok: false, status: "blocked", message: "Automatic replies need an iMessage or WhatsApp chat.", contact, details };
  }

  try {
    const imported = await importHistoryForContact(state, contact, 40);
    const inbound = latestInboundLine(imported.messages);
    if (!inbound) {
      return { ok: false, status: "idle", message: `No inbound ${contact.platform === "whatsapp" ? "WhatsApp" : "iMessage"} message found.`, contact, details };
    }
    const waitSeconds = !skipWait && !regenerate && !userSuppliedInstruction ? secondsUntilInboundSettles(inbound) : 0;
    if (waitSeconds > 0) {
      return {
        ok: false,
        status: "waiting",
        message: `Waiting ${waitSeconds}s to see if they keep texting before replying.`,
        contact,
        preparedContactKey: contactRoutingKey(contact),
        inboundText: inbound,
        waitSeconds,
        details: [`Latest inbound message is still fresh. Waiting avoids replying before a double/triple text finishes.`]
      };
    }
    const inboundHash = hashText(inbound);
    if (!forceReply && contact.lastAutopilotInboundHash === inboundHash) {
      return { ok: false, status: "idle", message: "Latest inbound message already handled.", contact, inboundHash, inboundText: inbound, details };
    }

    let draft = await generateDraftWithSettings(state.settings, {
      contact,
      currentMessage: inbound,
      conversationContext: imported.messages,
      relationshipMemory: contact.notes,
      userInstruction: [
        regenerate
          ? "Autopilot mode. Regenerate a different concise, natural reply in the user's voice. Avoid repeating the previous wording. Only set can_auto_send true and requires_human_review false for simple low-risk acknowledgements, casual replies, or scheduling."
          : "Autopilot mode. Produce a concise, natural reply in the user's voice. Only set can_auto_send true and requires_human_review false for simple low-risk acknowledgements, casual replies, or scheduling.",
        storedInstruction ? `Saved chat instruction: ${storedInstruction}` : "",
        userSuppliedInstruction ? `User-provided answer/instruction: ${userSuppliedInstruction}` : ""
      ]
        .filter(Boolean)
        .join("\n")
    });
    draft = relaxRoutineAffectionRisk(contact, inbound, draft);
    const userInputReasons =
      getPermissionMode(state.settings) === "dangerously_skip" ? [] : detectUserInputNeed(inbound, draft, `${imported.messages}\n${contact.notes}\n${storedInstruction}`, combinedInstruction);
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
        preparedContactKey: contactRoutingKey(contact),
        inboundHash,
        inboundText: inbound,
        draftText: draft.draftText,
        messageParts: draft.messageParts,
        draft,
        details: userInputReasons
      };
    }

    const preparedParts = appendDisclosureToParts(state.settings, draft.messageParts);
    const preparedText = joinMessageParts(preparedParts);

    if (shouldHoldPreparedDraft(state, inbound, draft, forceReply)) {
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
        preparedContactKey: contactRoutingKey(contact),
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
      preparedContactKey: contactRoutingKey(contact),
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

async function sendPreparedAutopilotReply(request: { contact: Contact; preparedContactKey?: string; inboundHash: string; text: string; textParts?: string[] }) {
  const state = await readState();
  const contact = findStoredContact(state, request.contact) || request.contact;
  try {
    const actualContactKey = contactRoutingKey(contact);
    if (!request.preparedContactKey || request.preparedContactKey !== actualContactKey) {
      const message = "Blocked: this prepared reply no longer matches the selected recipient.";
      state.audits = [
        createAudit("message_blocked", `Blocked mismatched bot send for ${contact.displayName}`, `Expected ${request.preparedContactKey || "missing"} but got ${actualContactKey}.`),
        ...state.audits
      ].slice(0, 500);
      await writeState(state);
      return { ok: false, dryRun: false, message, detail: message };
    }
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
    if (!contact.allowAutopilot || contact.optedOut || (contact.platform !== "imessage" && contact.platform !== "whatsapp")) {
      skipped += 1;
      continue;
    }
    scanned += 1;
    try {
      const imported = await importHistoryForContact(state, contact, 30);
      const inbound = latestInboundLine(imported.messages);
      if (!inbound) {
        skipped += 1;
        details.push(`${contact.displayName}: no inbound ${contact.platform === "whatsapp" ? "WhatsApp" : "iMessage"} message found.`);
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

      const storedInstruction = String(contact.userInstruction || "").trim();
      let draft = await generateDraftWithSettings(state.settings, {
        contact,
        currentMessage: inbound,
        conversationContext: imported.messages,
        relationshipMemory: contact.notes,
        userInstruction: [
          "Autopilot mode. Only mark can_auto_send true and requires_human_review false for simple low-risk acknowledgements or scheduling replies.",
          storedInstruction ? `Saved chat instruction: ${storedInstruction}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      });
      draft = relaxRoutineAffectionRisk(contact, inbound, draft);
      drafted += 1;

      const userInputReasons =
        getPermissionMode(state.settings) === "dangerously_skip" ? [] : detectUserInputNeed(inbound, draft, `${imported.messages}\n${contact.notes}\n${storedInstruction}`, storedInstruction);
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

      if (!canAutoSendDraft(state, inbound, draft)) {
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
      detail: isMessagesDbAccessDenied(error) ? messagesFullDiskAccessDetail() : compactSqliteDiagnostic(error)
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
      detail: "Grant Contacts or Full Disk Access to SocializeAI, then quit and relaunch the app."
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
    const accessDenied = isMessagesDbAccessDenied(error);
    const summary = accessDenied ? "iMessage history import blocked" : "iMessage history import failed";
    const detail = accessDenied ? "Full Disk Access is required for the Messages database." : compactSqliteDiagnostic(error);
    state.audits = [createAudit("history_import_failed", summary, detail), ...state.audits].slice(0, 500);
    await writeState(state);
    return {
      ok: false,
      count: 0,
      messages: "",
      message: accessDenied ? "Messages access is blocked." : "Could not import iMessage history.",
      detail: accessDenied ? messagesFullDiskAccessDetail() : "Try reloading the thread. If this keeps happening, check Mac access in Settings.",
      code: accessDenied ? "full_disk_access_required" : "history_import_failed",
      needsFullDiskAccess: accessDenied
    };
  }
});

ipcMain.handle("whatsapp:bridge-status", async (_event, settings?: AppSettings) => {
  const state = await readState();
  return getWhatsAppBridgeStatus({ ...defaultSettings, ...state.settings, ...(settings || {}) });
});

ipcMain.handle("whatsapp:start-bridge", async (_event, settings?: AppSettings) => {
  const state = await readState();
  return startWhatsAppBridge({ ...defaultSettings, ...state.settings, ...(settings || {}) });
});

ipcMain.handle("whatsapp:list-chats", async () => {
  const state = await readState();
  try {
    return await listWhatsAppChats(state.settings);
  } catch (error) {
    throw new Error(
      `WhatsApp setup is not ready yet. Click Start bridge in Settings or the WhatsApp sidebar, scan the QR code, then refresh chats. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
});

ipcMain.handle("whatsapp:import-history", async (_event, request: { handle: string; chatId?: string; limit: number }) => {
  const state = await readState();
  try {
    const result = await importWhatsAppHistory(state.settings, request.handle, request.limit, request.chatId);
    state.audits = [
      createAudit("history_imported", `Imported ${result.count} WhatsApp rows`, request.chatId ? `Chat: ${request.chatId}` : `Handle: ${request.handle}`),
      ...state.audits
    ].slice(0, 500);
    await writeState(state);
    return { ok: true, count: result.count, messages: result.messages, message: `Imported ${result.count} WhatsApp messages.` };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      messages: "",
      message: "Could not import WhatsApp history. Start the personal WhatsApp bridge and set its messages DB path in Settings.",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
});

ipcMain.handle("autopilot:run-once", async () => runAutopilotOnce("manual"));

ipcMain.handle("autopilot:prepare-reply", async (_event, request: Contact | { contact: Contact; regenerate?: boolean; forceReply?: boolean; skipWait?: boolean; userInstruction?: string }) =>
  prepareAutopilotReply(request)
);

ipcMain.handle("autopilot:send-prepared", async (_event, request: { contact: Contact; preparedContactKey?: string; inboundHash: string; text: string; textParts?: string[] }) =>
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
