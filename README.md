# Hands-free Live Translator (English ⇄ Chinese)

A web app for a face-to-face conversation between an English speaker and a Chinese speaker (Mandarin or Cantonese) sharing one phone, tablet or laptop. Tap **Start conversation** once and then just talk. The app works out who is speaking, translates each phrase, shows it in large text on the listener's half of the screen, and can read it aloud.

- **Hands-free:** Azure AI Speech keeps listening and identifies English vs Chinese on every phrase, so there's no button to switch speaker or language.
- **Private:** nothing is stored. There's no database, no files and no logs, and the browser doesn't use storage. The transcript exists only in page memory.

## How it works

```
 Browser (phone)                          Node server (Express)                 Cloud
 ───────────────                          ─────────────────────                 ─────
 mic ─► Azure Speech SDK  ◄── token ────  GET /api/speech-token  ── key ──►  Azure STS
        (continuous LID: en-US + zh-CN/zh-HK)
        audio stream ─────────────────────────────────────────────────────►  Azure Speech
        phrase + detected language
          │
          └─► POST /api/translate ──────► Claude API (Anthropic) ──────────►  Anthropic
              (phrase + last 6 turns)     no logging, nothing saved
          ◄── translation
        show on the other half, speak with on-device TTS (mic muted while speaking)
```

### File structure

```
server/
  index.js        entry point: loads .env, starts HTTP or HTTPS
  app.js          Express app: static files, /api/speech-token, /api/translate, safe error handler
  translate.js    request validation, prompt, Claude API call
public/
  index.html      split-screen UI + settings dialog
  styles.css      mobile-first layout (top half rotated 180° for the Chinese speaker)
  js/app.js       recognizer, translation queue, text-to-speech, mic pause/resume
  js/logic.js     pure helpers (language mapping, noise filter, rolling context)
test/             node:test unit + endpoint tests (no API keys needed)
```

## Setup

You need Node.js 18.17 or newer.

1. **Azure Speech key + region**
   1. Create a free Azure account at https://azure.microsoft.com/free.
   2. In the Azure portal, create a **Speech** resource (search "Speech service"). The free **F0** tier is enough to try it.
   3. Open the resource and go to **Keys and Endpoint**. Copy **KEY 1** and the **Location/Region** (e.g. `eastus`, `westeurope`, `southeastasia`).
2. **Anthropic API key:** create one at https://console.anthropic.com/ under API Keys.
3. **Install and configure:**
   ```bash
   npm install
   cp .env.example .env      # then paste in the three values
   ```
4. **Run:**
   ```bash
   npm start
   ```
   Open http://localhost:3000 on the same computer, tap **Start conversation** and allow the microphone.

5. **Test** (no keys needed; it uses fakes for Azure and Claude):
   ```bash
   npm test
   ```

### Settings (⚙)

| Setting | Options |
|---|---|
| Chinese speaker talks in | Mandarin (`zh-CN`, default) or Cantonese (`zh-HK`) |
| Chinese text | Simplified (default) or Traditional |
| Read translations aloud | On (default) / Off |

Settings live only in page memory and reset when you reload.

## Testing on a phone

Browsers only allow the microphone on `https://` pages or `http://localhost`. A phone opening `http://192.168.x.x:3000` is **blocked**. Pick one of these options:

**Option A: local HTTPS with mkcert (stays on your network)**
```bash
# install mkcert: https://github.com/FiloSottile/mkcert#installation
mkcert -install
mkdir -p certs
mkcert -key-file certs/key.pem -cert-file certs/cert.pem localhost 127.0.0.1 192.168.1.23   # use your computer's LAN IP
```
Add `HTTPS_KEY=certs/key.pem` and `HTTPS_CERT=certs/cert.pem` to `.env` and run `npm start`. The server prints the `https://<your-ip>:3000` address. The phone has to trust the mkcert root CA:
- **iPhone:** AirDrop or email `"$(mkcert -CAROOT)/rootCA.pem"` to the phone and install the profile. Then go to Settings → General → About → Certificate Trust Settings and enable it.
- **Android:** copy `rootCA.pem` to the phone and install it under Settings → Security → Encryption & credentials → Install a certificate → CA certificate.

