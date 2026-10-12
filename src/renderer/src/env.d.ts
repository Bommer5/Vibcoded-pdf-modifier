/// <reference types="vite/client" />
import type { FeuilletApi } from '../../preload'

declare global {
  // Absent sur mobile / navigateur : voir platform/index.ts
  interface Window {
    feuillet: FeuilletApi
  }
}
