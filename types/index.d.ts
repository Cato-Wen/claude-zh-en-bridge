export type Translation = { src: string; zh: string }

declare module 'claude-code' {
  interface PluginState {
    'zh-en-bridge': {
      replies: Record<string, Translation>
      translating: Record<string, string>
      prompts: Record<string, string>
      commandArgs: Record<string, string>
    }
  }
}
