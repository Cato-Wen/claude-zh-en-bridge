# zh-en-bridge

A Claude Code mod for people who prefer to work in Chinese while Claude works in English:

- **Your prompts go to Claude in English.** A prompt that contains Chinese is translated to English before it is sent.
- **Claude's replies are shown in Chinese.** English reply text is translated and drawn in Chinese. Only the display changes; the conversation Claude reads stays in English.
- **Question dialogs are shown in Chinese**, and your answers go back to Claude in English (picked options under their original labels, typed text translated).

Translation uses Gemini on Google Vertex AI, not a Claude model. Tool-call rows and tool output are not translated. A reply first appears in English and switches to Chinese once its translation arrives (a few seconds).

## Prerequisites

- Claude Code already set up on Google Vertex AI (`CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID`), with Google credentials on the machine:
  either `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service account key, or `gcloud auth application-default login`.
- Gemini enabled in that Vertex project.
- Node.js on `PATH` (used to get the access token). Without Node the mod falls back to `gcloud auth application-default print-access-token`.

Works on Windows and macOS.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install zh-en-bridge --marketplace Cato-Wen/claude-zh-en-bridge
```

From a shell:

```
claude plugin install zh-en-bridge --marketplace Cato-Wen/claude-zh-en-bridge
```

Answer `y` to add the marketplace, then pick the user scope. This repository is private: installing needs read access to it on GitHub and a git credential for github.com on your machine (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Settings (optional environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Gemini model used for translation. Thinking is turned off for `flash` models. |
| `GEMINI_VERTEX_PROJECT` | `GOOGLE_CLOUD_PROJECT`, then `ANTHROPIC_VERTEX_PROJECT_ID` | Vertex project that hosts Gemini. |
| `GEMINI_VERTEX_LOCATION` | `GOOGLE_CLOUD_LOCATION`, then `global` | Vertex location. |
| `GEMINI_API_KEY` | unset | When set, uses the Gemini Developer API with this key instead of Vertex. |

Set them in `~/.claude/settings.json` under `"env"`, then restart Claude Code.

## Troubleshooting

Problems show in the status line as `zh-en-bridge: ...`, for example `Gemini HTTP 403` (Gemini not enabled in the project, or no permission) or `auth failed (...)` (no usable Google credentials).
