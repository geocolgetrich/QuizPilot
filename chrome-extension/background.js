importScripts("config.js");

const tabState = new Map();

function getConfigValue(key, fallback) {
  const config = globalThis.QUIZPILOT_CONFIG || {};
  return config[key] ?? fallback;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    throw new Error("No active tab found.");
  }
  return tab;
}

function setTabState(tabId, patch) {
  const current = tabState.get(tabId) || {};
  tabState.set(tabId, { ...current, ...patch, updatedAt: Date.now() });
}

function getTabState(tabId) {
  return tabState.get(tabId) || null;
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

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });

    return trySend();
  }
}

function clampConfidence(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

async function analyzeQuestion(payload) {
  const timeoutMs = getConfigValue("REQUEST_TIMEOUT_MS", 20000);
  const maxRetries = getConfigValue("MAX_RETRIES", 1);
  const stored = await chrome.storage.local.get(["backendUrlOverride"]);
  const configBackendUrl = getConfigValue("BACKEND_URL", "http://localhost:10000");
  const urlCandidates = [];
  if (stored.backendUrlOverride) {
    const override = String(stored.backendUrlOverride).trim();
    const configIsRemote = /^https:\/\//i.test(configBackendUrl);
    const overrideIsLocalhost = /^http:\/\/localhost(?::\d+)?/i.test(override);
    // Ignore stale localhost override when config points to remote backend.
    if (!(configIsRemote && overrideIsLocalhost)) {
      urlCandidates.push(override);
    }
  }
  if (!urlCandidates.includes(configBackendUrl)) {
    urlCandidates.push(configBackendUrl);
  }

  const requestBody = {
    questionText: payload.questionText,
    options: payload.options,
    context: {
      pageTitle: payload.pageTitle,
      hostname: payload.hostname
    }
  };

  const attemptErrors = [];

  for (const backendUrl of urlCandidates) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await withTimeout(
          fetch(`${backendUrl}/analyze-question`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody)
          }),
          timeoutMs,
          "Backend request timed out."
        );

        if (!response.ok) {
          let message = `Backend returned ${response.status}`;
          try {
            const data = await response.json();
            if (data?.error) {
              message = data.error;
            }
          } catch {
            // Ignore non-JSON responses.
          }
          throw new Error(message);
        }

        const result = await response.json();
        result.confidence = clampConfidence(result.confidence);
        return result;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
        }
      }
    }

    const baseMessage = lastError?.message || "unknown backend error";
    if (/Failed to fetch/i.test(baseMessage)) {
      const healthError = await probeBackendHealth(backendUrl);
      attemptErrors.push(`${backendUrl} -> ${healthError}`);
    } else {
      attemptErrors.push(`${backendUrl} -> ${baseMessage}`);
    }
  }

  throw new Error(`All backend URLs failed: ${attemptErrors.join(" | ")}`);
}

async function probeBackendHealth(backendUrl) {
  try {
    const response = await withTimeout(
      fetch(`${backendUrl}/health`, {
        method: "GET",
        headers: { Accept: "application/json" }
      }),
      12000,
      "Health check timed out."
    );

    if (!response.ok) {
      return `Backend is reachable but /health returned ${response.status}.`;
    }

    return "Backend is reachable, but browser blocked request to /analyze-question (likely CORS or extension host permission mismatch).";
  } catch (error) {
    return `Backend health probe failed: ${error.message || "unknown error"}. Check BACKEND_URL and Render deployment.`;
  }
}

async function scanAllQuestions() {
  const tab = await getActiveTab();
  const data = await sendToContent(tab.id, { type: "QUIZPILOT_SCAN_ALL" });

  setTabState(tab.id, {
    scannedQuestions: data.questions,
    selectedQuestionId: data.questions[0]?.id ?? null,
    analysis: null
  });

  return {
    scannedQuestions: data.questions,
    selectedQuestionId: data.questions[0]?.id ?? null
  };
}

