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

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function sendToContent(tabId, message) {
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
  const stored = await chrome.storage.local.get(["backendUrl"]);
  const backendUrl =
    stored.backendUrl || getConfigValue("BACKEND_URL", "http://localhost:10000");

  const requestBody = {
    questionText: payload.questionText,
    options: payload.options,
    context: {
      pageTitle: payload.pageTitle,
      hostname: payload.hostname
    }
  };

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

  throw new Error(lastError?.message || "Failed to reach backend.");
}

async function scanAndAnalyze() {
  const tab = await getActiveTab();
  const scanData = await sendToContent(tab.id, { type: "QUIZPILOT_SCAN" });

  const analysis = await analyzeQuestion(scanData);
  setTabState(tab.id, { scanData, analysis });

  const { autoHighlight } = await chrome.storage.local.get(["autoHighlight"]);
  if (autoHighlight) {
    await sendToContent(tab.id, {
      type: "QUIZPILOT_HIGHLIGHT",
      payload: { bestAnswerIndex: analysis.bestAnswerIndex }
    });
  }

  return { scanData, analysis };
}

async function highlightLastResult() {
  const tab = await getActiveTab();
  const state = getTabState(tab.id);

  if (!state?.analysis) {
    throw new Error("No analyzed question yet. Run Scan Current Question first.");
  }

  await sendToContent(tab.id, {
    type: "QUIZPILOT_HIGHLIGHT",
    payload: { bestAnswerIndex: state.analysis.bestAnswerIndex }
  });

  return { analysis: state.analysis, scanData: state.scanData };
}

async function explainLastResult() {
  const tab = await getActiveTab();
  const state = getTabState(tab.id);

  if (!state?.analysis) {
    throw new Error("No explanation available yet. Scan a question first.");
  }

  return { analysis: state.analysis, scanData: state.scanData };
}

async function getCurrentState() {
  const tab = await getActiveTab();
  const state = getTabState(tab.id);
  if (!state) {
    return {};
  }

  return {
    analysis: state.analysis,
    scanData: state.scanData,
    updatedAt: state.updatedAt
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const action = async () => {
    switch (message?.type) {
      case "QUIZPILOT_SCAN_AND_ANALYZE":
        return scanAndAnalyze();
      case "QUIZPILOT_HIGHLIGHT_LAST":
        return highlightLastResult();
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
  const existing = await chrome.storage.local.get(["autoHighlight", "backendUrl"]);

  if (typeof existing.autoHighlight === "undefined") {
    await chrome.storage.local.set({ autoHighlight: false });
  }

  if (!existing.backendUrl) {
    const fallbackUrl = getConfigValue("BACKEND_URL", "http://localhost:10000");
    await chrome.storage.local.set({ backendUrl: fallbackUrl });
  }
});
