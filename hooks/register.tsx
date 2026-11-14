import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import type { Translation } from '../types'

// Translated replies, keyed by the message's requestId. Kept in $.state so a
// hot reload does not lose them and a write redraws the message.
const replies = atom({ plugin: 'zh-en-bridge', key: 'replies' } as const, {} as Record<string, Translation>)

// What is being translated right now: message id -> the text sent. Drawn as a
// dim marker under that message until its translation lands.
const translating = atom({ plugin: 'zh-en-bridge', key: 'translating' } as const, {} as Record<string, string>)

const MARK = '⇄ 翻译中…'
const PROMPT_MARK = '译…'

const DEFAULT_MODEL = 'gemini-3.8-flash'
const SETTLE_MS = 800 // wait for a streaming block to stop changing

const CJK = /[㐀-鿿豈-﫿]/g
const LATIN = /[A-Za-z]/g

const hasChinese = (s: string) => /[㐀-鿿豈-﫿]/.test(s)

// A reply counts as English when it has letters and next to no Chinese.
const looksEnglish = (s: string) => {
  const latin = (s.match(LATIN) ?? []).length
  const cjk = (s.match(CJK) ?? []).length
  return latin >= 8 && cjk * 10 < latin
}

const TO_EN = [
  'You translate a software developer\'s message from Chinese to English.',
  'Output only the English translation, nothing else.',
  'Keep code, file paths, identifiers, commands, URLs, ticket ids and markdown exactly as written.',
  'Keep any English already present as it is.',
].join(' ')

const TO_ZH = [
  'You translate an AI coding assistant\'s reply from English to Simplified Chinese.',
  'Output only the translation, nothing else.',
  'Preserve the markdown structure exactly. Do not translate code blocks, inline code,',
  'file paths, identifiers, commands, URLs or proper technical terms best left in English.',
].join(' ')

// ---------- Gemini backends ----------
// 1) GEMINI_API_KEY, when set (the Gemini Developer API)
// 2) otherwise Vertex AI with Google Application Default Credentials: a service
//    account file in GOOGLE_APPLICATION_CREDENTIALS, or the file that
//    `gcloud auth application-default login` writes

// Access token cache: module variables, so a reload just fetches a fresh one.
let token: { value: string; project?: string; expiresAt: number } | undefined

type Token = { value: string; project?: string }

// The hooks environment cannot sign a JWT, so the token comes from a host
// command: bin/sa-token.mjs under Node (no dependencies), else gcloud.
async function accessToken($: EngineInterface): Promise<Token> {
  const now = Date.now() / 1000
  if (token && token.expiresAt - 120 > now) return token

  const errors: string[] = []

  try {
    const run = await $.process.run(['node', `${$.plugin.root}/bin/sa-token.mjs`], { timeoutMs: 20000 })
    if (run.exitCode === 0) {
      const data = JSON.parse(run.stdout) as { access_token: string; expires_in: number; project_id?: string }
      token = { value: data.access_token, project: data.project_id, expiresAt: now + data.expires_in }
      return token
    }
    errors.push(run.stderr.trim().slice(0, 160) || `node exit ${run.exitCode}`)
  } catch {
    errors.push('node not found')
  }

  // gcloud is a .cmd script on Windows, which only cmd.exe can start.
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const gcloud = ['gcloud', 'auth', 'application-default', 'print-access-token']
  try {
    const run = await $.process.run(isWindows ? ['cmd.exe', '/d', '/c', ...gcloud] : gcloud, { timeoutMs: 30000 })
    const value = run.stdout.trim()
    if (run.exitCode === 0 && value) {
      token = { value, expiresAt: now + 3000 }
      return token
    }
    errors.push(run.stderr.trim().slice(0, 160) || `gcloud exit ${run.exitCode}`)
  } catch {
    errors.push('gcloud not found')
  }

  throw new Error(errors.join('; '))
}

type Endpoint = { url: string; headers: Record<string, string>; model: string }

async function endpoint($: EngineInterface): Promise<Endpoint | string> {
  const model = (await $.env.get('GEMINI_MODEL')) || DEFAULT_MODEL

  const key = await $.env.get('GEMINI_API_KEY')
  if (key) {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      model,
    }
  }

  const auth = await accessToken($)
  const project =
    (await $.env.get('GEMINI_VERTEX_PROJECT')) ||
    (await $.env.get('GOOGLE_CLOUD_PROJECT')) ||
    (await $.env.get('ANTHROPIC_VERTEX_PROJECT_ID')) ||
    auth.project
  if (!project) return 'no Vertex project: set GEMINI_VERTEX_PROJECT'
  const location = (await $.env.get('GEMINI_VERTEX_LOCATION')) || (await $.env.get('GOOGLE_CLOUD_LOCATION')) || 'global'
  const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`
  return {
    url: `https://${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:generateContent`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.value}` },
    model,
  }
}

