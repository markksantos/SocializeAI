import type {
  AppSettings,
  AppState,
  DraftRequest,
  DraftResult,
  ImportHistoryRequest,
  SendMessageRequest,
  SocializeAIAPI
} from "./shared";
import { defaultSettings } from "./shared";

const storageKey = "socializeai.browser-state";

function createState(): AppState {
  return {
    settings: { ...defaultSettings },
    contacts: [
      {
        id: crypto.randomUUID(),
        displayName: "Demo contact",
        platform: "manual",
        handle: "",
        relationship: "friend",
        notes: "Browser preview contact.",
        allowAutopilot: false,
        optedOut: false
      }
    ],
    audits: []
  };
}

function readState(): AppState {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return createState();
  try {
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      settings: { ...defaultSettings, ...(parsed.settings || {}) },
      contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
      audits: Array.isArray(parsed.audits) ? parsed.audits : []
    };
  } catch {
    return createState();
  }
}

function writeState(state: AppState) {
  localStorage.setItem(storageKey, JSON.stringify(state));
  return state;
}

function appendAudit(state: AppState, type: AppState["audits"][number]["type"], summary: string, detail?: string) {
  return {
    ...state,
    audits: [
      {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        type,
        summary,
        detail
      },
      ...state.audits
    ].slice(0, 500)
  };
}

function appendDisclosureToText(settings: AppSettings, rawText: string) {
  const text = rawText.trim();
  const disclosure = settings.appendDisclosure ? settings.disclosureText.trim() : "";
  if (!disclosure || text.endsWith(disclosure)) return text;
  return `${text}\n\n${disclosure}`;
}

function previewDraft(request: DraftRequest, settings: AppSettings): DraftResult {
  const text = request.currentMessage.trim();
  const lower = `${text} ${request.conversationContext}`.toLowerCase();
  const risky = /(password|hurt myself|suicide|loan|borrow|lawyer|doctor|diagnosis|break up)/.test(lower);
  const scheduling = /(meet|dinner|lunch|time|tomorrow|tonight|later|free)/.test(lower);
  const draftText = scheduling
    ? "Yeah that works for me. Send me the time and I will make it happen."
    : text
      ? "Got it. I hear you, and I will get back to you properly in a bit."
      : "Hey, just seeing this now. I will reply properly in a bit.";
  return {
    draftText,
    messageParts: [draftText],
    confidence: 0.62,
    riskLevel: risky ? "high" : "low",
    requiresHumanReview: true,
    reasonCodes: risky ? ["unknown_context"] : scheduling ? ["scheduling"] : ["routine_ack"],
    sendEligibility: {
      canAutoSend: false,
      explanation: "Browser preview always requires approval. Electron uses the configured provider."
    },
    memoryUpdates: request.relationshipMemory
      ? []
      : [
          {
            kind: "style",
            value: "Prefers short, casual replies until more relationship context is available.",
            confidence: 0.45
          }
        ],
    provider: "heuristic",
    model: settings.aiProvider === "openai" ? settings.openAiModel : settings.aiProvider === "ollama" ? settings.localModel : settings.localOpenAiModel
  };
}

export function installBrowserApiFallback() {
  if (window.socializeAI) return;

  const api: SocializeAIAPI = {
    async getState() {
      return readState();
    },
    async saveState(state: AppState) {
      return writeState(state);
    },
    async completeOnboarding(settings: AppSettings) {
      const state = appendAudit(readState(), "onboarding_completed", "Completed browser onboarding", `Provider: ${settings.aiProvider}`);
      return writeState({ ...state, settings: { ...settings, hasCompletedOnboarding: true } });
    },
    async generateDraft(request: DraftRequest) {
      const state = readState();
      const draft = previewDraft(request, state.settings);
      writeState(appendAudit(state, "draft_generated", "Generated preview draft", `Risk: ${draft.riskLevel}`));
      return draft;
    },
    async testProvider(settings: AppSettings) {
      const state = appendAudit(readState(), "provider_test", "Browser provider test", `Provider: ${settings.aiProvider}`);
      writeState(state);
      return {
        ok: true,
        message: "Preview mode is working. Run Electron to test real OpenAI, Ollama, iMessage, and WhatsApp connectors."
      };
    },
    async sendMessage(request: SendMessageRequest) {
      const current = readState();
      const state = appendAudit(current, "message_dry_run", `Preview dry run for ${request.contact.displayName}`, appendDisclosureToText(current.settings, request.text));
      writeState(state);
      return {
        ok: true,
        dryRun: true,
        message: "Browser preview recorded a dry run. Electron performs real sends when configured."
      };
    },
    async listIMessageChats() {
      return [];
    },
    async importIMessageHistory(_request: ImportHistoryRequest) {
      return {
        ok: false,
        messages: "",
        count: 0,
        message: "iMessage import is available only inside the Electron app."
      };
    },
    async runAutopilotOnce() {
      const state = appendAudit(readState(), "message_dry_run", "Preview autopilot run", "Browser preview does not scan local Messages.");
      writeState(state);
      return {
        ok: true,
        scanned: 0,
        drafted: 0,
        sent: 0,
        dryRuns: 0,
        skipped: 0,
        message: "Preview autopilot run recorded. Electron scans local iMessage history when configured.",
        details: []
      };
    },
    async prepareAutopilotReply(request) {
      const state = readState();
      const contact = request.contact;
      const draft = previewDraft(
        {
          contact,
          currentMessage: "Preview inbound message",
          conversationContext: "",
          relationshipMemory: contact.notes,
          userInstruction: ""
        },
        state.settings
      );
      writeState(appendAudit(state, "draft_generated", `Preview queued reply for ${contact.displayName}`, "Waiting 10 seconds before preview send."));
      return {
        ok: true,
        status: "ready",
        message: "Preview reply is ready.",
        contact,
        inboundHash: crypto.randomUUID(),
        inboundText: "Preview inbound message",
        draftText: appendDisclosureToText(state.settings, draft.draftText),
        messageParts: [appendDisclosureToText(state.settings, draft.draftText)],
        draft,
        details: []
      };
    },
    async sendPreparedAutopilotReply(request) {
      const current = readState();
      const state = appendAudit(current, "message_dry_run", `Preview bot dry run for ${request.contact.displayName}`, appendDisclosureToText(current.settings, request.text));
      writeState(state);
      return {
        ok: true,
        dryRun: true,
        message: "Preview bot send recorded."
      };
    },
    async cancelPreparedAutopilotReply(request) {
      const state = appendAudit(readState(), "message_blocked", `Preview cancelled bot reply for ${request.contact.displayName}`, request.reason);
      writeState(state);
      return {
        ok: true,
        dryRun: false,
        message: "Preview bot reply cancelled."
      };
    },
    async checkMacPermissions() {
      return {
        messagesDatabase: {
          ok: false,
          label: "Messages database",
          detail: "Available only in the Electron desktop app."
        },
        contactsDatabase: {
          ok: false,
          label: "Contacts database",
          detail: "Available only in the Electron desktop app."
        },
        messagesAutomation: {
          ok: false,
          label: "Messages automation",
          detail: "Available only in the Electron desktop app."
        }
      };
    },
    async openFullDiskAccessSettings() {
      return undefined;
    },
    async revealDataFolder() {
      return undefined;
    }
  };

  window.socializeAI = api;
}
