import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  ClipboardList,
  Cpu,
  KeyRound,
  MessagesSquare,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Wand2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { chatBubblesFromTranscript, latestInboundFromTranscript } from "./transcript";
import type {
  AiProvider,
  AppSettings,
  AppState,
  AuditEvent,
  Contact,
  DraftResult,
  IMessageChat,
  ImportHistoryResult,
  MacPermissionReport,
  MessagingChannel,
  PermissionMode,
  Platform,
  PreparedAutopilotReply,
  ProviderTestResult,
  SendMessageResult,
  WhatsAppBridgeStatus,
  WhatsAppChat
} from "./shared";
import { defaultSettings, suggestedLocalModels, suggestedOpenAiModels } from "./shared";

type View = "workbench" | "contacts" | "settings" | "audit";

type PendingBotSend = {
  contact: Contact;
  preparedContactKey: string;
  inboundHash: string;
  text: string;
  textParts: string[];
  draft?: DraftResult;
  secondsLeft: number;
};

function isPendingBotSend(value: unknown): value is PendingBotSend {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PendingBotSend>;
  return Boolean(candidate.contact && candidate.preparedContactKey && candidate.inboundHash && candidate.text && Array.isArray(candidate.textParts));
}

type BotWait = {
  contact: Contact;
  secondsLeft: number;
  forceReply: boolean;
  inboundText?: string;
};

type HeldBotReview = {
  contact: Contact;
  preparedContactKey: string;
  inboundHash: string;
  text: string;
  textParts: string[];
  draft?: DraftResult;
  reason: string;
};

type NeedsInputPrompt = {
  contact: Contact;
  inboundHash?: string;
  inboundText?: string;
  question: string;
};

type ThreadAccessIssue = {
  platform: "imessage" | "whatsapp";
  title: string;
  message: string;
  detail?: string;
  needsFullDiskAccess?: boolean;
};

const blankContact = (): Contact => ({
  id: crypto.randomUUID(),
  displayName: "",
  platform: "imessage",
  handle: "",
  relationship: "",
  notes: "",
  userInstruction: "",
  allowAutopilot: false,
  optedOut: false
});

function contactFromChat(chat: IMessageChat, existing?: Contact): Contact {
  const resolvedDisplayName = chat.contactName || chat.displayName || chat.chatIdentifier || "iMessage chat";
  const existingDisplayName = existing?.displayName && existing.displayName !== existing.handle ? existing.displayName : "";
  return {
    id: existing?.id ?? `chat:${chat.chatId}`,
    displayName: existingDisplayName || resolvedDisplayName,
    platform: "imessage",
    handle: existing?.handle || chat.participantHandles[0] || chat.chatIdentifier,
    chatId: chat.chatId,
    chatGuid: chat.guid,
    relationship: existing?.relationship || "",
    notes: existing?.notes || "",
    userInstruction: existing?.userInstruction || "",
    allowAutopilot: existing?.allowAutopilot ?? false,
    optedOut: existing?.optedOut ?? false,
    lastImportedAt: existing?.lastImportedAt,
    lastAutopilotAt: existing?.lastAutopilotAt,
    lastAutopilotInboundHash: existing?.lastAutopilotInboundHash
  };
}

function contactFromWhatsAppChat(chat: WhatsAppChat, existing?: Contact): Contact {
  const resolvedDisplayName = chat.contactName || chat.displayName || chat.chatIdentifier || "WhatsApp chat";
  const existingDisplayName = existing?.displayName && existing.displayName !== existing.handle ? existing.displayName : "";
  return {
    id: existing?.id ?? `whatsapp:${chat.jid}`,
    displayName: existingDisplayName || resolvedDisplayName,
    platform: "whatsapp",
    handle: existing?.handle || chat.jid || chat.chatIdentifier,
    chatId: chat.jid,
    relationship: existing?.relationship || "",
    notes: existing?.notes || "",
    userInstruction: existing?.userInstruction || "",
    allowAutopilot: existing?.allowAutopilot ?? false,
    optedOut: existing?.optedOut ?? false,
    lastImportedAt: existing?.lastImportedAt,
    lastAutopilotAt: existing?.lastAutopilotAt,
    lastAutopilotInboundHash: existing?.lastAutopilotInboundHash
  };
}

function contactMatches(candidate: Contact, target: Contact) {
  if (candidate.platform !== target.platform) return false;
  return (
    (!!candidate.chatId && candidate.chatId === target.chatId) ||
    (!!candidate.chatGuid && candidate.chatGuid === target.chatGuid) ||
    candidate.id === target.id
  );
}

function contactWorkflowKey(contact?: Contact) {
  if (!contact) return "";
  const channelId =
    contact.platform === "imessage"
      ? contact.chatGuid || contact.chatId || contact.handle || contact.id
      : contact.chatId || contact.handle || contact.id;
  return `${contact.platform}:${channelId}`;
}

function botIsRunningForContact(state: AppState, contact?: Contact) {
  if (!contact || (contact.platform !== "imessage" && contact.platform !== "whatsapp")) return false;
  const managed = state.contacts.find((item) => contactMatches(item, contact));
  const dryRun = contact.platform === "whatsapp" ? state.settings.whatsappDryRun : state.settings.iMessageDryRun;
  return Boolean(managed?.allowAutopilot && !managed.optedOut && !dryRun);
}

function appendDisclosureToText(settings: AppSettings, rawText: string) {
  const text = rawText.trim();
  const disclosure = settings.appendDisclosure ? settings.disclosureText.trim() : "";
  if (!disclosure || text.endsWith(disclosure)) return text;
  return `${text}\n\n${disclosure}`;
}

function draftTextForDisplay(settings: AppSettings, draft: DraftResult) {
  return appendDisclosureToText(settings, (draft.messageParts?.length ? draft.messageParts : [draft.draftText]).join("\n\n"));
}