const QUESTIONS_TO_ZH = [
  'You receive a JSON array of questions an AI coding assistant asks a developer.',
  'Return the same JSON array with the same structure, keys, order and array lengths.',
  'Translate only these string values into Simplified Chinese: "question", "header", "description",',
  '"label", "placeholder", "unit". Leave every other value (including "preview") exactly as it is.',
  '"header" must stay at most 12 characters. Keep code, paths, identifiers and URLs unchanged.',
  'Output only the JSON.',
].join(' ')

type Question = { question?: unknown; header?: unknown; options?: { label?: unknown }[] }

// The translation must keep the dialog's shape, or the dialog would refuse it.
function sameShape(src: Question[], out: unknown): out is Question[] {
  if (!Array.isArray(out) || out.length !== src.length) return false
  return src.every((q, i) => {
    const t = out[i] as Question
    if (typeof t?.question !== 'string' || typeof t.header !== 'string' || t.header.length > 12) return false
    const a = q.options ?? []
    const b = t.options ?? []
    if (a.length !== b.length) return false
    const labels = b.map(o => o.label)
    return labels.every(l => typeof l === 'string') && new Set(labels).size === labels.length
  })
}

// Chinese text shown in a dialog -> the English it stands for. Lets a picked
// option go back to Claude under its original English label.
const toEnglish = new Map<string, string>()

function remember(src: Question[], zh: Question[]) {
  src.forEach((q, i) => {
    const t = zh[i]
    if (!t) return
    if (typeof t.question === 'string' && typeof q.question === 'string') toEnglish.set(t.question, q.question)
    ;(q.options ?? []).forEach((o, j) => {
      const l = t.options?.[j]?.label
      if (typeof l === 'string' && typeof o.label === 'string') toEnglish.set(l, o.label)
    })
  })
}

// An answer string as Claude should read it: known labels mapped back, any
// other Chinese (text the person typed) translated to English.
async function answerInEnglish($: EngineInterface, value: string): Promise<string> {
  if (!hasChinese(value)) return value
  const exact = toEnglish.get(value)
  if (exact) return exact
  const parts = value.split(', ')
  if (parts.length > 1 && parts.every(p => toEnglish.has(p))) return parts.map(p => toEnglish.get(p)).join(', ')
  return (await gemini($, TO_EN, value)) ?? value
}

async function gemini($: EngineInterface, system: string, text: string, json = false): Promise<string | undefined> {
  let ep: Endpoint | string
  try {
    ep = await endpoint($)
  } catch (err) {
    $.ui.status(`zh-en-bridge: auth failed (${err instanceof Error ? err.message : String(err)})`)
    return undefined
  }
  if (typeof ep === 'string') {
    $.ui.status(`zh-en-bridge: ${ep}`)
    return undefined
  }

  const res = await $.http.fetch(ep.url, {
    method: 'POST',
    headers: ep.headers,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text }] }],
      // Flash models can skip thinking entirely, which makes translation much faster.
      generationConfig: {
        temperature: 0.1,
        ...(json ? { responseMimeType: 'application/json' } : {}),
        ...(ep.model.includes('flash') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
  })
  if (!res.ok) {
    if (res.status === 401) token = undefined
    $.ui.status(`zh-en-bridge: Gemini HTTP ${res.status}`)
    return undefined
  }
  try {
    const data = JSON.parse(res.text)
    const parts: { text?: string }[] = data?.candidates?.[0]?.content?.parts ?? []
    const out = parts.map(p => p.text ?? '').join('').trim()
    if (out) $.ui.status(undefined)
    return out || undefined
  } catch {
    $.ui.status('zh-en-bridge: unreadable Gemini reply')
    return undefined
  }
}

// Runs one translation for message `id` with its marker shown, then stores the
// result. A failure stores the original, so the marker goes and the English stays
// without retrying on every redraw.
async function translateInto(
  $: EngineInterface,
  id: string,
  src: string,
  run: () => Promise<string | undefined>,
) {
  await update($, translating, all => ({ ...all, [id]: src }))
  let out: string | undefined
  try {
    out = await run()
  } finally {
    await update($, replies, all => ({ ...all, [id]: { src, zh: out ?? src } }))
    await update($, translating, ({ [id]: _, ...rest }) => rest)
  }
}

