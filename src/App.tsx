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
import type {
  AiProvider,
  AppSettings,
  AppState,
  AuditEvent,
  Contact,
  DraftResult,
  IMessageChat,
  MacPermissionReport,
  Platform,
  PreparedAutopilotReply,
  ProviderTestResult,
  SendMessageResult
} from "./shared";
import { defaultSettings, suggestedLocalModels, suggestedOpenAiModels } from "./shared";

type View = "workbench" | "contacts" | "settings" | "audit";

type ChatBubble = {
  id: string;
  at: string;
  sender: string;
  text: string;
  fromMe: boolean;
};

type PendingBotSend = {
  contact: Contact;
  inboundHash: string;
  text: string;
  draft?: DraftResult;
  secondsLeft: number;
};

const blankContact = (): Contact => ({
  id: crypto.randomUUID(),
  displayName: "",
  platform: "imessage",
  handle: "",
  relationship: "",
  notes: "",
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
    allowAutopilot: existing?.allowAutopilot ?? false,
    optedOut: existing?.optedOut ?? false,
    lastImportedAt: existing?.lastImportedAt,
    lastAutopilotAt: existing?.lastAutopilotAt,
    lastAutopilotInboundHash: existing?.lastAutopilotInboundHash
  };
}

function latestInboundFromTranscript(transcript: string, handle?: string) {
  const lines = transcript
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedHandle = handle?.toLowerCase().trim();
  return (
    [...lines].reverse().find((line) => {
      const lower = line.toLowerCase();
      if (lower.includes(" me:")) return false;
      if (!normalizedHandle) return true;
      return lower.includes(`${normalizedHandle}:`) || !lower.includes(" me:");
    }) ?? ""
  );
}

function chatBubblesFromTranscript(transcript: string): ChatBubble[] {
  return transcript
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const match = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+([^:]+):\s*(.*)$/);
      if (!match) {
        return {
          id: `${index}-${line.slice(0, 24)}`,
          at: "",
          sender: "Message",
          text: line,
          fromMe: false
        };
      }
      const sender = match[2].trim();
      return {
        id: `${index}-${match[1]}`,
        at: match[1],
        sender,
        text: match[3].trim() || "[No text content]",
        fromMe: sender.toLowerCase() === "me"
      };
    });
}

function contactMatches(candidate: Contact, target: Contact) {
  return (
    (!!candidate.chatId && candidate.chatId === target.chatId) ||
    (!!candidate.chatGuid && candidate.chatGuid === target.chatGuid) ||
    candidate.id === target.id
  );
}

function botIsRunningForContact(state: AppState, contact?: Contact) {
  if (!contact || contact.platform !== "imessage") return false;
  const managed = state.contacts.find((item) => contactMatches(item, contact));
  return Boolean(managed?.allowAutopilot && !managed.optedOut && !state.settings.iMessageDryRun && !state.settings.requireHumanApproval);
}

