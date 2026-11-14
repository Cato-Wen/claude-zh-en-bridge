import { expect, test } from 'claude-code/testing'

const ZH = '帮我再了解下 playwright 这三个 agent'
const EN = 'Help me understand these three playwright agents again'

const COMMANDS = [
  { name: 'eli5', description: '', source: 'user' },
  { name: 'rename', description: '', source: 'builtin' },
]

// Stands in for the engine: Gemini (by API key) answers EN, and the command
// beneath records the arguments it ran with.
function engine(on: any) {
  const ran: string[] = []
  const fetched: string[] = []
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'GEMINI_API_KEY' ? 'k' : undefined }))
  on('command.list', () => ({ value: COMMANDS }))
  on('http.fetch', (_: unknown, e: { url: string }) => {
    fetched.push(e.url)
    return { value: { ok: true, status: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: EN }] } }] }) } }
  })
  on('command.run', (_: unknown, e: { args: string }) => {
    ran.push(e.args)
    return {}
  })
  return { ran, fetched }
}

const run = (command: string, args: string) => ({
  command,
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}) as any

test('a skill command runs with its Chinese arguments in English', async ($, on) => {
  const { ran } = engine(on)
  await $.command.run(run('eli5', ZH))
  expect(ran).toEqual([EN])
})

test('a built-in command keeps its arguments as typed', async ($, on) => {
  const { ran, fetched } = engine(on)
  await $.command.run(run('rename', ZH))
  expect(ran).toEqual([ZH])
  expect(fetched).toEqual([])
})

test('English arguments are not sent for translation', async ($, on) => {
  const { ran, fetched } = engine(on)
  await $.command.run(run('eli5', 'explain closures'))
  expect(ran).toEqual(['explain closures'])
  expect(fetched).toEqual([])
})