async function analyzeSelectedQuestion(questionId) {
  const tab = await getActiveTab();
  const state = getTabState(tab.id);
  const scannedQuestions = state?.scannedQuestions || [];

  if (!Array.isArray(scannedQuestions) || scannedQuestions.length === 0) {
    throw new Error("No scanned questions yet. Run Scan All Questions first.");
  }

  const selectedId = Number.isInteger(questionId) ? questionId : scannedQuestions[0].id;
  const selectedQuestion = scannedQuestions.find((item) => item.id === selectedId);
  if (!selectedQuestion) {
    throw new Error("Selected question no longer available. Scan again.");
  }

  const analysis = await analyzeQuestion(selectedQuestion);
  setTabState(tab.id, { analysis, selectedQuestionId: selectedId });

  const { autoHighlight } = await chrome.storage.local.get(["autoHighlight"]);
  if (autoHighlight) {
    await sendToContent(tab.id, {
      type: "QUIZPILOT_HIGHLIGHT",
      payload: { analysis, questionId: selectedId }
    });
  }

  return { analysis, selectedQuestionId: selectedId };
}

async function showLastResult() {
  const tab = await getActiveTab();
  const state = getTabState(tab.id);
  if (!state?.analysis || !Number.isInteger(state?.selectedQuestionId)) {
    throw new Error("No analyzed question yet.");
  }

  await sendToContent(tab.id, {
    type: "QUIZPILOT_HIGHLIGHT",
    payload: { analysis: state.analysis, questionId: state.selectedQuestionId }
  });

  return { analysis: state.analysis, selectedQuestionId: state.selectedQuestionId };
}

async function explainLastResult() {
  const tab = await getActiveTab();
  const state = getTabState(tab.id);
  if (!state?.analysis) {
    throw new Error("No explanation available yet. Analyze a question first.");
  }
  return { analysis: state.analysis, selectedQuestionId: state.selectedQuestionId };
}

async function getCurrentState() {
  const tab = await getActiveTab();
  const state = getTabState(tab.id) || {};
  return {
    scannedQuestions: state.scannedQuestions || [],
    selectedQuestionId: state.selectedQuestionId ?? null,
    analysis: state.analysis || null,
    updatedAt: state.updatedAt
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const action = async () => {
    switch (message?.type) {
      case "QUIZPILOT_SCAN_ALL_QUESTIONS":
        return scanAllQuestions();
      case "QUIZPILOT_ANALYZE_SELECTED_QUESTION":
        return analyzeSelectedQuestion(Number(message?.payload?.questionId));
      case "QUIZPILOT_HIGHLIGHT_LAST":
        return showLastResult();
      case "QUIZPILOT_EXPLAIN_LAST":
        return explainLastResult();
      case "QUIZPILOT_GET_STATE":
        return getCurrentState();
      case "QUIZPILOT_CLEAR_HIGHLIGHT": {
        const tab = await getActiveTab();
        await sendToContent(tab.id, { type: "QUIZPILOT_CLEAR_HIGHLIGHT" });
        return { cleared: true };
      }
      default:
        throw new Error("Unsupported action.");
    }
  };

  action()
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) =>
      sendResponse({ ok: false, error: error.message || "Unexpected error." })
    );

  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([
    "autoHighlight",
    "backendUrl",
    "backendUrlOverride"
  ]);

  if (typeof existing.autoHighlight === "undefined") {
    await chrome.storage.local.set({ autoHighlight: false });
  }

  if (!existing.backendUrlOverride && existing.backendUrl) {
    const fallbackUrl = getConfigValue("BACKEND_URL", "http://localhost:10000");
    if (existing.backendUrl !== fallbackUrl) {
      await chrome.storage.local.set({ backendUrlOverride: existing.backendUrl });
    }
  }

  // Clean up stale localhost override when config now points to remote backend.
  if (existing.backendUrlOverride) {
    const configBackendUrl = getConfigValue("BACKEND_URL", "http://localhost:10000");
    const configIsRemote = /^https:\/\//i.test(configBackendUrl);
    const overrideIsLocalhost = /^http:\/\/localhost(?::\d+)?/i.test(
      String(existing.backendUrlOverride).trim()
    );
    if (configIsRemote && overrideIsLocalhost) {
      await chrome.storage.local.remove("backendUrlOverride");
    }
  }

  if (existing.backendUrl) {
    await chrome.storage.local.remove("backendUrl");
  }
});
