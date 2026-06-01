import type { SocializeAIAPI } from "./shared";

declare global {
  interface Window {
    socializeAI: SocializeAIAPI;
  }
}

export {};