export const register: Register = on => {
  // Latest text seen per message, and the text being translated per message,
  // so a streaming block is translated once it settles, not on every chunk.
  const latest = new Map<string, string>()
  const inFlight = new Map<string, string>()

  // 1. Outgoing: a Chinese prompt goes to the model in English.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !hasChinese(e.text)) return next(e)

    $.ui.status(PROMPT_MARK)
    const english = await gemini($, TO_EN, e.text)
    if (english) $.ui.status(undefined)
    if (!english) {
      $.ui.toast('zh-en-bridge: translation failed, sent the prompt as typed')
      return next(e)
    }
    return next({ ...e, text: english })
  }).catch(($, e, next) => {
    $.ui.toast('zh-en-bridge: translation failed, sent the prompt as typed')
    return next(e)
  })

  // 2. Incoming: an English reply block is drawn in Chinese. Only the drawing
  // changes; the stored message (what the model reads back) stays English.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props.text
    if (!looksEnglish(text)) return next(e)

    const id = e.requestId
    const done = (await read($, replies))[id]
    if (done && done.src === text) {
      return next({ ...e, props: { ...e.props, text: done.zh } })
    }

    latest.set(id, text)
    if (inFlight.get(id) !== text) {
      $.clock.after(SETTLE_MS, () => {
        if (latest.get(id) !== text || inFlight.get(id) === text) return
        inFlight.set(id, text)
        void translateInto($, id, text, () => gemini($, TO_ZH, text)).finally(() => {
          if (inFlight.get(id) === text) inFlight.delete(id)
        })
      })
    }

    // Until the translation lands, show the English as it is, with the marker
    // once the request is out (not while the reply is still streaming).
    const english = await next(e)
    if ((await read($, translating))[id] !== text) return english
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {english}
        <Text dimColor>{MARK}</Text>
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // 3. Question dialogs (AskUserQuestion) are drawn in Chinese too.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const questions = e.props.questions as Question[]
    const src = JSON.stringify(questions)
    if (!looksEnglish(src)) return next(e)

    const id = `ask:${e.requestId}`
    const done = (await read($, replies))[id]
    if (done && done.src === src) {
      if (done.zh === src) return next(e) // translation failed: keep the English
      const zh = JSON.parse(done.zh) as Question[]
      remember(questions, zh)
      return next({ ...e, props: { ...e.props, questions: zh } })
    }

    if (inFlight.get(id) !== src) {
      inFlight.set(id, src)
      void translateInto($, id, src, async () => {
        const out = await gemini($, QUESTIONS_TO_ZH, src, true)
        if (!out) return undefined
        let zh: unknown
        try { zh = JSON.parse(out) } catch { return undefined }
        if (!sameShape(questions, zh)) return undefined
        return JSON.stringify(zh)
      }).finally(() => inFlight.delete(id))
    }

    // The dialog allows nothing below it, so the marker goes above.
    const dialog = await next(e)
    if ((await read($, translating))[id] !== src) return dialog
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text dimColor>{MARK}</Text>
        {dialog}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // 4. The answers go back to Claude in English: picked options under their
  // original labels, anything typed translated.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const r = await next(e)
    if (!r.result || r.isError) return r
    try {
      return await englishAnswers($, e.questions, r)
    } catch {
      return r // never re-run the dialog; Claude just reads the answer as given
    }
  })
}

async function englishAnswers(
  $: EngineInterface,
  questions: unknown,
  r: ToolCallResult<'AskUserQuestion'>,
): Promise<ToolCallResult<'AskUserQuestion'>> {
    if (r.deny !== undefined || r.isError) return r
    const res = r.result
    const answers: Record<string, string> = {}
    let changed = false
    for (const [q, a] of Object.entries(res.answers as Record<string, string>)) {
      const key = toEnglish.get(q) ?? q
      const value = typeof a === 'string' ? await answerInEnglish($, a) : a
      if (key !== q || value !== a) changed = true
      answers[key] = value
    }
    let response = res.response
    if (response && hasChinese(response)) {
      response = await answerInEnglish($, response)
      changed = true
    }
    let annotations = res.annotations as Record<string, { notes?: string; preview?: string }> | undefined
    if (annotations) {
      const out: typeof annotations = {}
      for (const [q, v] of Object.entries(annotations)) {
        const notes = v.notes && hasChinese(v.notes) ? await answerInEnglish($, v.notes) : v.notes
        if (notes !== v.notes || toEnglish.has(q)) changed = true
        out[toEnglish.get(q) ?? q] = { ...v, notes }
      }
      annotations = out
    }
    if (!changed) return r
    return { result: { ...res, questions: questions as typeof res.questions, answers, response, annotations } }
}