function splitMessageParts(text: string) {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function threadAccessIssueFromImport(contact: Contact, result: ImportHistoryResult): ThreadAccessIssue {
  if (contact.platform === "imessage" && result.needsFullDiskAccess) {
    return {
      platform: "imessage",
      title: "Messages access is blocked",
      message: "SocializeAI needs Full Disk Access before it can read this iMessage thread.",
      detail: result.detail,
      needsFullDiskAccess: true
    };
  }
  return {
    platform: contact.platform === "whatsapp" ? "whatsapp" : "imessage",
    title: result.message || "Could not load this thread",
    message: result.detail || "Try reloading this conversation.",
    detail: result.code ? result.code.replaceAll("_", " ") : undefined
  };
}

const permissionModeOptions: Array<{ value: PermissionMode; label: string; description: string }> = [
  {
    value: "extra_safe",
    label: "Extra safe",
    description: "Ask before every bot message."
  },
  {
    value: "safe",
    label: "Safe",
    description: "Ask only when a reply looks sensitive or uncertain."
  },
  {
    value: "auto_review",
    label: "Auto review",
    description: "Send most replies after review; ask only for ultra-sensitive or unknown facts."
  },
  {
    value: "dangerously_skip",
    label: "Dangerously skip",
    description: "Skip permission prompts and make a best-effort guess when context is missing."
  }
];

function audit(type: AuditEvent["type"], summary: string, detail?: string): AuditEvent {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    type,
    summary,
    detail
  };
}

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [view, setView] = useState<View>("workbench");
  const [channel, setChannel] = useState<MessagingChannel>("imessage");
  const [selectedContactId, setSelectedContactId] = useState<string>("");
  const [imessageChats, setIMessageChats] = useState<IMessageChat[]>([]);
  const [whatsappChats, setWhatsAppChats] = useState<WhatsAppChat[]>([]);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [selectedWhatsAppChatId, setSelectedWhatsAppChatId] = useState("");
  const [chatSearch, setChatSearch] = useState("");
  const [whatsappStatus, setWhatsAppStatus] = useState<WhatsAppBridgeStatus | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(defaultSettings);
  const [contactDraft, setContactDraft] = useState<Contact>(blankContact());
  const [currentMessage, setCurrentMessage] = useState("");
  const [conversationContext, setConversationContext] = useState("");
  const [relationshipMemory, setRelationshipMemory] = useState("");
  const [userInstruction, setUserInstruction] = useState("");
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [finalText, setFinalText] = useState("");
  const [threadAccessIssue, setThreadAccessIssue] = useState<ThreadAccessIssue | null>(null);
  const [pendingBotSends, setPendingBotSends] = useState<Record<string, PendingBotSend>>({});
  const [botWaits, setBotWaits] = useState<Record<string, BotWait>>({});
  const [heldBotReviews, setHeldBotReviews] = useState<Record<string, HeldBotReview>>({});
  const [heldReviewTexts, setHeldReviewTexts] = useState<Record<string, string>>({});
  const [needsInputPrompts, setNeedsInputPrompts] = useState<Record<string, NeedsInputPrompt>>({});
  const [needsInputAnswers, setNeedsInputAnswers] = useState<Record<string, string>>({});
  const [permissionReport, setPermissionReport] = useState<MacPermissionReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [error, setError] = useState<string>("");
  const botCheckInFlight = useRef(false);
  const pendingSendInFlight = useRef(false);
  const pendingBotSendsRef = useRef<Record<string, PendingBotSend>>({});
  const botWaitsRef = useRef<Record<string, BotWait>>({});
  const heldBotReviewsRef = useRef<Record<string, HeldBotReview>>({});
  const needsInputPromptsRef = useRef<Record<string, NeedsInputPrompt>>({});
  const workbenchSaveRef = useRef<{ saving: boolean; pending: AppState | null }>({ saving: false, pending: null });

  const openFullDiskAccessSettings = () => window.socializeAI.openFullDiskAccessSettings();
  const updateSettingsDraft = (patch: Partial<AppSettings>) => setSettingsDraft((current) => ({ ...current, ...patch }));
  const updateHeldReviewText = (value: string) => {
    if (!activeContactKey) return;
    setHeldReviewTexts((current) => ({ ...current, [activeContactKey]: value }));
  };
  const updateNeedsInputAnswer = (value: string) => {
    if (!activeContactKey) return;
    setNeedsInputAnswers((current) => ({ ...current, [activeContactKey]: value }));
  };

  async function flushWorkbenchFieldSave() {
    if (workbenchSaveRef.current.saving) return;
    workbenchSaveRef.current.saving = true;
    try {
      while (workbenchSaveRef.current.pending) {
        const nextState = workbenchSaveRef.current.pending;
        workbenchSaveRef.current.pending = null;
        await window.socializeAI.saveState(nextState);
      }
    } catch (err) {
      setError(err instanceof Error ? `Could not save chat notes. ${err.message}` : "Could not save chat notes.");
    } finally {
      workbenchSaveRef.current.saving = false;
      if (workbenchSaveRef.current.pending) void flushWorkbenchFieldSave();
    }
  }

  function queueWorkbenchFieldSave(nextState: AppState) {
    workbenchSaveRef.current.pending = nextState;
    void flushWorkbenchFieldSave();
  }

  function patchContactWorkbenchFields(target: Contact | undefined, patch: { notes?: string; userInstruction?: string }) {
    if (!target) return;
    setState((current) => {
      if (!current) return current;
      const existing = current.contacts.find((contact) => contactMatches(contact, target));
      const nextContact: Contact = {
        ...target,
        ...existing,
        id: existing?.id ?? target.id,
        displayName: existing?.displayName || target.displayName,
        handle: existing?.handle || target.handle,
        chatId: target.chatId || existing?.chatId,
        chatGuid: target.chatGuid || existing?.chatGuid,
        relationship: existing?.relationship || target.relationship || "family/friend",
        notes: patch.notes ?? existing?.notes ?? target.notes ?? "",
        userInstruction: patch.userInstruction ?? existing?.userInstruction ?? target.userInstruction ?? "",
        allowAutopilot: existing?.allowAutopilot ?? target.allowAutopilot,
        optedOut: existing?.optedOut ?? target.optedOut
      };
      const contacts = existing
        ? current.contacts.map((contact) => (contactMatches(contact, target) ? nextContact : contact))
        : [nextContact, ...current.contacts];
      const nextState = { ...current, contacts };
      queueWorkbenchFieldSave(nextState);
      return nextState;
    });
  }

  function updateRelationshipMemory(value: string) {
    setRelationshipMemory(value);
    patchContactWorkbenchFields(activeContact, { notes: value });
  }

  function updateUserInstruction(value: string) {
    setUserInstruction(value);
    patchContactWorkbenchFields(activeContact, { userInstruction: value });
  }

  useEffect(() => {
    window.socializeAI
      .getState()
      .then((loaded) => {
        setState(loaded);
        setSettingsDraft(loaded.settings);
        setSelectedContactId(loaded.contacts[0]?.id ?? "");
        if (loaded.settings.hasCompletedOnboarding) {
          void refreshIMessageChats(false);
          void refreshWhatsAppStatus(false, loaded.settings);
          void refreshWhatsAppChats(false);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settingsDraft.darkModeEnabled ? "dark" : "light";
  }, [settingsDraft.darkModeEnabled]);

  const selectedContact = useMemo(
    () => state?.contacts.find((contact) => contact.id === selectedContactId) ?? state?.contacts[0],
    [state, selectedContactId]
  );

  const selectedChat = useMemo(
    () => imessageChats.find((chat) => chat.chatId === selectedChatId) ?? imessageChats[0],
    [imessageChats, selectedChatId]
  );

  const selectedWhatsAppChat = useMemo(
    () => whatsappChats.find((chat) => chat.chatId === selectedWhatsAppChatId) ?? whatsappChats[0],
    [whatsappChats, selectedWhatsAppChatId]
  );

  const activeContact = useMemo(() => {
    if (!state) return undefined;
    if (channel === "imessage" && selectedChat) {
      const managed = state.contacts.find((contact) => contact.chatId === selectedChat.chatId || contact.chatGuid === selectedChat.guid);
      return contactFromChat(selectedChat, managed);
    }
    if (channel === "whatsapp" && selectedWhatsAppChat) {
      const managed = state.contacts.find((contact) => contact.platform === "whatsapp" && (contact.chatId === selectedWhatsAppChat.jid || contact.handle === selectedWhatsAppChat.jid));
      return contactFromWhatsAppChat(selectedWhatsAppChat, managed);
    }
    return selectedContact?.platform === channel ? selectedContact : undefined;
  }, [channel, selectedChat, selectedWhatsAppChat, selectedContact, state]);

  const activeContactKey = useMemo(() => contactWorkflowKey(activeContact), [activeContact]);
  const pendingBotSend = activeContactKey ? pendingBotSends[activeContactKey] ?? null : null;
  const botWait = activeContactKey ? botWaits[activeContactKey] ?? null : null;
  const heldBotReview = activeContactKey ? heldBotReviews[activeContactKey] ?? null : null;
  const heldReviewText = activeContactKey ? heldReviewTexts[activeContactKey] ?? "" : "";
  const needsInputPrompt = activeContactKey ? needsInputPrompts[activeContactKey] ?? null : null;
  const needsInputAnswer = activeContactKey ? needsInputAnswers[activeContactKey] ?? "" : "";

  useEffect(() => {
    pendingBotSendsRef.current = pendingBotSends;
  }, [pendingBotSends]);

  useEffect(() => {
    botWaitsRef.current = botWaits;
  }, [botWaits]);

  useEffect(() => {
    heldBotReviewsRef.current = heldBotReviews;
  }, [heldBotReviews]);

  useEffect(() => {
    needsInputPromptsRef.current = needsInputPrompts;
  }, [needsInputPrompts]);

  useEffect(() => {
    if (!activeContact?.chatId) return;
    setThreadAccessIssue(null);
    setRelationshipMemory(activeContact.notes || "");
    setUserInstruction(activeContact.userInstruction || "");
    setDraft(null);
    setFinalText("");
    void loadThreadForContact(activeContact, false);
  }, [activeContact?.platform, activeContact?.chatId]);

  useEffect(() => {
    if (activeContact) return;
    setRelationshipMemory("");
    setUserInstruction("");
    setDraft(null);
    setFinalText("");
    setConversationContext("");
    setCurrentMessage("");
    setThreadAccessIssue(null);
  }, [channel, activeContact?.id]);

  useEffect(() => {
    const entries = Object.entries(pendingBotSends);
    if (entries.length === 0) return;
    const due = entries.find(([, pending]) => pending.secondsLeft <= 0);
    if (due) {
      void sendPendingBotNow(due[1]);
      return;
    }
    const timer = window.setTimeout(() => {
      setPendingBotSends((current) =>
        Object.fromEntries(Object.entries(current).map(([key, pending]) => [key, { ...pending, secondsLeft: Math.max(0, pending.secondsLeft - 1) }]))
      );
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [pendingBotSends]);

  useEffect(() => {
    const entries = Object.entries(botWaits);
    if (entries.length === 0) return;
    const due = entries.find(([, waiting]) => waiting.secondsLeft <= 0);
    if (due) {
      setBotWaits((current) => {
        const next = { ...current };
        delete next[due[0]];
        return next;
      });
      void prepareBotReplyForContact(due[1].contact, "poll", false, due[1].forceReply, true);
      return;
    }
    const timer = window.setTimeout(() => {
      setBotWaits((current) =>
        Object.fromEntries(Object.entries(current).map(([key, waiting]) => [key, { ...waiting, secondsLeft: Math.max(0, waiting.secondsLeft - 1) }]))
      );
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [botWaits]);

  useEffect(() => {
    if (!state || !state.settings.hasCompletedOnboarding) return;
    const poll = window.setInterval(() => {
      void refreshActiveThreadAndBot(false);
    }, 5000);
    return () => window.clearInterval(poll);
  }, [state, activeContact?.platform, activeContact?.chatId]);

  async function refreshIMessageChats(showNotice = true) {
    setBusy("chats");
    setError("");
    try {
      const chats = await window.socializeAI.listIMessageChats();
      setIMessageChats(chats);
      setSelectedChatId((previous) => previous || chats[0]?.chatId || "");
      if (showNotice) setNotice(`Loaded ${chats.length} iMessage chats from this Mac.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function refreshWhatsAppStatus(showNotice = true, settings = settingsDraft) {
    try {
      const status = await window.socializeAI.getWhatsAppBridgeStatus(settings);
      setWhatsAppStatus(status);
      if (status.databasePath) {
        setSettingsDraft((current) =>
          current.whatsappMessagesDbPath ? current : { ...current, whatsappMessagesDbPath: status.databasePath || current.whatsappMessagesDbPath }
        );
      }
      if (showNotice) {
        if (status.ok) setNotice(status.message);
        else setError(`${status.message}${status.detail ? ` ${status.detail}` : ""}`);
      }
      return status;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (showNotice) setError(message);
      return null;
    }
  }

  async function refreshWhatsAppChats(showNotice = true) {
    setBusy("chats");
    if (showNotice) setError("");
    try {
      const status = await refreshWhatsAppStatus(false);
      if (status && !status.databasePath && status.setupAction !== "run_electron") {
        setWhatsAppChats([]);
        if (showNotice) setError(`${status.message}${status.detail ? ` ${status.detail}` : ""}`);
        return;
      }
      const chats = await window.socializeAI.listWhatsAppChats();
      setWhatsAppChats(chats);
      setSelectedWhatsAppChatId((previous) => previous || chats[0]?.chatId || "");
      if (showNotice) setNotice(`Loaded ${chats.length} WhatsApp chats from the local bridge.`);
    } catch (err) {
      if (showNotice) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function refreshChatsForChannel(targetChannel = channel, showNotice = true) {
    if (targetChannel === "whatsapp") {
      await refreshWhatsAppStatus(false);
      await refreshWhatsAppChats(showNotice);
      return;
    }
    await refreshIMessageChats(showNotice);
  }

  async function persist(next: AppState, message?: string, syncSettingsDraft = true) {
    const saved = await window.socializeAI.saveState(next);
    setState(saved);
    if (syncSettingsDraft) setSettingsDraft(saved.settings);
    if (message) setNotice(message);
    return saved;
  }

  async function syncPendingSettings() {
    if (!state) return null;
    if (JSON.stringify(state.settings) === JSON.stringify(settingsDraft)) return state;
    const saved = await window.socializeAI.saveState({
      ...state,
      settings: settingsDraft
    });
    setState(saved);
    setSettingsDraft(saved.settings);
    return saved;
  }

  async function saveSettings() {
    if (!state) return;
    setBusy("settings");
    setError("");
    try {
      const saved = await persist(
        {
          ...state,
          settings: settingsDraft,
          audits: [
            audit("settings_saved", "Settings saved", `Provider: ${settingsDraft.aiProvider}`),
            ...state.audits
          ].slice(0, 500)
        },
        "Settings saved."
      );
      void refreshWhatsAppStatus(false, saved.settings);
      void refreshWhatsAppChats(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function saveOperationalSettings(nextSettings: AppSettings, summary: string, detail: string, message: string) {
    if (!state) return;
    setBusy("settings");
    setError("");
    try {
      await persist(
        {
          ...state,
          settings: nextSettings,
          audits: [audit("settings_saved", summary, detail), ...state.audits].slice(0, 500)
        },
        message
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function setLiveSendForSelected(enabled: boolean) {
    if (!state || !activeContact) return;
    if (activeContact.platform === "imessage") {
      await saveOperationalSettings(
        { ...settingsDraft, iMessageDryRun: !enabled },
        enabled ? "Enabled live iMessage sending" : "Enabled iMessage dry run",
        activeContact.displayName || activeContact.handle,
        enabled ? "Live iMessage sending is on. Pressing Send real iMessage will use Messages.app." : "iMessage dry run is on. Sends will only be recorded."
      );
    } else if (activeContact.platform === "whatsapp") {
      await saveOperationalSettings(
        { ...settingsDraft, whatsappDryRun: !enabled },
        enabled ? "Enabled live WhatsApp sending" : "Enabled WhatsApp dry run",
        activeContact.displayName || activeContact.handle,
        enabled ? "Live WhatsApp sending is on for the configured personal bridge." : "WhatsApp dry run is on. Sends will only be recorded."
      );
    }
  }

  async function setAutopilotSchedule(enabled: boolean) {
    if (!state) return;
    await saveOperationalSettings(
      { ...settingsDraft, autopilotEnabled: enabled },
      enabled ? "Enabled scheduled autopilot" : "Paused scheduled autopilot",
      "Workbench autopilot control",
      enabled ? "Scheduled autopilot is on for saved chats." : "Scheduled autopilot is paused."
    );
  }

  async function prepareBotReplyForContact(
    contact: Contact,
    mode: "manual" | "poll" = "poll",
    regenerate = false,
    forceReply = false,
    skipWait = false,
    instructionOverride?: string
  ) {
    const workflowKey = contactWorkflowKey(contact);
    if (botCheckInFlight.current || (pendingBotSendsRef.current[workflowKey] && !regenerate)) return;
    botCheckInFlight.current = true;
    if (mode === "manual") setBusy("bot-check");
    try {
      if (regenerate) {
        setPendingBotSends((current) => {
          const next = { ...current };
          delete next[workflowKey];
          return next;
        });
      }
      if (skipWait) {
        setBotWaits((current) => {
          const next = { ...current };
          delete next[workflowKey];
          return next;
        });
      }
      const contactInstruction = activeContact && contactMatches(contact, activeContact) ? userInstruction : contact.userInstruction || "";
      const replyInstruction = instructionOverride ?? contactInstruction;
      const result: PreparedAutopilotReply = await window.socializeAI.prepareAutopilotReply({
        contact,
        regenerate,
        forceReply,
        skipWait,
        userInstruction: replyInstruction
      });
      const saved = await window.socializeAI.getState();
      setState(saved);

      if (result.ok && result.status === "ready" && result.contact && result.inboundHash && result.draftText) {
        const resultContact = result.contact;
        const resultInboundHash = result.inboundHash;
        const resultDraftText = result.draftText;
        const resultKey = contactWorkflowKey(resultContact);
        setBotWaits((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setHeldBotReviews((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setHeldReviewTexts((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setNeedsInputPrompts((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setNeedsInputAnswers((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setPendingBotSends((current) => ({
          ...current,
          [resultKey]: {
            contact: resultContact,
            preparedContactKey: result.preparedContactKey || resultKey,
            inboundHash: resultInboundHash,
            text: resultDraftText,
            textParts: result.messageParts?.length ? result.messageParts : [resultDraftText],
            draft: result.draft,
            secondsLeft: 10
          }
        }));
        setNotice("");
        setError("");
        return;
      }

      if (result.status === "needs_input" && result.contact) {
        const resultContact = result.contact;
        const question = result.details.filter(Boolean).join(" ") || "The bot needs one detail from you before replying.";
        const resultKey = contactWorkflowKey(resultContact);
        setBotWaits((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setPendingBotSends((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setHeldBotReviews((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setHeldReviewTexts((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setNeedsInputPrompts((current) => ({
          ...current,
          [resultKey]: {
            contact: resultContact,
            inboundHash: result.inboundHash,
            inboundText: result.inboundText,
            question
          }
        }));
        setNeedsInputAnswers((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setNotice("");
        setError("");
        return;
      }

      if (result.status === "waiting" && result.contact) {
        const resultContact = result.contact;
        const resultKey = contactWorkflowKey(resultContact);
        setBotWaits((current) => ({
          ...current,
          [resultKey]: {
            contact: resultContact,
            secondsLeft: result.waitSeconds ?? 30,
            forceReply,
            inboundText: result.inboundText
          }
        }));
        if (mode === "manual") setNotice(result.message);
        return;
      }

      if (result.status === "held" && result.contact && result.inboundHash && result.draftText) {
        const resultContact = result.contact;
        const resultInboundHash = result.inboundHash;
        const resultDraftText = result.draftText;
        const textParts = result.messageParts?.length ? result.messageParts : [resultDraftText];
        const resultKey = contactWorkflowKey(resultContact);
        setBotWaits((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setPendingBotSends((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setNeedsInputPrompts((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setNeedsInputAnswers((current) => {
          const next = { ...current };
          delete next[resultKey];
          return next;
        });
        setHeldBotReviews((current) => ({
          ...current,
          [resultKey]: {
            contact: resultContact,
            preparedContactKey: result.preparedContactKey || resultKey,
            inboundHash: resultInboundHash,
            text: resultDraftText,
            textParts,
            draft: result.draft,
            reason: result.details.filter(Boolean).join(" ") || result.message
          }
        }));
        setHeldReviewTexts((current) => ({ ...current, [resultKey]: textParts.join("\n\n") }));
        setNotice("");
        setError("");
        return;
      }

      if (result.status === "held" || result.status === "blocked") {
        const detail = result.details.filter(Boolean).join(" ");
        setError(detail ? `${result.message} ${detail}` : result.message);
      } else if (mode === "manual") {
        setNotice(result.message);
      }
    } catch (err) {
      if (mode === "manual") setError(err instanceof Error ? err.message : String(err));
    } finally {
      botCheckInFlight.current = false;
      if (mode === "manual") setBusy(null);
    }
  }

  async function sendPendingBotNow(explicitPending?: PendingBotSend) {
    const pending = isPendingBotSend(explicitPending) ? explicitPending : pendingBotSend;
    if (!pending || pendingSendInFlight.current) return;
    const workflowKey = contactWorkflowKey(pending.contact);
    const latestPending = pendingBotSendsRef.current[workflowKey];
    if (!latestPending || latestPending.inboundHash !== pending.inboundHash || latestPending.preparedContactKey !== pending.preparedContactKey) return;
    pendingSendInFlight.current = true;
    setBusy("bot-send");
    setError("");
    try {
      await syncPendingSettings();
      const result = await window.socializeAI.sendPreparedAutopilotReply({
        contact: pending.contact,
        preparedContactKey: pending.preparedContactKey,
        inboundHash: pending.inboundHash,
        text: pending.text,
        textParts: pending.textParts
      });
      const contactName = pending.contact.displayName || "this chat";
      setPendingBotSends((current) => {
        const next = { ...current };
        delete next[workflowKey];
        return next;
      });
      if (result.ok) setNotice(result.dryRun ? `Dry run recorded for ${contactName}.` : `Bot sent a reply to ${contactName}.`);
      else setError(result.detail || result.message);
      const saved = await window.socializeAI.getState();
      setState(saved);
      setSettingsDraft(saved.settings);
      await loadThreadForContact(pending.contact, false, true);
      void refreshChatsForChannel(pending.contact.platform === "whatsapp" ? "whatsapp" : "imessage", false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pendingSendInFlight.current = false;
      setBusy(null);
    }
  }

  async function cancelPendingBotSend() {
    if (!pendingBotSend) return;
    const workflowKey = contactWorkflowKey(pendingBotSend.contact);
    setBusy("bot-cancel");
    try {
      const result = await window.socializeAI.cancelPreparedAutopilotReply({
        contact: pendingBotSend.contact,
        inboundHash: pendingBotSend.inboundHash,
        reason: "User cancelled from the conversation window."
      });
      setPendingBotSends((current) => {
        const next = { ...current };
        delete next[workflowKey];
        return next;
      });
      if (result.ok) setNotice("Pending bot reply cancelled.");
      else setError(result.message);
      const saved = await window.socializeAI.getState();
      setState(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function regeneratePendingBotSend() {
    if (!pendingBotSend) return;
    await prepareBotReplyForContact(pendingBotSend.contact, "manual", true, true, true);
  }

  async function skipBotWait() {
    if (!botWait) return;
    await prepareBotReplyForContact(botWait.contact, "manual", false, true, true);
  }

  async function approveHeldBotReview() {
    if (!heldBotReview || pendingSendInFlight.current) return;
    const workflowKey = contactWorkflowKey(heldBotReview.contact);
    const textParts = splitMessageParts(heldReviewText);
    if (textParts.length === 0) {
      setError("Write a reply before approving.");
      return;
    }
    pendingSendInFlight.current = true;
    setBusy("bot-send");
    setError("");
    try {
      await syncPendingSettings();
      const result = await window.socializeAI.sendPreparedAutopilotReply({
        contact: heldBotReview.contact,
        preparedContactKey: heldBotReview.preparedContactKey,
        inboundHash: heldBotReview.inboundHash,
        text: textParts.join("\n\n"),
        textParts
      });
      const contactName = heldBotReview.contact.displayName || "this chat";
      setHeldBotReviews((current) => {
        const next = { ...current };
        delete next[workflowKey];
        return next;
      });
      setHeldReviewTexts((current) => {
        const next = { ...current };
        delete next[workflowKey];
        return next;
      });
      if (result.ok) setNotice(result.dryRun ? `Dry run recorded for ${contactName}.` : `Approved and sent reply to ${contactName}.`);
      else setError(result.detail || result.message);
      const saved = await window.socializeAI.getState();
      setState(saved);
      setSettingsDraft(saved.settings);
      await loadThreadForContact(heldBotReview.contact, false, true);
      void refreshChatsForChannel(heldBotReview.contact.platform === "whatsapp" ? "whatsapp" : "imessage", false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pendingSendInFlight.current = false;
      setBusy(null);
    }
  }

  async function denyHeldBotReview() {
    if (!heldBotReview) return;
    const workflowKey = contactWorkflowKey(heldBotReview.contact);
    setBusy("bot-cancel");
    setError("");
    try {
      const result = await window.socializeAI.cancelPreparedAutopilotReply({
        contact: heldBotReview.contact,
        inboundHash: heldBotReview.inboundHash,
        reason: "User denied the held draft from the review popup."
      });
      setHeldBotReviews((current) => {
        const next = { ...current };
        delete next[workflowKey];
        return next;
      });
      setHeldReviewTexts((current) => {
        const next = { ...current };
        delete next[workflowKey];
        return next;
      });
      if (result.ok) setNotice("Held bot reply denied.");
      else setError(result.message);
      const saved = await window.socializeAI.getState();
      setState(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function submitNeedsInputAnswer() {
    if (!needsInputPrompt) return;
    const answer = needsInputAnswer.trim();
    if (!answer) {
      setError("Type the missing answer first.");
      return;
    }
    const contact = needsInputPrompt.contact;
    const workflowKey = contactWorkflowKey(contact);
    setUserInstruction(answer);
    patchContactWorkbenchFields(contact, { userInstruction: answer });
    setNeedsInputPrompts((current) => {
      const next = { ...current };
      delete next[workflowKey];
      return next;
    });
    setNeedsInputAnswers((current) => {
      const next = { ...current };
      delete next[workflowKey];
      return next;
    });
    await prepareBotReplyForContact(contact, "manual", false, true, true, answer);
  }

  function dismissNeedsInputPrompt() {
    if (needsInputPrompt) {
      const workflowKey = contactWorkflowKey(needsInputPrompt.contact);
      setNeedsInputPrompts((current) => {
        const next = { ...current };
        delete next[workflowKey];
        return next;
      });
      setNeedsInputAnswers((current) => {
        const next = { ...current };
        delete next[workflowKey];
        return next;
      });
    }
    setNotice("Bot paused this reply until you provide the missing answer.");
  }

  async function refreshActiveThreadAndBot(showNotice = false) {
    if (!state) return;
    if (activeContact?.chatId) {
      await loadThreadForContact(activeContact, showNotice, !showNotice);
    }

    const runningContacts = state.contacts.filter((contact) => botIsRunningForContact(state, contact));
    for (const runningContact of runningContacts) {
      const workflowKey = contactWorkflowKey(runningContact);
      if (
        pendingBotSendsRef.current[workflowKey] ||
        botWaitsRef.current[workflowKey] ||
        heldBotReviewsRef.current[workflowKey] ||
        needsInputPromptsRef.current[workflowKey]
      ) {
        continue;
      }
      await prepareBotReplyForContact(runningContact, "poll");
    }
  }

  async function startBotForSelectedChat() {
    if (!state || !activeContact) return;
    if ((activeContact.platform !== "imessage" && activeContact.platform !== "whatsapp") || !activeContact.chatId) {
      setError("Choose an iMessage or WhatsApp chat first.");
      return;
    }
    if (activeContact.optedOut) {
      setError("This chat is marked opted out.");
      return;
    }

    setBusy("bot");
    setError("");
    setNotice("");
    try {
      if (activeContact.platform === "whatsapp") {
        const status = await window.socializeAI.getWhatsAppBridgeStatus(settingsDraft);
        setWhatsAppStatus(status);
        if (!status.ok) {
          setError(`${status.message}${status.detail ? ` ${status.detail}` : ""}`);
          return;
        }
      }
      const existing = state.contacts.find(
        (contact) =>
          contact.platform === activeContact.platform &&
          (contact.chatId === activeContact.chatId || contact.chatGuid === activeContact.chatGuid || contact.id === activeContact.id)
      );
      const botContact: Contact = {
        ...activeContact,
        ...existing,
        displayName: activeContact.displayName || existing?.displayName || (activeContact.platform === "whatsapp" ? "WhatsApp chat" : "iMessage chat"),
        handle: activeContact.handle || existing?.handle || "",
        chatId: activeContact.chatId,
        chatGuid: activeContact.chatGuid || existing?.chatGuid,
        relationship: existing?.relationship || activeContact.relationship || "family/friend",
        notes: relationshipMemory,
        userInstruction,
        allowAutopilot: true,
        optedOut: existing?.optedOut ?? activeContact.optedOut
      };
      const matchesSelected = (contact: Contact) =>
        contact.platform === botContact.platform && (contact.chatId === botContact.chatId || contact.chatGuid === botContact.chatGuid || contact.id === botContact.id);
      const contacts = [botContact, ...state.contacts.filter((contact) => !matchesSelected(contact))];
      await persist(
        {
          ...state,
          settings: {
            ...settingsDraft,
            iMessageDryRun: activeContact.platform === "imessage" ? false : settingsDraft.iMessageDryRun,
            whatsappDryRun: activeContact.platform === "whatsapp" ? false : settingsDraft.whatsappDryRun,
            requireHumanApproval: settingsDraft.permissionMode === "extra_safe",
            autopilotEnabled: false
          },
          contacts,
          audits: [
            audit(
              "settings_saved",
              `Started bot for ${botContact.displayName}`,
              `Live ${activeContact.platform === "whatsapp" ? "WhatsApp" : "iMessage"} autopilot enabled for this chat. Other running chats were left unchanged.`
            ),
            ...state.audits
          ].slice(0, 500)
        },
        `Bot started for ${botContact.displayName}.`
      );
      setSelectedContactId(botContact.id);
      const refreshed = await window.socializeAI.getState();
      setState(refreshed);
      setSettingsDraft(refreshed.settings);
      await loadThreadForContact(botContact, false, true);
      await prepareBotReplyForContact(botContact, "manual", false, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function stopBotForSelectedChat() {
    if (!state || !activeContact) return;
    setBusy("bot");
    setError("");
    setNotice("");
    try {
      const contacts = state.contacts.map((contact) =>
        contact.platform === activeContact.platform &&
        (contact.chatId === activeContact.chatId || contact.chatGuid === activeContact.chatGuid || contact.id === activeContact.id)
          ? { ...contact, allowAutopilot: false }
          : contact
      );
      const anyChatStillRunning = contacts.some((contact) => contact.allowAutopilot);
      if (pendingBotSend && contactMatches(pendingBotSend.contact, activeContact)) {
        const workflowKey = contactWorkflowKey(pendingBotSend.contact);
        setPendingBotSends((current) => {
          const next = { ...current };
          delete next[workflowKey];
          return next;
        });
      }
      await persist(
        {
          ...state,
          settings: {
            ...settingsDraft,
            autopilotEnabled: anyChatStillRunning && settingsDraft.autopilotEnabled
          },
          contacts,
          audits: [
            audit("settings_saved", `Stopped bot for ${activeContact.displayName}`, "Autopilot disabled for the selected chat."),
            ...state.audits
          ].slice(0, 500)
        },
        `Bot stopped for ${activeContact.displayName}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function completeOnboarding(settings: AppSettings) {
    setBusy("onboarding");
    setError("");
    try {
      const saved = await window.socializeAI.completeOnboarding(settings);
      setState(saved);
      setSettingsDraft(saved.settings);
      setSelectedContactId(saved.contacts[0]?.id ?? "");
      setNotice("Onboarding complete.");
      void refreshIMessageChats(false);
      void refreshWhatsAppStatus(false, saved.settings);
      void refreshWhatsAppChats(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function testProvider(settings = settingsDraft) {
    setBusy("provider");
    setError("");
    try {
      const result: ProviderTestResult = await window.socializeAI.testProvider(settings);
      if (result.ok) setNotice(result.message);
      else setError(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function generateDraft() {
    if (!activeContact) {
      setError("Choose an iMessage or WhatsApp chat first.");
      return;
    }
    setBusy("draft");
    setError("");
    setNotice("");
    try {
      await syncPendingSettings();
      let context = conversationContext;
      let latest = currentMessage;
      if ((activeContact.platform === "imessage" || activeContact.platform === "whatsapp") && activeContact.chatId) {
        const loaded = await loadThreadForContact(activeContact, false);
        context = loaded.context;
        latest = loaded.latest;
      }
      const result = await window.socializeAI.generateDraft({
        contact: activeContact,
        currentMessage: latest,
        conversationContext: context,
        relationshipMemory: relationshipMemory || activeContact.notes,
        userInstruction
      });
      setDraft(result);
      setFinalText(draftTextForDisplay(settingsDraft, result));
      setNotice("Draft generated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function sendMessage() {
    if (!activeContact) return;
    setBusy("send");
    setError("");
    setNotice("");
    try {
      await syncPendingSettings();
      const result: SendMessageResult = await window.socializeAI.sendMessage({
        contact: activeContact,
        text: finalText
      });
      if (result.ok) setNotice(result.message);
      else setError(result.message);
      const saved = await window.socializeAI.getState();
      setState(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function importHistory() {
    if (!activeContact) return;
    await loadThreadForContact(activeContact, true);
  }

  async function loadThreadForContact(contact: Contact, showNotice = true, silent = false) {
    if (!silent) {
      setBusy("import");
      setError("");
      setThreadAccessIssue(null);
    }
    try {
      const importMethod = contact.platform === "whatsapp" ? window.socializeAI.importWhatsAppHistory : window.socializeAI.importIMessageHistory;
      const result: ImportHistoryResult = await importMethod({
        handle: contact.handle,
        chatId: contact.chatId,
        limit: 80
      });
      if (result.ok) {
        const latest = latestInboundFromTranscript(result.messages);
        setConversationContext(result.messages);
        setCurrentMessage(latest);
        setThreadAccessIssue(null);
        if (showNotice) setNotice(result.message);
        return { context: result.messages, latest };
      } else {
        const issue = threadAccessIssueFromImport(contact, result);
        setThreadAccessIssue(issue);
        if (!silent) setError(issue.title);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const issue: ThreadAccessIssue = {
        platform: contact.platform === "whatsapp" ? "whatsapp" : "imessage",
        title: "Could not load this thread",
        message
      };
      setThreadAccessIssue(issue);
      if (!silent) setError(issue.title);
    } finally {
      if (!silent) setBusy(null);
    }
    return { context: conversationContext, latest: currentMessage };
  }

  async function saveContact(contact: Contact) {
    if (!state) return;
    const existing = state.contacts.find((item) => item.id === contact.id);
    const contactToSave = {
      ...existing,
      ...contact,
      userInstruction: contact.userInstruction ?? existing?.userInstruction ?? ""
    };
    const contacts = existing ? state.contacts.map((item) => (item.id === contact.id ? contactToSave : item)) : [contactToSave, ...state.contacts];
    await persist(
      {
        ...state,
        contacts,
        audits: [
          audit("contact_saved", `Saved ${contactToSave.displayName || "contact"}`, `${contactToSave.platform}: ${contactToSave.handle}`),
          ...state.audits
        ].slice(0, 500)
      },
      "Contact saved.",
      false
    );
    setContactDraft(blankContact());
    setSelectedContactId(contactToSave.id);
  }

  async function manageSelectedChatForAutopilot() {
    if (!state) return;
    const sourceChat = channel === "whatsapp" ? selectedWhatsAppChat : selectedChat;
    if (!sourceChat) return;
    const existing = state.contacts.find((contact) => contact.platform === channel && contact.chatId === sourceChat.chatId);
    const contact = channel === "whatsapp" ? contactFromWhatsAppChat(sourceChat as WhatsAppChat, existing) : contactFromChat(sourceChat as IMessageChat, existing);
    await saveContact({ ...contact, allowAutopilot: true, relationship: contact.relationship || "family/friend" });
    setNotice(`${contact.displayName} is saved for autopilot. Keep dry run on until you trust the drafts.`);
  }

  async function runAutopilotOnce() {
    setBusy("autopilot");
    setError("");
    setNotice("");
    try {
      const result = await window.socializeAI.runAutopilotOnce();
      if (result.ok) setNotice(result.message);
      else setError(result.message);
      const saved = await window.socializeAI.getState();
      setState(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function checkMacPermissions() {
    setBusy("permissions");
    setError("");
    try {
      const report = await window.socializeAI.checkMacPermissions();
      setPermissionReport(report);
      const okCount = Object.values(report).filter((item) => item.ok).length;
      setNotice(`Mac permissions checked: ${okCount}/3 ready.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function checkWhatsAppBridge() {
    setBusy("whatsapp");
    setError("");
    try {
      const status = await window.socializeAI.getWhatsAppBridgeStatus(settingsDraft);
      setWhatsAppStatus(status);
      if (status.databasePath) {
        setSettingsDraft((current) =>
          current.whatsappMessagesDbPath ? current : { ...current, whatsappMessagesDbPath: status.databasePath || current.whatsappMessagesDbPath }
        );
      }
      if (status.ok) setNotice(status.message);
      else setError(`${status.message}${status.detail ? ` ${status.detail}` : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function startWhatsAppBridge() {
    setBusy("whatsapp-start");
    setError("");
    try {
      const status = await window.socializeAI.startWhatsAppBridge(settingsDraft);
      setWhatsAppStatus(status);
      if (status.databasePath) {
        setSettingsDraft((current) =>
          current.whatsappMessagesDbPath ? current : { ...current, whatsappMessagesDbPath: status.databasePath || current.whatsappMessagesDbPath }
        );
      }
      if (status.setupAction === "runtime_install_failed" || status.setupAction === "install_git") {
        setError(`${status.message}${status.detail ? ` ${status.detail}` : ""}`);
      } else {
        setNotice(`${status.message}${status.detail ? ` ${status.detail}` : ""}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteContact(contactId: string) {
    if (!state) return;
    const contacts = state.contacts.filter((item) => item.id !== contactId);
    await persist({ ...state, contacts }, "Contact deleted.", false);
    setSelectedContactId(contacts[0]?.id ?? "");
  }

  if (!state) {
    return (
      <div className="loading-shell">
        <div className="pulse-mark">
          <MessagesSquare size={34} />
        </div>
        <p>Opening SocializeAI</p>
      </div>
    );
  }

  if (!state.settings.hasCompletedOnboarding) {
    return (
      <Onboarding
        settings={settingsDraft}
        setSettings={setSettingsDraft}
        busy={busy}
        error={error}
        notice={notice}
        onTest={() => testProvider(settingsDraft)}
        onComplete={() => completeOnboarding({ ...settingsDraft, hasCompletedOnboarding: true })}
        onOpenPermissions={openFullDiskAccessSettings}
      />
    );
  }

  return (
    <div className={`app-shell ${settingsDraft.privacyBlurEnabled ? "privacy-blur-enabled" : ""}`}>
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark">
            <MessagesSquare size={24} />
          </div>
          <div>
            <strong>SocializeAI</strong>
            <span>local-first messenger</span>
          </div>
        </div>

        <nav className="nav-list">
          <NavButton active={view === "workbench"} icon={<Wand2 size={18} />} label="Workbench" onClick={() => setView("workbench")} />
          {view === "workbench" && (
            <div className="nav-submenu" aria-label="Workbench channel">
              <button className={channel === "imessage" ? "active" : ""} onClick={() => setChannel("imessage")} type="button">
                iMessage
              </button>
              <button className={channel === "whatsapp" ? "active" : ""} onClick={() => setChannel("whatsapp")} type="button">
                WhatsApp
              </button>
            </div>
          )}
          <NavButton active={view === "settings"} icon={<SlidersHorizontal size={18} />} label="Settings" onClick={() => setView("settings")} />
          <NavButton active={view === "audit"} icon={<ClipboardList size={18} />} label="Audit" onClick={() => setView("audit")} />
        </nav>

        <div className="sidebar-card">
          <span>Provider</span>
          <strong>{providerLabel(state.settings)}</strong>
          <small>{selectedModelLabel(state.settings)}</small>
        </div>
      </aside>

      <main className="main-panel">
        <StatusBar error={error} notice={notice} />
        {view === "workbench" && (
          <Workbench
            state={state}
            channel={channel}
            selectedContact={activeContact}
            imessageChats={imessageChats}
            whatsappChats={whatsappChats}
            selectedChatId={selectedChatId}
            setSelectedChatId={setSelectedChatId}
            selectedWhatsAppChatId={selectedWhatsAppChatId}
            setSelectedWhatsAppChatId={setSelectedWhatsAppChatId}
            chatSearch={chatSearch}
            setChatSearch={setChatSearch}
            whatsappStatus={whatsappStatus}
            currentMessage={currentMessage}
            setCurrentMessage={setCurrentMessage}
            conversationContext={conversationContext}
            setConversationContext={setConversationContext}
            relationshipMemory={relationshipMemory}
            setRelationshipMemory={updateRelationshipMemory}
            userInstruction={userInstruction}
            setUserInstruction={updateUserInstruction}
            draft={draft}
            finalText={finalText}
            setFinalText={setFinalText}
            threadAccessIssue={threadAccessIssue}
            pendingBotSend={pendingBotSend}
            botWait={botWait}
            heldBotReview={heldBotReview}
            heldReviewText={heldReviewText}
            setHeldReviewText={updateHeldReviewText}
            needsInputPrompt={needsInputPrompt}
            needsInputAnswer={needsInputAnswer}
            setNeedsInputAnswer={updateNeedsInputAnswer}
            busy={busy}
            onSend={sendMessage}
            onImport={importHistory}
            onRefreshChats={() => refreshChatsForChannel(channel)}
            onStartWhatsAppBridge={startWhatsAppBridge}
            onRefreshThread={() => refreshActiveThreadAndBot(true)}
            onOpenPermissions={openFullDiskAccessSettings}
            onCheckPermissions={checkMacPermissions}
            onManageChat={manageSelectedChatForAutopilot}
            onRunAutopilot={runAutopilotOnce}
            onSetLiveSend={setLiveSendForSelected}
            onSetAutopilotSchedule={setAutopilotSchedule}
            onStartBot={startBotForSelectedChat}
            onStopBot={stopBotForSelectedChat}
            onSendPendingNow={sendPendingBotNow}
            onCancelPending={cancelPendingBotSend}
            onRegeneratePending={regeneratePendingBotSend}
            onSkipWait={skipBotWait}
            onApproveHeldReview={approveHeldBotReview}
            onDenyHeldReview={denyHeldBotReview}
            onSubmitNeedsInput={submitNeedsInputAnswer}
            onDismissNeedsInput={dismissNeedsInputPrompt}
          />
        )}
        {view === "contacts" && (
          <ContactsPanel
            contacts={state.contacts}
            contactDraft={contactDraft}
            setContactDraft={setContactDraft}
            onSave={saveContact}
            onEdit={setContactDraft}
            onDelete={deleteContact}
          />
        )}
        {view === "settings" && (
          <SettingsPanel
            settings={settingsDraft}
            updateSettings={updateSettingsDraft}
            permissionReport={permissionReport}
            whatsappStatus={whatsappStatus}
            busy={busy}
            onSave={saveSettings}
            onTest={() => testProvider(settingsDraft)}
            onCheckPermissions={checkMacPermissions}
            onCheckWhatsApp={checkWhatsAppBridge}
            onStartWhatsApp={startWhatsAppBridge}
            onOpenPermissions={openFullDiskAccessSettings}
            onReveal={() => window.socializeAI.revealDataFolder()}
          />
        )}
        {view === "audit" && <AuditPanel state={state} />}
      </main>
    </div>
  );
}

function Onboarding(props: {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  busy: string | null;
  error: string;
  notice: string;
  onTest: () => void;
  onComplete: () => void;
  onOpenPermissions: () => void;
}) {
  const updateSettings = (patch: Partial<AppSettings>) => props.setSettings({ ...props.settings, ...patch });
  return (
    <div className="onboarding-shell">
      <section className="onboarding-card">
        <div className="onboarding-art">
          <div className="signal-frame signal-one" />
          <div className="signal-frame signal-two" />
          <MessagesSquare size={62} />
        </div>
        <div className="onboarding-copy">
          <span className="eyebrow">Private desktop assistant</span>
          <h1>Set up your messaging brain.</h1>
          <p>Choose OpenAI or a local model. You can change this later in settings.</p>
        </div>
        <ProviderSettings settings={props.settings} updateSettings={updateSettings} compact={false} />
        <StatusBar error={props.error} notice={props.notice} />
        <div className="action-row">
          <button className="secondary-button" onClick={props.onOpenPermissions}>
            <ShieldCheck size={16} />
            Full Disk Access
          </button>
          <button className="secondary-button" onClick={props.onTest} disabled={props.busy === "provider"}>
            <Cpu size={16} />
            {props.busy === "provider" ? "Testing" : "Test provider"}
          </button>
          <button className="primary-button" onClick={props.onComplete} disabled={props.busy === "onboarding"}>
            <ChevronRight size={16} />
            Start app
          </button>
        </div>
      </section>
    </div>
  );
}

function Workbench(props: {
  state: AppState;
  channel: MessagingChannel;
  selectedContact?: Contact;
  imessageChats: IMessageChat[];
  whatsappChats: WhatsAppChat[];
  selectedChatId: string;
  setSelectedChatId: (id: string) => void;
  selectedWhatsAppChatId: string;
  setSelectedWhatsAppChatId: (id: string) => void;
  chatSearch: string;
  setChatSearch: (value: string) => void;
  whatsappStatus: WhatsAppBridgeStatus | null;
  currentMessage: string;
  setCurrentMessage: (value: string) => void;
  conversationContext: string;
  setConversationContext: (value: string) => void;
  relationshipMemory: string;
  setRelationshipMemory: (value: string) => void;
  userInstruction: string;
  setUserInstruction: (value: string) => void;
  draft: DraftResult | null;
  finalText: string;
  setFinalText: (value: string) => void;
  threadAccessIssue: ThreadAccessIssue | null;
  pendingBotSend: PendingBotSend | null;
  botWait: BotWait | null;
  heldBotReview: HeldBotReview | null;
  heldReviewText: string;
  setHeldReviewText: (value: string) => void;
  needsInputPrompt: NeedsInputPrompt | null;
  needsInputAnswer: string;
  setNeedsInputAnswer: (value: string) => void;
  busy: string | null;
  onSend: () => void;
  onImport: () => void;
  onRefreshChats: () => void;
  onStartWhatsAppBridge: () => void;
  onRefreshThread: () => void;
  onOpenPermissions: () => void;
  onCheckPermissions: () => void;
  onManageChat: () => void;
  onRunAutopilot: () => void;
  onSetLiveSend: (enabled: boolean) => void;
  onSetAutopilotSchedule: (enabled: boolean) => void;
  onStartBot: () => void;
  onStopBot: () => void;
  onSendPendingNow: () => void;
  onCancelPending: () => void;
  onRegeneratePending: () => void;
  onSkipWait: () => void;
  onApproveHeldReview: () => void;
  onDenyHeldReview: () => void;
  onSubmitNeedsInput: () => void;
  onDismissNeedsInput: () => void;
}) {
  const selected = props.selectedContact;
  const chats = props.channel === "whatsapp" ? props.whatsappChats : props.imessageChats;
  const selectedChatId = props.channel === "whatsapp" ? props.selectedWhatsAppChatId : props.selectedChatId;
  const setSelectedChatId = props.channel === "whatsapp" ? props.setSelectedWhatsAppChatId : props.setSelectedChatId;
  const selectedChat = chats.find((chat) => chat.chatId === selectedChatId) ?? chats[0];
  const managed = selected ? props.state.contacts.find((contact) => contactMatches(contact, selected)) : undefined;
  const dryRun =
    selected?.platform === "whatsapp"
      ? props.state.settings.whatsappDryRun
      : selected?.platform === "imessage"
        ? props.state.settings.iMessageDryRun
        : true;
  const platformLabel = props.channel === "whatsapp" ? "WhatsApp" : "iMessage";
  const botRunning = botIsRunningForContact(props.state, selected);
  const participantLine =
    selectedChat?.participantNames?.slice(0, 4).join(", ") ||
    selectedChat?.participantHandles.slice(0, 4).join(", ") ||
    selectedChat?.serviceName ||
    selected?.handle ||
    "";
  const query = props.chatSearch.trim().toLowerCase();
  const visibleChats = query
    ? chats.filter((chat) => {
        const haystack = [
          chat.displayName,
          chat.contactName,
          chat.chatIdentifier,
          chat.serviceName,
          chat.lastText,
          chat.lastMessageAt,
          ...chat.participantHandles,
          ...(chat.participantNames || [])
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(query);
      })
    : chats;
  const sendButtonLabel =
    props.busy === "send"
      ? "Processing"
      : dryRun
        ? "Record dry run only"
        : selected?.platform === "imessage"
          ? "Send real iMessage"
          : selected?.platform === "whatsapp"
            ? "Send real WhatsApp"
            : "Record manual send";
  const botButtonLabel = props.busy === "bot" ? (botRunning ? "Stopping" : "Starting") : botRunning ? "Stop bot" : "Start bot";
  const chatBubbles = chatBubblesFromTranscript(props.conversationContext);
  const loadedCount = chatBubbles.length;
  const activityItems = props.state.audits
    .filter((item) => {
      const haystack = `${item.summary} ${item.detail || ""}`.toLowerCase();
      const name = selected?.displayName?.toLowerCase();
      const handle = selected?.handle?.toLowerCase();
      return !selected || (name && haystack.includes(name)) || (handle && haystack.includes(handle)) || item.type === "provider_test";
    })
    .slice(0, 8);

  return (
    <div className="workspace-grid">
      <section className="contact-rail">
        <div className="section-heading">
          <span>{platformLabel} chats</span>
          <strong>{query ? `${visibleChats.length}/${chats.length}` : chats.length}</strong>
        </div>
        <label className="search-field">
          <span>Search chats</span>
          <input
            className="private-field"
            value={props.chatSearch}
            onChange={(event) => props.setChatSearch(event.target.value)}
            placeholder="Name, number, group, or text"
          />
        </label>
        <button className="secondary-button full-width" onClick={props.onRefreshChats} disabled={props.busy === "chats"}>
          <MessagesSquare size={16} />
          {props.busy === "chats" ? "Loading" : `Refresh ${platformLabel}`}
        </button>
        {props.channel === "whatsapp" && props.whatsappStatus && !props.whatsappStatus.ok && (
          <div className="channel-status warn">
            <strong>{props.whatsappStatus.message}</strong>
            {props.whatsappStatus.detail && <span>{props.whatsappStatus.detail}</span>}
            <button className="secondary-button compact-action" onClick={props.onStartWhatsAppBridge} disabled={props.busy === "whatsapp-start"}>
              <Bot size={15} />
              {props.busy === "whatsapp-start" ? "Setting up" : "Start bridge"}
            </button>
          </div>
        )}
        <div className="contact-list chat-list">
          {chats.length === 0 && (
            <div className="empty-list">
              <p>No {platformLabel} chats loaded yet.</p>
              <small>
                {props.channel === "whatsapp"
                  ? "Start the bridge, scan the QR code, then refresh WhatsApp."
                  : "Grant Full Disk Access to the app if refresh fails."}
              </small>
            </div>
          )}
          {chats.length > 0 && visibleChats.length === 0 && (
            <div className="empty-list">
              <p>No matches.</p>
              <small>Try a name, phone number, group, or recent message text.</small>
            </div>
          )}
          {visibleChats.map((chat) => (
            <button
              className={`contact-row ${selectedChatId === chat.chatId ? "active" : ""}`}
              key={chat.chatId}
              onClick={() => setSelectedChatId(chat.chatId)}
            >
              <span className="avatar private-avatar">{initials(chat.displayName || chat.chatIdentifier || platformLabel)}</span>
              <span>
                <strong className="private-text">{chat.displayName || chat.chatIdentifier || "Unnamed chat"}</strong>
                <small className="private-text">
                  {chat.contactName && !chat.isGroup ? `${chat.chatIdentifier} - ` : ""}
                  {chat.isGroup ? "group" : platformLabel} {chat.lastMessageAt ? `- ${chat.lastMessageAt}` : ""}
                </small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="composer-panel">
        <div className="panel-title-row">
          <div>
            <span className="eyebrow">Selected {platformLabel} thread</span>
            <h2 className="private-text">{selected?.displayName || selectedChat?.displayName || `Choose a ${platformLabel} chat`}</h2>
          </div>
          <div className={`mode-pill ${botRunning ? "live" : "safe"}`}>{botRunning ? "Bot running" : "Bot off"}</div>
        </div>

        {selectedChat && (
          <div className="thread-hero">
            <div className="thread-summary">
              <div>
                <strong className="private-text">{selectedChat.isGroup ? "Group chat" : selectedChat.chatIdentifier || selected?.handle}</strong>
                <span className="private-text">{participantLine}</span>
              </div>
              <p className="private-text">{selectedChat.lastText || "No text preview available."}</p>
            </div>
            <div className="thread-metrics">
              <div>
                <span>Loaded</span>
                <strong>{loadedCount}</strong>
              </div>
              <div>
                <span>Autopilot</span>
                <strong>{managed?.allowAutopilot ? "Allowed" : "Off"}</strong>
              </div>
            </div>
          </div>
        )}

        <div className={`bot-control-card ${botRunning ? "running" : ""}`}>
          <div>
            <span className="eyebrow">Automatic replies</span>
            <strong>{botRunning ? "Bot is chatting with this person" : "Press Start bot to let it handle this chat"}</strong>
            <p>
              {botRunning
                ? `SocializeAI is watching this selected ${platformLabel} thread and can send live low-risk replies automatically.`
                : `Start bot turns on live ${platformLabel} replies for this thread, then checks the latest message.`}
            </p>
          </div>
          <button
            className={botRunning ? "secondary-button stop-bot-button" : "primary-button start-bot-button"}
            onClick={botRunning ? props.onStopBot : props.onStartBot}
            disabled={!selectedChat || selected?.platform !== props.channel || props.busy === "bot"}
          >
            {botRunning ? <ShieldCheck size={18} /> : <Bot size={18} />}
            {botButtonLabel}
          </button>
        </div>

        <label className="field-block">
          <span>Relationship memory / boundaries</span>
          <textarea
            className="private-field"
            value={props.relationshipMemory}
            onChange={(event) => props.setRelationshipMemory(event.target.value)}
            placeholder="Optional: grandma likes short updates, uncle jokes a lot, avoid money talk, etc."
            rows={5}
          />
        </label>

        <label className="field-block">
          <span>Optional instruction for the next reply</span>
          <input
            className="private-field"
            value={props.userInstruction}
            onChange={(event) => props.setUserInstruction(event.target.value)}
            placeholder="Example: keep it short, say I can meet after 6, do not over-explain."
          />
        </label>

        <div className="activity-panel">
          <div className="section-heading compact-heading">
            <span>Activity</span>
            <strong>{activityItems.length}</strong>
          </div>
          <div className="activity-list">
            {activityItems.length > 0 ? (
              activityItems.map((item) => (
                <div className="activity-item" key={item.id}>
                  <span>{formatShortTime(item.at)}</span>
                  <strong className="private-text">{friendlyAuditSummary(item)}</strong>
                  {item.detail && <p className="private-text">{friendlyAuditDetail(item.detail)}</p>}
                </div>
              ))
            ) : (
              <div className="activity-empty">No bot activity yet.</div>
            )}
          </div>
        </div>
      </section>

      <section className="chat-panel">
        <div className="panel-title-row">
          <div>
            <span className="eyebrow">Conversation</span>
            <h2 className="private-text">{selected?.displayName || selectedChat?.displayName || "Chat"}</h2>
          </div>
          <button className="icon-button" disabled={!selected || selected.platform !== props.channel || props.busy === "import"} onClick={props.onRefreshThread} title="Reload chat">
            <RefreshCw size={17} />
          </button>
        </div>

        {props.threadAccessIssue && (
          <div className={`thread-access-card ${props.threadAccessIssue.needsFullDiskAccess ? "warn" : ""}`}>
            <div className="thread-access-icon">
              <AlertTriangle size={20} />
            </div>
            <div>
              <span className="eyebrow">{props.threadAccessIssue.platform === "imessage" ? "iMessage access" : "Thread access"}</span>
              <strong>{props.threadAccessIssue.title}</strong>
              <p>{props.threadAccessIssue.message}</p>
              {props.threadAccessIssue.detail && <small>{props.threadAccessIssue.detail}</small>}
              <div className="thread-access-actions">
                {props.threadAccessIssue.needsFullDiskAccess && (
                  <button className="primary-button" onClick={props.onOpenPermissions}>
                    <ShieldCheck size={16} />
                    Full Disk Access
                  </button>
                )}
                <button className="secondary-button" onClick={props.onCheckPermissions} disabled={props.busy === "permissions"}>
                  <Check size={16} />
                  {props.busy === "permissions" ? "Checking" : "Check access"}
                </button>
                <button className="secondary-button" onClick={props.onRefreshThread} disabled={props.busy === "import"}>
                  <RefreshCw size={16} />
                  Reload chat
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="chat-thread">
          {chatBubbles.length > 0 ? (
            chatBubbles.map((message) => (
              <div className={`message-row ${message.fromMe ? "from-me" : "from-them"}`} key={message.id}>
                <div className="message-bubble">
                  {!message.fromMe && <strong className="private-text">{message.sender}</strong>}
                  <p className="private-text">{message.text}</p>
                  <span>{message.at}</span>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-chat">
              <MessagesSquare size={42} />
              <h3>No chat loaded yet</h3>
              <p>Select a chat or reload the thread.</p>
            </div>
          )}
        </div>

        {props.botWait && (
          <div className="waiting-reply-card">
            <div>
              <span className="eyebrow">Waiting before replying</span>
              <strong>Checking again in {props.botWait.secondsLeft}s</strong>
              <p className="private-text">The latest message is fresh, so the bot is waiting in case they keep texting.</p>
            </div>
            <button className="secondary-button" onClick={props.onSkipWait} disabled={props.busy === "bot-check" || props.busy === "bot-send"}>
              <ChevronRight size={16} />
              Skip waiting time
            </button>
          </div>
        )}

        {props.pendingBotSend && (
          <div className="pending-send-card">
            <div>
              <span className="eyebrow">Bot is about to send</span>
              <strong>
                Sending {props.pendingBotSend.textParts.length > 1 ? `${props.pendingBotSend.textParts.length} messages` : "message"} in{" "}
                {props.pendingBotSend.secondsLeft}s
              </strong>
              {props.pendingBotSend.textParts.map((part, index) => (
                <p className="private-text" key={`${index}-${part.slice(0, 24)}`}>
                  {part}
                </p>
              ))}
            </div>
            <div className="pending-actions">
              <button className="secondary-button" onClick={props.onCancelPending} disabled={props.busy === "bot-cancel" || props.busy === "bot-send"}>
                <X size={16} />
                Cancel
              </button>
              <button className="secondary-button" onClick={props.onRegeneratePending} disabled={props.busy === "bot-check" || props.busy === "bot-send"}>
                <RefreshCw size={16} />
                Regenerate
              </button>
              <button className="primary-button" onClick={() => props.onSendPendingNow()} disabled={props.busy === "bot-send"}>
                <Send size={16} />
                Send now
              </button>
            </div>
          </div>
        )}

        {props.needsInputPrompt && (
          <div className="held-review-backdrop" role="dialog" aria-modal="true">
            <div className="held-review-modal needs-input-modal">
              <div className="panel-title-row compact-title">
                <div>
                  <span className="eyebrow">Bot needs your answer</span>
                  <h3 className="subheading">Add the missing detail</h3>
                </div>
              </div>
              <p className="review-reason private-text">{props.needsInputPrompt.question}</p>
              <label className="field-block">
                <span>Your answer</span>
                <textarea
                  className="private-field"
                  value={props.needsInputAnswer}
                  onChange={(event) => props.setNeedsInputAnswer(event.target.value)}
                  placeholder="Example: Share my Discord @mark..."
                  rows={4}
                  autoFocus
                />
              </label>
              <div className="held-review-actions">
                <button className="secondary-button" onClick={props.onDismissNeedsInput} disabled={props.busy === "bot-check" || props.busy === "bot-send"}>
                  <X size={16} />
                  Don't reply
                </button>
                <button className="primary-button" onClick={props.onSubmitNeedsInput} disabled={props.busy === "bot-check" || !props.needsInputAnswer.trim()}>
                  <RefreshCw size={16} />
                  Generate reply
                </button>
              </div>
            </div>
          </div>
        )}

        {props.heldBotReview && (
          <div className="held-review-backdrop" role="dialog" aria-modal="true">
            <div className="held-review-modal">
              <div className="panel-title-row compact-title">
                <div>
                  <span className="eyebrow">Bot held this reply</span>
                  <h3 className="subheading">Review before sending</h3>
                </div>
                {props.heldBotReview.draft && <RiskBadge risk={props.heldBotReview.draft.riskLevel} />}
              </div>
              <p className="review-reason">{props.heldBotReview.reason}</p>
              <label className="field-block">
                <span>Edit reply</span>
                <textarea
                  className="private-field"
                  value={props.heldReviewText}
                  onChange={(event) => props.setHeldReviewText(event.target.value)}
                  rows={6}
                />
              </label>
              <div className="held-review-actions">
                <button className="secondary-button" onClick={props.onDenyHeldReview} disabled={props.busy === "bot-cancel" || props.busy === "bot-send"}>
                  <X size={16} />
                  Deny
                </button>
                <button className="primary-button" onClick={props.onApproveHeldReview} disabled={props.busy === "bot-send" || !props.heldReviewText.trim()}>
                  <Send size={16} />
                  Approve and send
                </button>
              </div>
            </div>
          </div>
        )}

        {props.draft && (
          <div className="draft-reply-card">
            <div className="panel-title-row compact-title">
              <div>
                <span className="eyebrow">AI suggested reply</span>
                <h3 className="subheading">Review before sending</h3>
              </div>
              <RiskBadge risk={props.draft.riskLevel} />
            </div>
            <div className="draft-meta">
              <span>{props.draft.provider}</span>
              <span>{props.draft.model}</span>
              <span>{Math.round(props.draft.confidence * 100)}% confidence</span>
            </div>
            <label className="field-block">
              <span>Edit suggested reply</span>
              <textarea className="private-field" value={props.finalText} onChange={(event) => props.setFinalText(event.target.value)} rows={5} />
            </label>
            <div className="eligibility-box">
              <ShieldCheck size={18} />
              <p>{props.draft.sendEligibility.explanation}</p>
            </div>
            <div className={`send-intent ${dryRun ? "dry" : "live"}`}>
              <strong>{dryRun ? "Dry run only" : `Real ${platformLabel} send armed`}</strong>
              <span>{dryRun ? "Use Enable live send if you want this button to send the message." : "Review the text, then press send to hand it to the live channel."}</span>
            </div>
            <div className="reason-cloud">
              {props.draft.reasonCodes.map((reason) => (
                <span key={reason}>{reason.replaceAll("_", " ")}</span>
              ))}
            </div>
            {props.draft.memoryUpdates.length > 0 && (
              <div className="memory-updates">
                <strong>Memory updates</strong>
                {props.draft.memoryUpdates.map((item) => (
                  <p key={`${item.kind}-${item.value}`}>
                    <span className="private-text">{item.kind}: {item.value}</span>
                  </p>
                ))}
              </div>
            )}
            <button className="send-button" disabled={props.busy === "send" || !props.finalText.trim()} onClick={props.onSend}>
              <Send size={17} />
              {sendButtonLabel}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function ContactsPanel(props: {
  contacts: Contact[];
  contactDraft: Contact;
  setContactDraft: (contact: Contact) => void;
  onSave: (contact: Contact) => void;
  onEdit: (contact: Contact) => void;
  onDelete: (id: string) => void;
}) {
  const contact = props.contactDraft;
  return (
    <div className="two-column-page">
      <section className="editor-panel">
        <div className="panel-title-row">
          <div>
            <span className="eyebrow">People</span>
            <h2 className={contact.displayName ? "private-text" : ""}>{contact.displayName ? "Edit contact" : "Add contact"}</h2>
          </div>
          <button className="icon-button" onClick={() => props.setContactDraft(blankContact())} title="New contact">
            <Plus size={18} />
          </button>
        </div>
        <label className="field-block">
          <span>Name</span>
          <input className="private-field" value={contact.displayName} onChange={(event) => props.setContactDraft({ ...contact, displayName: event.target.value })} />
        </label>
        <div className="split-fields compact">
          <label className="field-block">
            <span>Platform</span>
            <select value={contact.platform} onChange={(event) => props.setContactDraft({ ...contact, platform: event.target.value as Platform })}>
              <option value="imessage">iMessage</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="manual">Manual draft</option>
            </select>
          </label>
          <label className="field-block">
            <span>Handle</span>
            <input
              className="private-field"
              value={contact.handle}
              onChange={(event) => props.setContactDraft({ ...contact, handle: event.target.value })}
              placeholder="Phone, Apple ID, or WhatsApp number"
            />
          </label>
        </div>
        <label className="field-block">
          <span>Relationship</span>
          <input className="private-field" value={contact.relationship} onChange={(event) => props.setContactDraft({ ...contact, relationship: event.target.value })} />
        </label>
        <label className="field-block">
          <span>Notes</span>
          <textarea className="private-field" value={contact.notes} onChange={(event) => props.setContactDraft({ ...contact, notes: event.target.value })} rows={8} />
        </label>
        <div className="toggle-grid">
          <Toggle
            label="Allow limited autopilot"
            checked={contact.allowAutopilot}
            onChange={(checked) => props.setContactDraft({ ...contact, allowAutopilot: checked })}
          />
          <Toggle label="Recipient opted out" checked={contact.optedOut} onChange={(checked) => props.setContactDraft({ ...contact, optedOut: checked })} />
        </div>
        <button className="primary-button full" onClick={() => props.onSave(contact)} disabled={!contact.displayName.trim()}>
          <Save size={16} />
          Save contact
        </button>
      </section>

      <section className="list-panel">
        <div className="section-heading">
          <span>Saved contacts</span>
          <strong>{props.contacts.length}</strong>
        </div>
        {props.contacts.map((item) => (
          <div className="saved-contact" key={item.id}>
            <span className="avatar private-avatar">{initials(item.displayName)}</span>
            <div>
              <strong className="private-text">{item.displayName || "Unnamed"}</strong>
              <small className="private-text">{item.platform} {item.handle ? `- ${item.handle}` : ""}</small>
              <p className="private-text">{item.notes || "No notes yet."}</p>
            </div>
            <button className="icon-button" onClick={() => props.onEdit(item)} title="Edit contact">
              <Settings size={17} />
            </button>
            <button className="icon-button danger" onClick={() => props.onDelete(item.id)} title="Delete contact">
              <Trash2 size={17} />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}

function SettingsPanel(props: {
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  permissionReport: MacPermissionReport | null;
  whatsappStatus: WhatsAppBridgeStatus | null;
  busy: string | null;
  onSave: () => void;
  onTest: () => void;
  onCheckPermissions: () => void;
  onCheckWhatsApp: () => void;
  onStartWhatsApp: () => void;
  onOpenPermissions: () => void;
  onReveal: () => void;
}) {
  return (
    <div className="settings-page">
      <section className="editor-panel wide">
        <div className="panel-title-row">
          <div>
            <span className="eyebrow">Model routing</span>
            <h2>AI settings</h2>
          </div>
          <KeyRound size={26} />
        </div>
        <ProviderSettings settings={props.settings} updateSettings={props.updateSettings} compact />
        <div className="divider" />
        <label className="field-block">
          <span>General prompt</span>
          <textarea
            className="private-field"
            value={props.settings.globalUserContext}
            onChange={(event) => props.updateSettings({ globalUserContext: event.target.value })}
            rows={6}
            placeholder="Name, background, personal facts, links, and standing style rules for every reply."
          />
        </label>
        <div className="setting-note">
          Sent to the model for every generated message. Per-chat relationship memory and optional instructions still stay with each conversation.
        </div>
        <div className="divider" />
        <div className="split-fields compact">
          <Toggle
            label="Dark mode"
            checked={props.settings.darkModeEnabled}
            onChange={(checked) => props.updateSettings({ darkModeEnabled: checked })}
          />
          <Toggle
            label="Blur private details"
            checked={props.settings.privacyBlurEnabled}
            onChange={(checked) => props.updateSettings({ privacyBlurEnabled: checked })}
          />
        </div>
        <div className="setting-note">
          Dark mode changes the whole app. Screen-share mode blurs names, handles, message text, and logs while keeping controls usable.
        </div>
        <div className="divider" />
        <div className="split-fields compact">
          <Toggle
            label="iMessage dry run"
            checked={props.settings.iMessageDryRun}
            onChange={(checked) => props.updateSettings({ iMessageDryRun: checked })}
          />
          <Toggle
            label="WhatsApp dry run"
            checked={props.settings.whatsappDryRun}
            onChange={(checked) => props.updateSettings({ whatsappDryRun: checked })}
          />
        </div>
        <div className="split-fields compact">
          <label className="field-block">
            <span>Permission mode</span>
            <select
              value={props.settings.permissionMode}
              onChange={(event) => {
                const permissionMode = event.target.value as PermissionMode;
                props.updateSettings({
                  permissionMode,
                  requireHumanApproval: permissionMode === "extra_safe"
                });
              }}
            >
              {permissionModeOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <Toggle
            label="Autopilot enabled"
            checked={props.settings.autopilotEnabled}
            onChange={(checked) => props.updateSettings({ autopilotEnabled: checked })}
          />
        </div>
        <div className="setting-note">
          {permissionModeOptions.find((option) => option.value === props.settings.permissionMode)?.description}
        </div>
        <div className="split-fields compact">
          <label className="field-block">
            <span>Autopilot interval minutes</span>
            <input
              type="number"
              min={2}
              max={240}
              value={props.settings.autopilotIntervalMinutes}
              onChange={(event) => props.updateSettings({ autopilotIntervalMinutes: Number(event.target.value) })}
            />
          </label>
          <label className="field-block">
            <span>Max auto sends per run</span>
            <input
              type="number"
              min={1}
              max={20}
              value={props.settings.maxAutoSendsPerRun}
              onChange={(event) => props.updateSettings({ maxAutoSendsPerRun: Number(event.target.value) })}
            />
          </label>
        </div>
        <div className="split-fields compact">
          <Toggle
            label="Append disclosure"
            checked={props.settings.appendDisclosure}
            onChange={(checked) => props.updateSettings({ appendDisclosure: checked })}
          />
          <div className="setting-note">
            Autopilot only scans saved iMessage or WhatsApp chats with per-chat autopilot enabled. Dry run keeps it from sending while you test.
          </div>
        </div>
        <label className="field-block">
          <span>Disclosure text</span>
          <input
            value={props.settings.disclosureText}
            onChange={(event) => props.updateSettings({ disclosureText: event.target.value })}
          />
        </label>
        <div className="divider" />
        <div className="panel-title-row compact-title">
          <div>
            <span className="eyebrow">Mac access</span>
            <h3 className="subheading">iMessage readiness</h3>
          </div>
          <button className="secondary-button" onClick={props.onCheckPermissions} disabled={props.busy === "permissions"}>
            <ShieldCheck size={16} />
            {props.busy === "permissions" ? "Checking" : "Check access"}
          </button>
          <button className="secondary-button" onClick={props.onOpenPermissions}>
            <ShieldCheck size={16} />
            Full Disk Access
          </button>
        </div>
        <div className="permission-grid">
          {(["messagesDatabase", "contactsDatabase", "messagesAutomation"] as const).map((key) => {
            const item = props.permissionReport?.[key];
            return (
              <div className={`permission-row ${item?.ok ? "ok" : "warn"}`} key={key}>
                <strong>{item?.label || permissionFallbackLabel(key)}</strong>
                <span>{item?.detail || "Not checked yet."}</span>
              </div>
            );
          })}
        </div>
        <div className="divider" />
        <div className="panel-title-row compact-title">
          <div>
            <span className="eyebrow">WhatsApp</span>
            <h3 className="subheading">Personal bridge</h3>
          </div>
          <div className="button-cluster">
            <button className="secondary-button" onClick={props.onStartWhatsApp} disabled={props.busy === "whatsapp-start"}>
              <Bot size={16} />
              {props.busy === "whatsapp-start" ? "Setting up" : "Start bridge"}
            </button>
            <button className="secondary-button" onClick={props.onCheckWhatsApp} disabled={props.busy === "whatsapp"}>
              <ShieldCheck size={16} />
              {props.busy === "whatsapp" ? "Checking" : "Check bridge"}
            </button>
          </div>
        </div>
        <div className={`permission-row ${props.whatsappStatus?.ok ? "ok" : "warn"}`}>
          <strong>{props.whatsappStatus?.message || "WhatsApp bridge not checked yet."}</strong>
          <span>
            {props.whatsappStatus?.detail ||
              "Run the maintained whatsmeow bridge, scan the QR code, then set the bridge URL, token, and messages DB path here."}
          </span>
        </div>
        <div className="split-fields compact">
          <label className="field-block">
            <span>Bridge API URL</span>
            <input
              value={props.settings.whatsappBridgeUrl}
              onChange={(event) => props.updateSettings({ whatsappBridgeUrl: event.target.value })}
              placeholder="http://127.0.0.1:8080/api"
            />
          </label>
          <label className="field-block">
            <span>Bridge token</span>
            <input
              type="password"
              value={props.settings.whatsappBridgeToken}
              onChange={(event) => props.updateSettings({ whatsappBridgeToken: event.target.value })}
              placeholder="Stored in whatsapp-bridge/store/.bridge-token"
            />
          </label>
        </div>
        <label className="field-block">
          <span>Messages DB path</span>
          <input
            value={props.settings.whatsappMessagesDbPath}
            onChange={(event) => props.updateSettings({ whatsappMessagesDbPath: event.target.value })}
            placeholder="~/path/to/whatsapp-mcp/whatsapp-bridge/store/messages.db"
          />
        </label>
        <div className="split-fields compact">
          <label className="field-block">
            <span>WhatsApp connector</span>
            <select
              value={props.settings.whatsappProvider}
              onChange={(event) => props.updateSettings({ whatsappProvider: event.target.value as AppSettings["whatsappProvider"] })}
            >
              <option value="personal_bridge">Personal bridge</option>
              <option value="business_cloud">Business Cloud API</option>
            </select>
          </label>
          <div className="setting-note">
            Personal bridge is the default for your own WhatsApp account. Business Cloud remains available for official business numbers.
          </div>
        </div>
        <div className="divider" />
        <h3 className="subheading">WhatsApp Business Cloud API</h3>
        <div className="split-fields compact">
          <label className="field-block">
            <span>Access token</span>
            <input
              type="password"
              value={props.settings.whatsappAccessToken}
              onChange={(event) => props.updateSettings({ whatsappAccessToken: event.target.value })}
              placeholder="Meta permanent or temporary access token"
            />
          </label>
          <label className="field-block">
            <span>Phone number ID</span>
            <input
              value={props.settings.whatsappPhoneNumberId}
              onChange={(event) => props.updateSettings({ whatsappPhoneNumberId: event.target.value })}
            />
          </label>
        </div>
        <label className="field-block narrow-field">
          <span>Graph API version</span>
          <input
            value={props.settings.whatsappGraphVersion}
            onChange={(event) => props.updateSettings({ whatsappGraphVersion: event.target.value })}
          />
        </label>
        <div className="action-row">
          <button className="secondary-button" onClick={props.onTest} disabled={props.busy === "provider"}>
            <Cpu size={16} />
            Test provider
          </button>
          <button className="secondary-button" onClick={props.onReveal}>
            <ClipboardList size={16} />
            Data folder
          </button>
          <button className="primary-button" onClick={props.onSave} disabled={props.busy === "settings"}>
            <Save size={16} />
            Save settings
          </button>
        </div>
      </section>
    </div>
  );
}

function ProviderSettings(props: { settings: AppSettings; updateSettings: (patch: Partial<AppSettings>) => void; compact: boolean }) {
  const settings = props.settings;
  const setProvider = (provider: AiProvider) => props.updateSettings({ aiProvider: provider });
  return (
    <div className={props.compact ? "provider-settings compact-provider" : "provider-settings"}>
      <div className="segmented">
        <button className={settings.aiProvider === "openai" ? "active" : ""} onClick={() => setProvider("openai")} type="button">
          OpenAI
        </button>
        <button className={settings.aiProvider === "ollama" ? "active" : ""} onClick={() => setProvider("ollama")} type="button">
          Ollama
        </button>
        <button className={settings.aiProvider === "local-openai" ? "active" : ""} onClick={() => setProvider("local-openai")} type="button">
          Local API
        </button>
      </div>

      {settings.aiProvider === "openai" && (
        <>
          <label className="field-block">
            <span>OpenAI API key</span>
            <input
              type="password"
              value={settings.openAiApiKey}
              onChange={(event) => props.updateSettings({ openAiApiKey: event.target.value })}
              placeholder="sk-..."
            />
          </label>
          <label className="field-block">
            <span>Model</span>
            <input
              list="openai-models"
              value={settings.openAiModel}
              onChange={(event) => props.updateSettings({ openAiModel: event.target.value })}
            />
            <datalist id="openai-models">
              {suggestedOpenAiModels.map((model) => (
                <option value={model} key={model} />
              ))}
            </datalist>
          </label>
        </>
      )}

      {settings.aiProvider === "ollama" && (
        <>
          <label className="field-block">
            <span>Ollama base URL</span>
            <input value={settings.localBaseUrl} onChange={(event) => props.updateSettings({ localBaseUrl: event.target.value })} />
          </label>
          <label className="field-block">
            <span>Local model</span>
            <input list="local-models" value={settings.localModel} onChange={(event) => props.updateSettings({ localModel: event.target.value })} />
          </label>
        </>
      )}

      {settings.aiProvider === "local-openai" && (
        <>
          <label className="field-block">
            <span>OpenAI-compatible base URL</span>
            <input
              value={settings.localOpenAiBaseUrl}
              onChange={(event) => props.updateSettings({ localOpenAiBaseUrl: event.target.value })}
            />
          </label>
          <label className="field-block">
            <span>Local model</span>
            <input
              list="local-models"
              value={settings.localOpenAiModel}
              onChange={(event) => props.updateSettings({ localOpenAiModel: event.target.value })}
            />
          </label>
        </>
      )}
      <datalist id="local-models">
        {suggestedLocalModels.map((model) => (
          <option value={model} key={model} />
        ))}
      </datalist>
    </div>
  );
}

function AuditPanel({ state }: { state: AppState }) {
  return (
    <div className="audit-page">
      <section className="list-panel full-height">
        <div className="panel-title-row">
          <div>
            <span className="eyebrow">Trace</span>
            <h2>Audit trail</h2>
          </div>
          <ClipboardList size={26} />
        </div>
        {state.audits.map((event) => (
          <div className="audit-row" key={event.id}>
            <span>{new Date(event.at).toLocaleString()}</span>
            <strong className="private-text">{event.summary}</strong>
            {event.detail && <p className="private-text">{event.detail}</p>}
          </div>
        ))}
      </section>
    </div>
  );
}

function NavButton(props: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={`nav-button ${props.active ? "active" : ""}`} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span />
      <strong>{props.label}</strong>
    </label>
  );
}

function StatusBar({ error, notice }: { error: string; notice: string }) {
  if (!error && !notice) return null;
  return (
    <div className={`status-bar ${error ? "error" : "notice"}`}>
      {error ? <AlertTriangle size={17} /> : <Check size={17} />}
      <span className="private-text">{error || notice}</span>
    </div>
  );
}

function RiskBadge({ risk }: { risk: string }) {
  return <div className={`risk-badge ${risk}`}>{risk}</div>;
}

function initials(name: string) {
  return (name || "AI")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function formatShortTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function friendlyAuditSummary(event: AuditEvent) {
  return event.summary
    .replace("Autopilot", "Bot")
    .replace("iMessage send command completed", "Message sent");
}

function friendlyAuditDetail(detail: string) {
  if (detail.length > 160) return `${detail.slice(0, 157)}...`;
  return detail;
}

function providerLabel(settings: AppSettings) {
  if (settings.aiProvider === "openai") return "OpenAI";
  if (settings.aiProvider === "ollama") return "Ollama";
  return "Local API";
}

function selectedModelLabel(settings: AppSettings) {
  if (settings.aiProvider === "openai") return settings.openAiModel;
  if (settings.aiProvider === "ollama") return settings.localModel;
  return settings.localOpenAiModel;
}

function permissionFallbackLabel(key: keyof MacPermissionReport) {
  if (key === "messagesDatabase") return "Messages database";
  if (key === "contactsDatabase") return "Contacts database";
  return "Messages automation";
}

export default App;
