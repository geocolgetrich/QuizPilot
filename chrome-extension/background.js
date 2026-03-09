importScripts("config.js");

const tabState = new Map();

function getConfigValue(key, fallback) {
  const config = globalThis.QUIZPILOT_CONFIG || {};
  return config[key] ?? fallback;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error("No active tab found.");
  return tab;
}

function setTabState(tabId, patch) {
  const current = tabState.get(tabId) || {};
  tabState.set(tabId, { ...current, ...patch, updatedAt: Date.now() });
}

function getTabState(tabId) {
  return tabState.get(tabId) || null;
}

function emitRuntimeProgress(payload) {
  chrome.runtime.sendMessage({ type: "QUIZPILOT_PROGRESS", payload }, () => {
    void chrome.runtime.lastError;
  });
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function sendToContent(tabId, message) {
  async function trySend() {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error(response?.error || "Content script error."));
          return;
        }
        resolve(response.data);
      });
    });
  }

  try {
    return await trySend();
  } catch (error) {
    if (!/Receiving end does not exist/i.test(error.message || "")) {
      throw error;
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return trySend();
  }
}

async function getBackendUrls() {
  const stored = await chrome.storage.local.get(["backendUrlOverride"]);
  const configBackendUrl = getConfigValue("BACKEND_URL", "http://localhost:10000");

  const urls = [];
  function normalizeBackendUrl(raw) {
    let url = String(raw || "").trim();
    if (!url) return "";
    url = url.replace(/\/+$/, "");
    url = url.replace(/\/(analyze-question|auth\/google|auth\/me|health)$/i, "");
    return url;
  }

  if (stored.backendUrlOverride) {
    const override = normalizeBackendUrl(stored.backendUrlOverride);
    const configIsRemote = /^https:\/\//i.test(configBackendUrl);
    const overrideIsLocalhost = /^http:\/\/localhost(?::\d+)?/i.test(override);
    if (!(configIsRemote && overrideIsLocalhost)) {
      urls.push(override);
    }
  }
  const normalizedConfigUrl = normalizeBackendUrl(configBackendUrl);
  if (!urls.includes(normalizedConfigUrl)) {
    urls.push(normalizedConfigUrl);
  }
  return urls.filter(Boolean);
}

function clampConfidence(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

async function probeBackendHealth(backendUrl) {
  try {
    const response = await withTimeout(
      fetch(`${backendUrl}/health`, { method: "GET", headers: { Accept: "application/json" } }),
      12000,
      "Health check timed out."
    );
    if (!response.ok) return `Backend reachable but /health returned ${response.status}.`;
    return "Backend reachable.";
  } catch (error) {
    return `Health probe failed: ${error.message || "unknown error"}.`;
  }
}

async function getStoredAuth() {
  const stored = await chrome.storage.local.get(["firebaseIdToken", "userProfile"]);
  return {
    firebaseIdToken: stored.firebaseIdToken || "",
    userProfile: stored.userProfile || null
  };
}

async function setStoredAuth({ firebaseIdToken, userProfile }) {
  await chrome.storage.local.set({ firebaseIdToken, userProfile });
}

function getGoogleAccessTokenInteractive() {
  return new Promise((resolve, reject) => {
    const clientId = chrome.runtime.getManifest()?.oauth2?.client_id || "";
    if (!clientId || clientId.includes("REPLACE_WITH_GOOGLE_OAUTH_CLIENT_ID")) {
      reject(
        new Error(
          "Google OAuth client_id is not configured in manifest.json."
        )
      );
      return;
    }

    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!token) {
        reject(new Error("Google auth token was not returned."));
        return;
      }
      resolve(token);
    });
  });
}

async function backendRequest(path, init = {}, token = "") {
  const urls = await getBackendUrls();
  const timeoutMs = getConfigValue("REQUEST_TIMEOUT_MS", 14000);
  const pathCandidates = [path, `/api${path}`];

  const errors = [];
  for (const backendUrl of urls) {
    for (const candidatePath of pathCandidates) {
      try {
        const headers = { ...(init.headers || {}) };
        if (token) headers.Authorization = `Bearer ${token}`;
        const response = await withTimeout(
          fetch(`${backendUrl}${candidatePath}`, { ...init, headers }),
          timeoutMs,
          "Backend request timed out."
        );

        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            body?.error || `Backend returned ${response.status} for ${candidatePath}`
          );
        }
        return body;
      } catch (error) {
        errors.push(
          `${backendUrl}${candidatePath} -> ${error.message || "request failed"}`
        );
      }
    }
  }

  throw new Error(`All backend URLs failed: ${errors.join(" | ")}`);
}

async function signInWithGoogle() {
  const googleAccessToken = await getGoogleAccessTokenInteractive();
  const response = await backendRequest(
    "/auth/google",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ googleAccessToken })
    },
    ""
  );

  await setStoredAuth({
    firebaseIdToken: response.idToken,
    userProfile: response.user
  });
  return response.user;
}

async function signOut() {
  await chrome.storage.local.remove(["firebaseIdToken", "userProfile"]);
  await new Promise((resolve) => {
    chrome.identity.clearAllCachedAuthTokens(() => resolve());
  });
  return { signedOut: true };
}

async function getAuthState() {
  const { firebaseIdToken, userProfile } = await getStoredAuth();
  return {
    isAuthenticated: Boolean(firebaseIdToken),
    userProfile
  };
}

