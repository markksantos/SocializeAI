import { contextBridge, ipcRenderer } from "electron";

const api = {
  getState: () => ipcRenderer.invoke("state:get"),
  saveState: (state: unknown) => ipcRenderer.invoke("state:save", state),
  completeOnboarding: (settings: unknown) => ipcRenderer.invoke("onboarding:complete", settings),
  generateDraft: (request: unknown) => ipcRenderer.invoke("draft:generate", request),
  testProvider: (settings: unknown) => ipcRenderer.invoke("provider:test", settings),
  sendMessage: (request: unknown) => ipcRenderer.invoke("message:send", request),
  listIMessageChats: () => ipcRenderer.invoke("imessage:list-chats"),
  importIMessageHistory: (request: unknown) => ipcRenderer.invoke("imessage:import-history", request),
  getWhatsAppBridgeStatus: (settings?: unknown) => ipcRenderer.invoke("whatsapp:bridge-status", settings),
  startWhatsAppBridge: (settings?: unknown) => ipcRenderer.invoke("whatsapp:start-bridge", settings),
  listWhatsAppChats: () => ipcRenderer.invoke("whatsapp:list-chats"),
  importWhatsAppHistory: (request: unknown) => ipcRenderer.invoke("whatsapp:import-history", request),
  runAutopilotOnce: () => ipcRenderer.invoke("autopilot:run-once"),
  prepareAutopilotReply: (contact: unknown) => ipcRenderer.invoke("autopilot:prepare-reply", contact),
  sendPreparedAutopilotReply: (request: unknown) => ipcRenderer.invoke("autopilot:send-prepared", request),
  cancelPreparedAutopilotReply: (request: unknown) => ipcRenderer.invoke("autopilot:cancel-prepared", request),
  checkMacPermissions: () => ipcRenderer.invoke("mac:check-permissions"),
  openFullDiskAccessSettings: () => ipcRenderer.invoke("mac:open-full-disk-access"),
  revealDataFolder: () => ipcRenderer.invoke("app:reveal-data-folder")
};

contextBridge.exposeInMainWorld("socializeAI", api);
