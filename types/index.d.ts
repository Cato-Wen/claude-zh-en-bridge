export type Translation = { src: string; zh: string }

declare module 'claude-code' {
  interface PluginState {
    'zh-en-bridge': { replies: Record<string, Translation> }
  }
}