function appendDisclosureToText(settings: AppSettings, rawText: string) {
  const text = rawText.trim();
  const disclosure = settings.appendDisclosure ? settings.disclosureText.trim() : "";
  if (!disclosure || text.endsWith(disclosure)) return text;
  return `${text}\n\n${disclosure}`;
}

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
  const [selectedContactId, setSelectedContactId] = useState<string>("");
  const [imessageChats, setIMessageChats] = useState<IMessageChat[]>([]);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [chatSearch, setChatSearch] = useState("");
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(defaultSettings);
  const [contactDraft, setContactDraft] = useState<Contact>(blankContact());
  const [currentMessage, setCurrentMessage] = useState("");
  const [conversationContext, setConversationContext] = useState("");
  const [relationshipMemory, setRelationshipMemory] = useState("");
  const [userInstruction, setUserInstruction] = useState("");
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [finalText, setFinalText] = useState("");
  const [pendingBotSend, setPendingBotSend] = useState<PendingBotSend | null>(null);
  const [permissionReport, setPermissionReport] = useState<MacPermissionReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [error, setError] = useState<string>("");
  const botCheckInFlight = useRef(false);
  const pendingSendInFlight = useRef(false);

  const openFullDiskAccessSettings = () => window.socializeAI.openFullDiskAccessSettings();
  const updateSettingsDraft = (patch: Partial<AppSettings>) => setSettingsDraft((current) => ({ ...current, ...patch }));

  useEffect(() => {
    window.socializeAI
      .getState()
      .then((loaded) => {
        setState(loaded);
        setSettingsDraft(loaded.settings);
        setSelectedContactId(loaded.contacts[0]?.id ?? "");
        if (loaded.settings.hasCompletedOnboarding) void refreshIMessageChats(false);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const selectedContact = useMemo(
    () => state?.contacts.find((contact) => contact.id === selectedContactId) ?? state?.contacts[0],
    [state, selectedContactId]
  );

  const selectedChat = useMemo(
    () => imessageChats.find((chat) => chat.chatId === selectedChatId) ?? imessageChats[0],
    [imessageChats, selectedChatId]
  );

  const activeContact = useMemo(() => {
    if (!state) return undefined;
    if (selectedChat) {
      const managed = state.contacts.find((contact) => contact.chatId === selectedChat.chatId || contact.chatGuid === selectedChat.guid);
      return contactFromChat(selectedChat, managed);
    }
    return selectedContact;
  }, [selectedChat, selectedContact, state]);

  useEffect(() => {
    if (!activeContact?.chatId) return;
    setRelationshipMemory(activeContact.notes || "");
    setDraft(null);
    setFinalText("");
    setPendingBotSend(null);
    void loadThreadForContact(activeContact, false);
  }, [activeContact?.chatId]);

  useEffect(() => {
    if (!pendingBotSend) return;
    if (pendingBotSend.secondsLeft <= 0) {
      void sendPendingBotNow();
      return;
    }
    const timer = window.setTimeout(() => {
      setPendingBotSend((pending) => (pending ? { ...pending, secondsLeft: Math.max(0, pending.secondsLeft - 1) } : pending));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [pendingBotSend?.secondsLeft, pendingBotSend?.inboundHash]);

  useEffect(() => {
    if (!state || !activeContact?.chatId || !state.settings.hasCompletedOnboarding) return;
    const poll = window.setInterval(() => {
      void refreshActiveThreadAndBot(false);
    }, 5000);
    return () => window.clearInterval(poll);
  }, [state, activeContact?.chatId, pendingBotSend?.inboundHash]);

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
      await persist(
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
        enabled ? "Live WhatsApp sending is on for configured Business Cloud API sends." : "WhatsApp dry run is on. Sends will only be recorded."
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

  async function setHumanApprovalRequired(required: boolean) {
    if (!state) return;
    await saveOperationalSettings(
      { ...settingsDraft, requireHumanApproval: required },
      required ? "Require human approval enabled" : "Autopilot auto-send gate enabled",
      "Workbench autopilot control",
      required ? "Autopilot will hold drafts for review." : "Autopilot can auto-send only low-risk eligible drafts when live send is also on."
    );
  }

  async function prepareBotReplyForContact(contact: Contact, mode: "manual" | "poll" = "poll", regenerate = false) {
    if (botCheckInFlight.current || (pendingBotSend && !regenerate)) return;
    botCheckInFlight.current = true;
    if (mode === "manual") setBusy("bot-check");
    try {
      if (regenerate) setPendingBotSend(null);
      const result: PreparedAutopilotReply = await window.socializeAI.prepareAutopilotReply({ contact, regenerate });
      const saved = await window.socializeAI.getState();
      setState(saved);

      if (result.ok && result.status === "ready" && result.contact && result.inboundHash && result.draftText) {
        setPendingBotSend({
          contact: result.contact,
          inboundHash: result.inboundHash,
          text: result.draftText,
          draft: result.draft,
          secondsLeft: 10
        });
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

  async function sendPendingBotNow() {
    if (!pendingBotSend || pendingSendInFlight.current) return;
    pendingSendInFlight.current = true;
    setBusy("bot-send");
    setError("");
    try {
      await syncPendingSettings();
      const result = await window.socializeAI.sendPreparedAutopilotReply({
        contact: pendingBotSend.contact,
        inboundHash: pendingBotSend.inboundHash,
        text: pendingBotSend.text
      });
      const contactName = pendingBotSend.contact.displayName || "this chat";
      setPendingBotSend(null);
      if (result.ok) setNotice(result.dryRun ? `Dry run recorded for ${contactName}.` : `Bot sent a reply to ${contactName}.`);
      else setError(result.detail || result.message);
      const saved = await window.socializeAI.getState();
      setState(saved);
      setSettingsDraft(saved.settings);
      await loadThreadForContact(pendingBotSend.contact, false, true);
      void refreshIMessageChats(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pendingSendInFlight.current = false;
      setBusy(null);
    }
  }

  async function cancelPendingBotSend() {
    if (!pendingBotSend) return;
    setBusy("bot-cancel");
    try {
      const result = await window.socializeAI.cancelPreparedAutopilotReply({
        contact: pendingBotSend.contact,
        inboundHash: pendingBotSend.inboundHash,
        reason: "User cancelled from the conversation window."
      });
      setPendingBotSend(null);
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
    await prepareBotReplyForContact(pendingBotSend.contact, "manual", true);
  }

  async function refreshActiveThreadAndBot(showNotice = false) {
    if (!state || !activeContact?.chatId) return;
    await loadThreadForContact(activeContact, showNotice, !showNotice);
    if (botIsRunningForContact(state, activeContact) && !pendingBotSend) {
      await prepareBotReplyForContact(activeContact, "poll");
    }
  }

  async function startBotForSelectedChat() {
    if (!state || !activeContact) return;
    if (activeContact.platform !== "imessage" || !activeContact.chatId) {
      setError("Choose an iMessage chat first.");
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
      const existing = state.contacts.find(
        (contact) => contact.chatId === activeContact.chatId || contact.chatGuid === activeContact.chatGuid || contact.id === activeContact.id
      );
      const botContact: Contact = {
        ...activeContact,
        ...existing,
        displayName: activeContact.displayName || existing?.displayName || "iMessage chat",
        handle: activeContact.handle || existing?.handle || "",
        chatId: activeContact.chatId,
        chatGuid: activeContact.chatGuid || existing?.chatGuid,
        relationship: existing?.relationship || activeContact.relationship || "family/friend",
        notes: existing?.notes || activeContact.notes || "",
        allowAutopilot: true,
        optedOut: existing?.optedOut ?? activeContact.optedOut
      };
      const matchesSelected = (contact: Contact) =>
        contact.chatId === botContact.chatId || contact.chatGuid === botContact.chatGuid || contact.id === botContact.id;
      const contacts = [
        botContact,
        ...state.contacts.filter((contact) => !matchesSelected(contact)).map((contact) => ({ ...contact, allowAutopilot: false }))
      ];
      await persist(
        {
          ...state,
          settings: {
            ...settingsDraft,
            iMessageDryRun: false,
            requireHumanApproval: false,
            autopilotEnabled: false
          },
          contacts,
          audits: [
            audit(
              "settings_saved",
              `Started bot for ${botContact.displayName}`,
              "Live iMessage autopilot enabled for the selected chat only."
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
      await prepareBotReplyForContact(botContact, "manual");
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
        contact.chatId === activeContact.chatId || contact.chatGuid === activeContact.chatGuid || contact.id === activeContact.id
          ? { ...contact, allowAutopilot: false }
          : contact
      );
      const anyChatStillRunning = contacts.some((contact) => contact.allowAutopilot);
      if (pendingBotSend && contactMatches(pendingBotSend.contact, activeContact)) {
        setPendingBotSend(null);
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
      setError("Choose an iMessage chat first.");
      return;
    }
    setBusy("draft");
    setError("");
    setNotice("");
    try {
      await syncPendingSettings();
      let context = conversationContext;
      let latest = currentMessage;
      if (activeContact.platform === "imessage" && activeContact.chatId) {
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
      setFinalText(appendDisclosureToText(settingsDraft, result.draftText));
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
    }
    try {
      const result = await window.socializeAI.importIMessageHistory({
        handle: contact.handle,
        chatId: contact.chatId,
        limit: 80
      });
      if (result.ok) {
        const latest = latestInboundFromTranscript(result.messages, contact.handle);
        setConversationContext(result.messages);
        setCurrentMessage(latest);
        if (showNotice) setNotice(result.message);
        return { context: result.messages, latest };
      } else {
        if (!silent) setError(`${result.message}${result.detail ? ` ${result.detail}` : ""}`);
      }
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setBusy(null);
    }
    return { context: conversationContext, latest: currentMessage };
  }

  async function saveContact(contact: Contact) {
    if (!state) return;
    const isExisting = state.contacts.some((item) => item.id === contact.id);
    const contacts = isExisting ? state.contacts.map((item) => (item.id === contact.id ? contact : item)) : [contact, ...state.contacts];
    await persist(
      {
        ...state,
        contacts,
        audits: [
          audit("contact_saved", `Saved ${contact.displayName || "contact"}`, `${contact.platform}: ${contact.handle}`),
          ...state.audits
        ].slice(0, 500)
      },
      "Contact saved.",
      false
    );
    setContactDraft(blankContact());
    setSelectedContactId(contact.id);
  }

  async function manageSelectedChatForAutopilot() {
    if (!selectedChat || !state) return;
    const existing = state.contacts.find((contact) => contact.chatId === selectedChat.chatId || contact.chatGuid === selectedChat.guid);
    const contact = contactFromChat(selectedChat, existing);
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
            selectedContact={activeContact}
            imessageChats={imessageChats}
            selectedChatId={selectedChatId}
            setSelectedChatId={setSelectedChatId}
            chatSearch={chatSearch}
            setChatSearch={setChatSearch}
            currentMessage={currentMessage}
            setCurrentMessage={setCurrentMessage}
            conversationContext={conversationContext}
            setConversationContext={setConversationContext}
            relationshipMemory={relationshipMemory}
            setRelationshipMemory={setRelationshipMemory}
            userInstruction={userInstruction}
            setUserInstruction={setUserInstruction}
            draft={draft}
            finalText={finalText}
            setFinalText={setFinalText}
            pendingBotSend={pendingBotSend}
            busy={busy}
            onSend={sendMessage}
            onImport={importHistory}
            onRefreshChats={() => refreshIMessageChats()}
            onRefreshThread={() => refreshActiveThreadAndBot(true)}
            onManageChat={manageSelectedChatForAutopilot}
            onRunAutopilot={runAutopilotOnce}
            onSetLiveSend={setLiveSendForSelected}
            onSetAutopilotSchedule={setAutopilotSchedule}
            onSetHumanApprovalRequired={setHumanApprovalRequired}
            onStartBot={startBotForSelectedChat}
            onStopBot={stopBotForSelectedChat}
            onSendPendingNow={sendPendingBotNow}
            onCancelPending={cancelPendingBotSend}
            onRegeneratePending={regeneratePendingBotSend}
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
            busy={busy}
            onSave={saveSettings}
            onTest={() => testProvider(settingsDraft)}
            onCheckPermissions={checkMacPermissions}
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
  selectedContact?: Contact;
  imessageChats: IMessageChat[];
  selectedChatId: string;
  setSelectedChatId: (id: string) => void;
  chatSearch: string;
  setChatSearch: (value: string) => void;
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
  pendingBotSend: PendingBotSend | null;
  busy: string | null;
  onSend: () => void;
  onImport: () => void;
  onRefreshChats: () => void;
  onRefreshThread: () => void;
  onManageChat: () => void;
  onRunAutopilot: () => void;
  onSetLiveSend: (enabled: boolean) => void;
  onSetAutopilotSchedule: (enabled: boolean) => void;
  onSetHumanApprovalRequired: (required: boolean) => void;
  onStartBot: () => void;
  onStopBot: () => void;
  onSendPendingNow: () => void;
  onCancelPending: () => void;
  onRegeneratePending: () => void;
}) {
  const selected = props.selectedContact;
  const selectedChat = props.imessageChats.find((chat) => chat.chatId === props.selectedChatId) ?? props.imessageChats[0];
  const managed = selected ? props.state.contacts.find((contact) => contact.chatId === selected.chatId || contact.id === selected.id) : undefined;
  const dryRun =
    selected?.platform === "whatsapp"
      ? props.state.settings.whatsappDryRun
      : selected?.platform === "imessage"
        ? props.state.settings.iMessageDryRun
        : true;
  const loadedCount = props.conversationContext.split("\n").filter(Boolean).length;
  const platformLabel = selected?.platform === "imessage" ? "iMessage" : selected?.platform === "whatsapp" ? "WhatsApp" : "manual";
  const botRunning = botIsRunningForContact(props.state, selected);
  const participantLine =
    selectedChat?.participantNames?.slice(0, 4).join(", ") ||
    selectedChat?.participantHandles.slice(0, 4).join(", ") ||
    selectedChat?.serviceName ||
    selected?.handle ||
    "";
  const query = props.chatSearch.trim().toLowerCase();
  const visibleChats = query
    ? props.imessageChats.filter((chat) => {
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
    : props.imessageChats;
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
          <span>iMessage chats</span>
          <strong>{query ? `${visibleChats.length}/${props.imessageChats.length}` : props.imessageChats.length}</strong>
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
          {props.busy === "chats" ? "Loading" : "Refresh chats"}
        </button>
        <div className="contact-list chat-list">
          {props.imessageChats.length === 0 && (
            <div className="empty-list">
              <p>No iMessage chats loaded yet.</p>
              <small>Grant Full Disk Access to the app if refresh fails.</small>
            </div>
          )}
          {props.imessageChats.length > 0 && visibleChats.length === 0 && (
            <div className="empty-list">
              <p>No matches.</p>
              <small>Try a name, phone number, group, or recent message text.</small>
            </div>
          )}
          {visibleChats.map((chat) => (
            <button
              className={`contact-row ${props.selectedChatId === chat.chatId ? "active" : ""}`}
              key={chat.chatId}
              onClick={() => props.setSelectedChatId(chat.chatId)}
            >
              <span className="avatar private-avatar">{initials(chat.displayName || chat.chatIdentifier || "IM")}</span>
              <span>
                <strong className="private-text">{chat.displayName || chat.chatIdentifier || "Unnamed chat"}</strong>
                <small className="private-text">
                  {chat.contactName && !chat.isGroup ? `${chat.chatIdentifier} - ` : ""}
                  {chat.isGroup ? "group" : "iMessage"} {chat.lastMessageAt ? `- ${chat.lastMessageAt}` : ""}
                </small>
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="composer-panel">
        <div className="panel-title-row">
          <div>
            <span className="eyebrow">Selected iMessage thread</span>
            <h2 className="private-text">{selected?.displayName || selectedChat?.displayName || "Choose an iMessage chat"}</h2>
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
                ? "SocializeAI is watching this selected iMessage thread and can send live low-risk replies automatically."
                : "Start bot turns on live iMessage replies for this selected thread only, then checks the latest message."}
            </p>
          </div>
          <button
            className={botRunning ? "secondary-button stop-bot-button" : "primary-button start-bot-button"}
            onClick={botRunning ? props.onStopBot : props.onStartBot}
            disabled={!selectedChat || selected?.platform !== "imessage" || props.busy === "bot"}
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
          <button className="icon-button" disabled={!selected || selected.platform !== "imessage" || props.busy === "import"} onClick={props.onRefreshThread} title="Reload chat">
            <RefreshCw size={17} />
          </button>
        </div>

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

        {props.pendingBotSend && (
          <div className="pending-send-card">
            <div>
              <span className="eyebrow">Bot is about to send</span>
              <strong>Sending in {props.pendingBotSend.secondsLeft}s</strong>
              <p className="private-text">{props.pendingBotSend.text}</p>
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
              <button className="primary-button" onClick={props.onSendPendingNow} disabled={props.busy === "bot-send"}>
                <Send size={16} />
                Send now
              </button>
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
              <option value="whatsapp">WhatsApp Business</option>
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
  busy: string | null;
  onSave: () => void;
  onTest: () => void;
  onCheckPermissions: () => void;
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
        <div className="split-fields compact">
          <Toggle
            label="Blur private details"
            checked={props.settings.privacyBlurEnabled}
            onChange={(checked) => props.updateSettings({ privacyBlurEnabled: checked })}
          />
          <div className="setting-note">
            Screen-share mode blurs names, handles, message text, and logs while keeping controls usable.
          </div>
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
          <Toggle
            label="Require human approval"
            checked={props.settings.requireHumanApproval}
            onChange={(checked) => props.updateSettings({ requireHumanApproval: checked })}
          />
          <Toggle
            label="Autopilot enabled"
            checked={props.settings.autopilotEnabled}
            onChange={(checked) => props.updateSettings({ autopilotEnabled: checked })}
          />
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
            Autopilot only scans saved iMessage chats with per-chat autopilot enabled. Dry run keeps it from sending while you test.
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
