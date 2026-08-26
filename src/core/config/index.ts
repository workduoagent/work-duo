export const APP_NAME = 'Work Duo'
export const APP_VERSION = '0.1.0'

export enum Env {
  Development = 'development',
  Production = 'production',
}

// True when running inside the Tauri webview (custom protocol / native shell).
export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// Tauri commands are local; there is no remote base URL for the IPC layer.
export const API_BASE = ''
