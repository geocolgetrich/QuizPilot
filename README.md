# QuizPilot

QuizPilot is a Chrome Extension (Manifest V3) plus a secure Node.js backend that analyzes visible multiple-choice quiz questions for study and revision workflows.

Important scope boundary:
- Use only in user-authorized study/practice environments.
- No login bypass, anti-bot bypass, paywall bypass, proctoring bypass, captcha solving, stealth automation, or auto-submission.

## Architecture

- `chrome-extension/`
  - `popup.html`, `popup.css`, `popup.js`: user controls, Google sign-in, quota display.
  - `background.js`: orchestrates popup/content/backend communication, auth token storage, retry logic.
  - `content.js`: DOM scanning heuristics + on-page highlighting + floating status overlay.
  - `config.js`: extension-side runtime defaults (backend URL and request timeouts).
- `server/`
  - `src/server.js`: Express API with Firebase-auth endpoints, quota logic, CORS, rate limiting, and error handling.
  - `src/firebase-admin.js`: Firebase Admin initialization from environment variables.
  - `src/gemini.js`: Gemini prompt + response parsing/normalization.
  - `src/validation.js`: request sanitization/validation helpers.

## Firebase Auth + Credits

- Auth is Google-only, via Chrome Identity + Firebase Identity Toolkit exchange on backend.
- Backend verifies Firebase ID tokens with Firebase Admin.
- Firestore stores per-user credits in `users/{uid}`.
- New users get starter credits (`STARTER_CREDITS`, default `100`).
- Each successful `/analyze-question` consumes 1 credit.

Security notes:
- Firebase **web** config/apiKey is not a secret.
- Firebase **Admin** credentials are secrets and must stay on backend env vars only.
- Firestore should not remain in test mode for production; use authenticated, least-privilege rules.

Data flow:
1. User clicks **Scan All Questions** in popup.
2. Popup asks background service worker to scan the active tab.
3. Background asks content script to extract all visible question/option blocks from the DOM.
4. User selects one detected question from the popup dropdown and clicks **Get AI Answer**.
5. Background sends selected question data to backend `POST /analyze-question`.
6. Backend calls Gemini with strict JSON instructions and resilient parsing.
7. Parsed response is returned to extension.
8. Extension shows answer/explanation in popup and can display a suggestion panel beside the selected question.

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
- `FIREBASE_WEB_API_KEY=...`
- Firebase Admin credentials (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, or `FIREBASE_SERVICE_ACCOUNT_JSON`)
- Optional strict mode:
  - `CORS_STRICT_MODE=true`
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
- `FIREBASE_WEB_API_KEY` = your Firebase Web API key
- Firebase Admin secret vars (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, or `FIREBASE_SERVICE_ACCOUNT_JSON`)
- `STARTER_CREDITS` = `100`
- `CORS_STRICT_MODE` = `false` (recommended while stabilizing integration)
- `ALLOWED_ORIGINS` = `chrome-extension://<your_extension_id>` (required only when strict mode is true)
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
6. Update `chrome-extension/manifest.json` `oauth2.client_id` with your Google OAuth client ID before sign-in will work.

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
- Click **Scan All Questions**, select one question, then click **Get AI Answer**.

3. `Backend request timed out`
- Confirm server is running and reachable.
- Check backend URL in `chrome-extension/config.js`.
- Check Render service status/logs.

4. `Server is missing GEMINI_API_KEY`
- Set `GEMINI_API_KEY` in `server/.env` (local) or Render environment settings.

5. CORS errors
- Keep `CORS_STRICT_MODE=false` while testing.
- If strict mode is enabled, ensure `ALLOWED_ORIGINS` includes exact extension origin:
  - `chrome-extension://<extension_id>`

6. Gemini JSON parsing errors
- Backend already enforces strict parsing and fallback normalization.
- Inspect Render logs for upstream model output anomalies.

## Extension Safety Notes

- QuizPilot only reads currently visible page content and only when user clicks popup actions.
- It does not auto-submit, auto-navigate, solve captchas, bypass auth, or hide behavior.
- It is intended for study/revision support in authorized contexts.
