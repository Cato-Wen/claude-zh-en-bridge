import { expect, test } from 'claude-code/testing'

const TEXT = 'The build passed and all tests are green, so the change is ready to merge.'

const MESSAGE = {
  plugin: 'zh-en-bridge',
  component: 'AssistantMessage',
  requestId: 'm1',
  props: { text: TEXT, isFirstOfReply: true },
} as const

// Seeds what the mod keeps in $.state: the stand-in engine answers each read.
function seed(on: any, values: { replies?: object; translating?: object; prompts?: object; commandArgs?: object }) {
  on('state.get', (_: unknown, e: { key: string }) => ({
    value: { value: (values as any)[e.key], version: 1 },
  }))
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a reply being translated shows the marker under the English`, async ($, on) => {
    seed(on, { translating: { m1: TEXT } })
    const ui = await $.ui.mount({ ...MESSAGE, surface })
    expect((await ui.find({ type: 'Text', text: /⇄ 翻译中…/ }))?.text).toBe('⇄ 翻译中…')
    await ui.unmount()
  })

  test(`${surface}: a translated reply shows no marker`, async ($, on) => {
    seed(on, { replies: { m1: { src: TEXT, zh: '构建通过，测试全绿。' } } })
    const ui = await $.ui.mount({ ...MESSAGE, surface })
    expect(await ui.find({ type: 'Text', text: /⇄/ })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a translated prompt is drawn as typed in Chinese`, async ($, on) => {
    const en = 'Does Playwright already implement these agents?'
    const zh = 'Playwright 不是已经有这些 agent 的实现了吗？'
    seed(on, { prompts: { [en]: zh } })
    let drawnText: string | undefined
    on('ui.render', (_: unknown, e: any) => {
      drawnText = e.props.text
      return { type: 'Text', props: {}, children: [e.props.text] }
    })
    const ui = await $.ui.mount({
      plugin: 'zh-en-bridge',
      component: 'UserMessage',
      requestId: 'u1',
      surface,
      props: { text: en, origin: { kind: 'user' }, isExpanded: true },
    } as any)
    expect(drawnText).toBe(zh)
    await ui.unmount()
  })

  test(`${surface}: a command row shows its translated arguments in Chinese`, async ($, on) => {
    const en = 'Help me understand these three playwright agents again'
    const zh = '帮我再了解下 playwright 这三个 agent'
    seed(on, { commandArgs: { [en]: zh } })
    let drawnText: string | undefined
    on('ui.render', (_: unknown, e: any) => {
      drawnText = e.props.text
      return { type: 'Text', props: {}, children: [e.props.text] }
    })
    const ui = await $.ui.mount({
      plugin: 'zh-en-bridge',
      component: 'UserMessage',
      requestId: 'u2',
      surface,
      props: { text: `/eli5 ${en}`, origin: { kind: 'user' }, isExpanded: true },
    } as any)
    expect(drawnText).toBe(`/eli5 ${zh}`)
    await ui.unmount()
  })
}
