# QuizPilot

QuizPilot is a Chrome Extension (Manifest V3) plus a secure Node.js backend that analyzes visible multiple-choice quiz questions for study and revision workflows.

Important scope boundary:
- Use only in user-authorized study/practice environments.
- No login bypass, anti-bot bypass, paywall bypass, proctoring bypass, captcha solving, stealth automation, or auto-submission.

## Architecture

- `chrome-extension/`
  - `popup.html`, `popup.css`, `popup.js`: user controls and explanation UI.
  - `background.js`: orchestrates popup/content/backend communication and retry logic.
  - `content.js`: DOM scanning heuristics + on-page highlighting + floating status overlay.
  - `config.js`: extension-side runtime defaults (backend URL and request timeouts).
- `server/`
  - `src/server.js`: Express API with input validation, CORS, rate limiting, and error handling.
  - `src/gemini.js`: Gemini prompt + response parsing/normalization.
  - `src/validation.js`: request sanitization/validation helpers.

Data flow:
1. User clicks **Scan Current Question** in popup.
2. Popup asks background service worker to scan the active tab.
3. Background asks content script to extract question/options currently visible in DOM.
4. Background sends structured data to backend `POST /analyze-question`.
5. Backend calls Gemini with strict JSON instructions.
6. Parsed response is returned to extension.
7. Extension can highlight best option and show explanation/confidence in popup.

## Folder Structure

```text
QuizPilot/
  chrome-extension/
    manifest.json
    config.js
    background.js
    content.js
    popup.html
    popup.css
    popup.js
    icons/
      README.md
  server/
    package.json
    .env.example
    .gitignore
    src/
      server.js
      gemini.js
      validation.js
  README.md
```

## Run Backend Locally

1. Open terminal at `server/`.
2. Install dependencies:

```bash
npm install
```

3. Create `.env` from `.env.example` and set your Gemini key:

```bash
cp .env.example .env
```

4. Edit `.env`:
- `GEMINI_API_KEY=...`
- `ALLOWED_ORIGINS=chrome-extension://<your_extension_id>` (after loading extension once)

5. Start server:

```bash
npm run dev
```

6. Verify health:

```bash
curl http://localhost:10000/health
```

## Deploy Backend to Render

1. Push this repository to GitHub.
2. In Render, create a new **Web Service** from the repo.
3. Configure:
- Runtime: `Node`
- Root directory: `server`
- Build command: `npm install`
- Start command: `npm start`
- Node version: `>=18`

4. In Render service settings, add environment variables:
- `GEMINI_API_KEY` = your real Gemini API key
- `GEMINI_MODEL` = `gemini-2.0-flash` (or another compatible model)
- `ALLOWED_ORIGINS` = `chrome-extension://<your_extension_id>`
- `RATE_LIMIT_MAX` = `60` (or preferred limit)

5. Deploy. Note your Render URL (for example `https://quizpilot-api.onrender.com`).

## Point Extension to Backend

For local dev, default backend is already `http://localhost:10000` in `chrome-extension/config.js`.

For Render deployment:
1. Update `chrome-extension/config.js` `BACKEND_URL` to your Render URL.
2. Reload the extension in `chrome://extensions`.

## Load Extension in Chrome (Unpacked)

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `chrome-extension/` folder.
5. Pin QuizPilot in toolbar.

## Permissions Used

In `manifest.json`:
- `activeTab`: interact with currently active tab when user triggers actions.
- `tabs`: query active tab from background.
- `storage`: store auto-highlight and backend URL settings.
- `scripting`: reserved for future dynamic script actions.
- `host_permissions`:
  - quiz page domains (`http/https`) so content scripts can run on visible quiz pages.
  - backend domains (`localhost` and Render) for API requests.

## API Contract

`POST /analyze-question`

Request body:

```json
{
  "questionText": "What is ...?",
  "options": ["Option A", "Option B", "Option C"],
  "context": {
    "pageTitle": "Practice Quiz",
    "hostname": "example.com"
  }
}
```

Response body:

```json
{
  "bestAnswerIndex": 1,
  "bestAnswerText": "Option B",
  "explanation": "...",
  "confidence": 0.82
}
```

## Troubleshooting

1. `Could not find a visible quiz block`
- Scroll so the question and options are fully visible.
- Ensure page is not inside a cross-origin iframe (extension cannot access restricted frame content).
- Try rescanning after expanding collapsed sections.

2. `No analyzed question yet`
- Click **Scan Current Question** first, then **Highlight** or **Explain**.

3. `Backend request timed out`
- Confirm server is running and reachable.
- Check backend URL in `chrome-extension/config.js`.
- Check Render service status/logs.

4. `Server is missing GEMINI_API_KEY`
- Set `GEMINI_API_KEY` in `server/.env` (local) or Render environment settings.

5. CORS errors
- Ensure `ALLOWED_ORIGINS` includes exact extension origin:
  - `chrome-extension://<extension_id>`

6. Gemini JSON parsing errors
- Backend already enforces strict parsing and fallback normalization.
- Inspect Render logs for upstream model output anomalies.

## Extension Safety Notes

- QuizPilot only reads currently visible page content and only when user clicks popup actions.
- It does not auto-submit, auto-navigate, solve captchas, bypass auth, or hide behavior.
- It is intended for study/revision support in authorized contexts.
