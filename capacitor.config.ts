import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.feuillet.editor',
  appName: 'Feuillet',
  webDir: 'out/web',
  android: { allowMixedContent: false }
}

export default config