**Option B: a tunnel (quickest)**
```bash
npx cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
```
Open the `https://…` URL it prints on the phone. Your audio still goes directly from the phone to Azure. Translation text passes through the tunnel provider on its way to this server.

**Option C: Android only, USB.** Run `adb reverse tcp:3000 tcp:3000` and open `http://localhost:3000` in Chrome on the phone.

**Placing the phone:** lay it flat between you. The top half is upside-down so the person opposite can read it. On a laptop or another wide landscape screen, the halves sit side by side and aren't rotated.

## Tips for good results

- **Take turns.** Overlapping speech gets merged into one phrase in one language.
- Pause briefly when you finish. A phrase ends after about 0.7 s of silence.
- While a translation is being read aloud, the microphone is muted (the status shows **Speaking**). Anything said during that time isn't heard, so wait for **Listening**.
- Very short noises ("um", "嗯", single letters) and low-confidence recognitions are ignored.
- If someone sounds like they're in the wrong language, check the Mandarin/Cantonese setting.

## Privacy

**What this app stores: nothing.**

- **Browser:** the transcript lives only in JavaScript variables. The app never uses localStorage, sessionStorage, cookies or IndexedDB. **Stop**, refresh or closing the tab wipes it from memory and the screen.
- **Server:** no database and no files. No request-logging middleware is installed. The error handler logs only the error type and status, never request bodies, and never JSON parse errors (those can quote the input). API responses are sent with `Cache-Control: no-store`.
- **Context:** to translate accurately, the browser sends the last 6 turns along with each request. The server uses them for that one request and keeps nothing. The rate limiter holds per-IP counters in memory only.

**Third parties that receive your data while it's processed:**

| Service | Receives | Why |
|---|---|---|
| **Microsoft Azure AI Speech** | Live microphone audio, streamed directly from the browser | Speech recognition + language identification |
| **Anthropic (Claude API)** | Each recognised phrase + the last 6 turns of text | Translation |
| Your browser/OS speech engine | Translated text | Reading aloud. The app prefers on-device voices. Some browsers (e.g. Chrome's "Google …" voices) synthesise speech online. Turn off "Read translations aloud" to avoid this. |

Their data-handling policies apply to data in transit and during processing:
- Azure: https://learn.microsoft.com/legal/cognitive-services/speech-service/speech-to-text/data-privacy-security
- Anthropic: https://www.anthropic.com/legal/privacy and https://privacy.anthropic.com

**Don't expose this server to the public internet as-is.** It has no login, so anyone who can reach it can spend your Azure and Anthropic quota. It's meant for your own device or local network.

## Troubleshooting

| Message | Fix |
|---|---|
| "The microphone needs a secure page" | Use `https://` or `localhost`. See *Testing on a phone*. |
| "Microphone access is blocked" | Allow the mic for this site. iOS: Settings → Safari → Microphone. Chrome: the lock icon → Site settings. |
| "Azure Speech is not configured" / "rejected the credentials" | Check `AZURE_SPEECH_KEY` and that `AZURE_SPEECH_REGION` matches the resource's region. |
| "rate-limiting this key" | The F0 free tier allows one concurrent session. Close other tabs or devices using it. |
| "Translation service rejected the API key" | Check `ANTHROPIC_API_KEY`. |
| Nothing is read aloud on iPhone | Make sure the silent switch is off and the media volume is up. |

## Configuration reference

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes | | |
| `AZURE_SPEECH_KEY` | yes | | Exchanged server-side for 10-minute tokens. The key never reaches the browser. |
| `AZURE_SPEECH_REGION` | yes | | e.g. `eastus` |
| `PORT` | no | `3000` | |
| `CLAUDE_MODEL` | no | `claude-opus-5-5` | |
| `CLAUDE_EFFORT` | no | `low` | Low keeps translations fast. Raise it to `medium` for harder material. |
| `HTTPS_KEY` / `HTTPS_CERT` | no | | Serve HTTPS directly. |