async function analyzeQuestion(payload) {
  const { firebaseIdToken, userProfile } = await getStoredAuth();
  if (!firebaseIdToken) {
    throw new Error("Sign in with Google first.");
  }

  const requestBody = {
    questionText: payload.questionText,
    options: payload.options,
    context: {
      pageTitle: payload.pageTitle,
      hostname: payload.hostname
    }
  };

  const data = await backendRequest(
    "/analyze-question",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody)
    },
    firebaseIdToken
  );

  data.confidence = clampConfidence(data.confidence);
  if (data?.usage && userProfile) {
    const updated = {
      ...userProfile,
      creditsRemaining: Number(data.usage.creditsRemaining || 0)
    };
    await setStoredAuth({ firebaseIdToken, userProfile: updated });
  }
  return data;
}

async function scanAllQuestions() {
  const tab = await getActiveTab();
  const data = await sendToContent(tab.id, { type: "QUIZPILOT_SCAN_ALL" });
  const maxScan = Number(getConfigValue("MAX_SCAN_QUESTIONS", 25));
  const scannedQuestions = Array.isArray(data.questions) ? data.questions.slice(0, maxScan) : [];

  setTabState(tab.id, { scannedQuestions, answers: [] });
  return { scannedQuestions };
}

async function analyzeAllQuestions(options = {}) {
  const tab = await getActiveTab();
  const state = getTabState(tab.id);
  const scannedQuestions = options.scannedQuestions || state?.scannedQuestions || [];
  if (!Array.isArray(scannedQuestions) || scannedQuestions.length === 0) {
    throw new Error("No scanned questions yet. Run Scan All Questions first.");
  }

  const maxAnalyze = Number(getConfigValue("MAX_ANALYZE_QUESTIONS", 20));
  const questionsToAnalyze = scannedQuestions.slice(0, maxAnalyze);
  const answers = [];
  const total = questionsToAnalyze.length;
  emitRuntimeProgress({ solved: 0, total, answers: [], done: false });

  for (let idx = 0; idx < questionsToAnalyze.length; idx += 1) {
    const question = questionsToAnalyze[idx];
    const analysis = await analyzeQuestion(question);
    answers.push({
      id: question.id,
      displayNumber: question.displayNumber,
      bestAnswerIndex: analysis.bestAnswerIndex,
      bestAnswerText: analysis.bestAnswerText,
      confidence: analysis.confidence
    });

    setTabState(tab.id, { answers });
    emitRuntimeProgress({ solved: idx + 1, total, answers, done: idx + 1 === total });

    try {
      await sendToContent(tab.id, {
        type: "QUIZPILOT_PROGRESS",
        payload: { solved: idx + 1, total }
      });
    } catch {}

    if (options.showOnPage) {
      try {
        await sendToContent(tab.id, {
          type: "QUIZPILOT_SHOW_PARTIAL_ANSWER",
          payload: { answer: answers[answers.length - 1] }
        });
      } catch {}
    }
  }

  if (!options.showOnPage) {
    await sendToContent(tab.id, {
      type: "QUIZPILOT_SHOW_ALL_ANSWERS",
      payload: { answers }
    });
  }

  return { answers };
}

async function getCurrentState() {
  const tab = await getActiveTab();
  const state = getTabState(tab.id) || {};
  const auth = await getAuthState();
  return {
    scannedQuestions: state.scannedQuestions || [],
    answers: state.answers || [],
    updatedAt: state.updatedAt,
    ...auth
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const action = async () => {
    switch (message?.type) {
      case "QUIZPILOT_SCAN_ALL_QUESTIONS":
        return scanAllQuestions();
      case "QUIZPILOT_ANALYZE_ALL_QUESTIONS":
        return analyzeAllQuestions();
      case "QUIZPILOT_ONE_CLICK_SOLVE": {
        const scanResult = await scanAllQuestions();
        const solveResult = await analyzeAllQuestions({
          scannedQuestions: scanResult.scannedQuestions,
          showOnPage: true
        });
        return { ...scanResult, ...solveResult };
      }
      case "QUIZPILOT_SIGN_IN_GOOGLE":
        return { userProfile: await signInWithGoogle() };
      case "QUIZPILOT_SIGN_OUT":
        return signOut();
      case "QUIZPILOT_GET_AUTH_STATE":
        return getAuthState();
      case "QUIZPILOT_GET_STATE":
        return getCurrentState();
      case "QUIZPILOT_CLEAR_HIGHLIGHT": {
        const tab = await getActiveTab();
        await sendToContent(tab.id, { type: "QUIZPILOT_CLEAR_HIGHLIGHT" });
        return { cleared: true };
      }
      case "QUIZPILOT_BACKEND_HEALTH": {
        const urls = await getBackendUrls();
        const checks = [];
        for (const url of urls) {
          checks.push({ url, status: await probeBackendHealth(url) });
        }
        return { checks };
      }
      default:
        throw new Error("Unsupported action.");
    }
  };

  action()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "Unexpected error." }));

  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["backendUrl", "backendUrlOverride"]);
  if (!existing.backendUrlOverride && existing.backendUrl) {
    const fallbackUrl = getConfigValue("BACKEND_URL", "http://localhost:10000");
    if (existing.backendUrl !== fallbackUrl) {
      await chrome.storage.local.set({ backendUrlOverride: existing.backendUrl });
    }
  }
  if (existing.backendUrl) {
    await chrome.storage.local.remove("backendUrl");
  }
});
