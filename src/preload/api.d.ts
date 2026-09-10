import type { CodexHubApi } from '../shared/ipc';

declare global {
  interface Window {
    codexHub: CodexHubApi & { getPathForFile(file: File): string };
  }
}

export {};
