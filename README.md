# QuizPilot

QuizPilot is a Chrome extension (Manifest V3) plus a secure Node.js backend for study-only multiple-choice quiz practice.

Scope limits:
- Only analyze content already visible to the user.
- No bypassing logins, paywalls, captchas, proctoring, or access controls.
- No auto-submit behavior.

## Project Structure

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
  server/
    package.json
    .env.example
    src/
      server.js
      gemini.js
      firebase-admin.js
      validation.js
```

## Architecture

- Popup (`popup.*`): sign-in, scan trigger, solve trigger, status.
- Background (`background.js`): orchestrates tab messaging, auth exchange, backend calls, progress events.
- Content script (`content.js`): scans visible MCQ blocks, dedupes numbered questions, places discreet `qp` chips beside questions.
- Backend (`server/src/server.js`): Firebase auth, credits, Gemini calls, validation, CORS, rate limiting.

## Auth + Credits

- Sign-in is Google-only through `chrome.identity`.
- Backend exchanges Google access token at Firebase Identity Toolkit.
- Backend verifies Firebase ID token with Firebase Admin SDK.
- Firestore stores user usage at `users/{uid}`.
- `STARTER_CREDITS` controls initial free answers (default `100`).
- Each `/analyze-question` call consumes 1 credit.

## Backend Local Setup

1. Open terminal in `server/`.
2. Install:
   ```bash
   npm install
   ```
3. Create env file:
   ```bash
   cp .env.example .env
   ```
4. Fill required variables:
   - `GEMINI_API_KEY`
   - `FIREBASE_WEB_API_KEY`
   - Firebase Admin credentials:
     - Either `FIREBASE_SERVICE_ACCOUNT_JSON`
     - Or `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
5. Start:
   ```bash
   npm run dev
   ```
6. Test:
   - `GET http://localhost:10000/`
   - `GET http://localhost:10000/health`

## Render Deployment

Create a Render Web Service from this repo:

- Root directory: `server`
- Build command: `npm install`
- Start command: `npm start`

Set these Render environment variables:

- `GEMINI_API_KEY`
- `GEMINI_MODEL` (example: `gemini-2.0-flash`)
- `FIREBASE_WEB_API_KEY`
- `GOOGLE_OAUTH_CLIENT_ID` (must match `chrome-extension/manifest.json` `oauth2.client_id`)
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `STARTER_CREDITS` (example: `100`)
- `RATE_LIMIT_MAX` (example: `60`)
- `CORS_STRICT_MODE` (`false` while testing; `true` in stricter setup)
- `ALLOWED_ORIGINS` (required when strict mode is true): `chrome-extension://<extension_id>`

Important:
- Do not set `FIRBASE_PROJECT_ID` (typo). Use `FIREBASE_PROJECT_ID`.

## Extension Setup

1. In `chrome-extension/config.js`, set:
   - `BACKEND_URL` to your Render URL (no trailing endpoint path).
2. In `chrome-extension/manifest.json`, set `oauth2.client_id` to your Google OAuth Client ID.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Load unpacked `chrome-extension/`.
6. Open extension popup and sign in.

## Backend Routes

Both plain and `/api` prefixed routes are supported:

- `GET /health` and `GET /api/health`
- `POST /auth/google` and `POST /api/auth/google`
- `GET /auth/me` and `GET /api/auth/me`
- `POST /analyze-question` and `POST /api/analyze-question`

## Troubleshooting

- `Backend returned 404`:
  - Confirm Render service root directory is `server`.
  - Confirm `npm start` runs `node src/server.js`.
  - Open `https://<service>.onrender.com/health`.

- `Google OAuth client_id is not configured`:
  - Fill `manifest.json > oauth2.client_id` and reload extension.

- `INVALID_IDP_RESPONSE ... access_token audience is not for this project`:
  - Your `FIREBASE_WEB_API_KEY` is from a different Firebase project than the OAuth client in `manifest.json`.
  - Ensure both belong to the same Firebase/Google Cloud project.
  - Set `GOOGLE_OAUTH_CLIENT_ID` in Render to the same value as manifest.

- `Failed to reach backend`:
  - Check `chrome-extension/config.js` `BACKEND_URL`.
  - Check Render logs and service is deployed.

- `No credits remaining`:
  - Increase credits in Firestore user doc or raise `STARTER_CREDITS` for new users.

- Too many detected questions:
  - Current scanner prioritizes numbered visible MCQ questions and caps scan/analyze limits from `config.js`.
