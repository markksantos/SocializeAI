export type AiProvider = "openai" | "ollama" | "local-openai";

export type Platform = "imessage" | "whatsapp" | "manual";

export type RiskLevel = "low" | "medium" | "high" | "blocked";

export type SafetyReason =
  | "routine_ack"
  | "scheduling"
  | "emotional_context"
  | "medical_or_health"
  | "financial"
  | "legal"
  | "romantic_or_sensitive"
  | "conflict"
  | "unknown_context"
  | "recipient_opted_out"
  | "platform_policy"
  | "password_or_secret"
  | "self_harm_or_emergency";

export type AppSettings = {
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

export type Contact = {
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

export type IMessageChat = {
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

export type DraftRequest = {
  contact: Contact;
  currentMessage: string;
  conversationContext: string;
  relationshipMemory: string;
  userInstruction: string;
};

export type DraftResult = {
  draftText: string;
  messageParts: string[];
  confidence: number;
  riskLevel: RiskLevel;
  requiresHumanReview: boolean;
  reasonCodes: SafetyReason[];
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

export type AuditEvent = {
  id: string;
  at: string;
  type:
    | "settings_saved"
    | "onboarding_completed"
    | "draft_generated"
    | "draft_failed"
    | "message_sent"
    | "message_blocked"
    | "message_dry_run"
    | "contact_saved"
    | "history_imported"
    | "provider_test";
  summary: string;
  detail?: string;
};

export type AppState = {
  settings: AppSettings;
  contacts: Contact[];
  audits: AuditEvent[];
};

export type ProviderTestResult = {
  ok: boolean;
  message: string;
  detail?: string;
};

export type SendMessageRequest = {
  contact: Contact;
  text: string;
  dryRunOverride?: boolean;
};

export type SendMessageResult = {
  ok: boolean;
  dryRun: boolean;
  message: string;
  receiptId?: string;
  detail?: string;
};

export type ImportHistoryRequest = {
  handle: string;
  chatId?: string;
  limit: number;
};

export type ImportHistoryResult = {
  ok: boolean;
  messages: string;
  count: number;
  message: string;
  detail?: string;
};

export type AutopilotRunResult = {
  ok: boolean;
  scanned: number;
  drafted: number;
  sent: number;
  dryRuns: number;
  skipped: number;
  message: string;
  details: string[];
};

export type PreparedAutopilotReply = {
  ok: boolean;
  status: "ready" | "idle" | "held" | "blocked" | "needs_input";
  message: string;
  contact?: Contact;
  inboundHash?: string;
  inboundText?: string;
  draftText?: string;
  messageParts?: string[];
  draft?: DraftResult;
  details: string[];
};

export type PrepareAutopilotReplyRequest = {
  contact: Contact;
  regenerate?: boolean;
  forceReply?: boolean;
  userInstruction?: string;
};

export type PreparedAutopilotSendRequest = {
  contact: Contact;
  inboundHash: string;
  text: string;
  textParts?: string[];
};

export type PreparedAutopilotCancelRequest = {
  contact: Contact;
  inboundHash: string;
  reason?: string;
};

export type PermissionProbe = {
  ok: boolean;
  label: string;
  detail: string;
};

export type MacPermissionReport = {
  messagesDatabase: PermissionProbe;
  contactsDatabase: PermissionProbe;
  messagesAutomation: PermissionProbe;
};

export type SocializeAIAPI = {
  getState: () => Promise<AppState>;
  saveState: (state: AppState) => Promise<AppState>;
  completeOnboarding: (settings: AppSettings) => Promise<AppState>;
  generateDraft: (request: DraftRequest) => Promise<DraftResult>;
  testProvider: (settings: AppSettings) => Promise<ProviderTestResult>;
  sendMessage: (request: SendMessageRequest) => Promise<SendMessageResult>;
  listIMessageChats: () => Promise<IMessageChat[]>;
  importIMessageHistory: (request: ImportHistoryRequest) => Promise<ImportHistoryResult>;
  runAutopilotOnce: () => Promise<AutopilotRunResult>;
  prepareAutopilotReply: (request: PrepareAutopilotReplyRequest) => Promise<PreparedAutopilotReply>;
  sendPreparedAutopilotReply: (request: PreparedAutopilotSendRequest) => Promise<SendMessageResult>;
  cancelPreparedAutopilotReply: (request: PreparedAutopilotCancelRequest) => Promise<SendMessageResult>;
  checkMacPermissions: () => Promise<MacPermissionReport>;
  openFullDiskAccessSettings: () => Promise<void>;
  revealDataFolder: () => Promise<void>;
};

export const defaultSettings: AppSettings = {
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

export const suggestedOpenAiModels = ["gpt-5.5", "gpt-5.1", "gpt-4.1", "gpt-4o"];

export const suggestedLocalModels = [
  "qwen3.7",
  "qwen3:8b",
  "qwen3:14b",
  "gemma4",
  "gemma3:4b",
  "gemma3:12b",
  "llama3.1:8b"
];
