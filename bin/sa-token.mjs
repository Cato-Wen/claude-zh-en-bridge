// Gets a Google OAuth access token from Application Default Credentials.
// Usage: node sa-token.mjs [credentials.json]
//
// Looks for credentials in this order:
//   1. the path given as the first argument
//   2. GOOGLE_APPLICATION_CREDENTIALS
//   3. gcloud's ADC file (`gcloud auth application-default login`):
//      Windows %APPDATA%\gcloud\application_default_credentials.json
//      macOS / Linux ~/.config/gcloud/application_default_credentials.json
// Handles both "service_account" and "authorized_user" files.
// Prints {"access_token","expires_in","project_id"} as JSON. No dependencies.
import { existsSync, readFileSync } from 'node:fs'
import { createSign } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

function credentialsPath() {
  if (process.argv[2]) return process.argv[2]
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS
  const adc = process.platform === 'win32'
    ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json')
    : join(process.env.CLOUDSDK_CONFIG || join(homedir(), '.config', 'gcloud'), 'application_default_credentials.json')
  return existsSync(adc) ? adc : undefined
}

const fail = (msg, code = 1) => { console.error(msg); process.exit(code) }
const b64url = buf => Buffer.from(buf).toString('base64url')

const path = credentialsPath()
if (!path) fail('no Google credentials: set GOOGLE_APPLICATION_CREDENTIALS or run `gcloud auth application-default login`', 3)

const creds = JSON.parse(readFileSync(path, 'utf8'))
const tokenUri = creds.token_uri || 'https://oauth2.googleapis.com/token'
let body

if (creds.type === 'service_account') {
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: creds.private_key_id }))}.${b64url(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  }))}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(creds.private_key)
  body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` })
} else if (creds.type === 'authorized_user') {
  body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
  })
} else {
  fail(`unsupported credentials type: ${creds.type}`)
}

const res = await fetch(tokenUri, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body,
})
const text = await res.text()
if (!res.ok) fail(`token HTTP ${res.status}: ${text.slice(0, 300)}`)
const data = JSON.parse(text)
process.stdout.write(JSON.stringify({
  access_token: data.access_token,
  expires_in: data.expires_in ?? 3600,
  project_id: creds.project_id || creds.quota_project_id,
}))
