/// <reference types="vite/client" />
import type { FeuilletApi } from '../../preload'

declare global {
  interface Window {
    feuillet: FeuilletApi
  }
}
