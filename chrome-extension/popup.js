const scanBtn = document.getElementById("scanBtn");
const highlightBtn = document.getElementById("highlightBtn");
const explainBtn = document.getElementById("explainBtn");
const autoHighlightToggle = document.getElementById("autoHighlightToggle");

const statusCard = document.getElementById("statusCard");
const statusText = document.getElementById("statusText");
const resultCard = document.getElementById("resultCard");
const bestAnswerText = document.getElementById("bestAnswerText");
const confidenceText = document.getElementById("confidenceText");
const explanationText = document.getElementById("explanationText");
const lowConfidenceNote = document.getElementById("lowConfidenceNote");

const LOW_CONFIDENCE_THRESHOLD = 0.55;

function setStatus(message, type = "info") {
  statusCard.classList.remove("error", "success");
  if (type === "error") {
    statusCard.classList.add("error");
  }
  if (type === "success") {
    statusCard.classList.add("success");
  }
  statusText.textContent = message;
}

function setButtonsDisabled(disabled) {
  scanBtn.disabled = disabled;
  highlightBtn.disabled = disabled;
  explainBtn.disabled = disabled;
}

function renderResult(result) {
  if (!result) {
    resultCard.hidden = true;
    return;
  }

  resultCard.hidden = false;
  bestAnswerText.textContent = result.bestAnswerText || "Unknown";

  const confidence = Number.isFinite(result.confidence) ? result.confidence : 0;
  confidenceText.textContent = `${Math.round(confidence * 100)}%`;
  explanationText.textContent = result.explanation || "No explanation available.";

  lowConfidenceNote.hidden = confidence >= LOW_CONFIDENCE_THRESHOLD;
}

function sendRuntimeMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response || !response.ok) {
        reject(new Error(response?.error || "Unknown extension error."));
        return;
      }

      resolve(response.data);
    });
  });
}

async function init() {
  const stored = await chrome.storage.local.get(["autoHighlight"]);
  autoHighlightToggle.checked = Boolean(stored.autoHighlight);

  try {
    const state = await sendRuntimeMessage("QUIZPILOT_GET_STATE");
    if (state?.analysis) {
      renderResult(state.analysis);
    }
  } catch {
    // Ignore startup sync issues.
  }
}

autoHighlightToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ autoHighlight: autoHighlightToggle.checked });
  setStatus(
    autoHighlightToggle.checked
      ? "Auto-highlight enabled."
      : "Auto-highlight disabled.",
    "success"
  );
});

scanBtn.addEventListener("click", async () => {
  setButtonsDisabled(true);
  setStatus("Scanning current question and calling backend...");

  try {
    const data = await sendRuntimeMessage("QUIZPILOT_SCAN_AND_ANALYZE");
    renderResult(data.analysis);
    setStatus("Question analyzed successfully.", "success");
  } catch (error) {
    setStatus(error.message || "Failed to scan/analyze question.", "error");
  } finally {
    setButtonsDisabled(false);
  }
});

highlightBtn.addEventListener("click", async () => {
  setButtonsDisabled(true);
  setStatus("Applying highlight on the page...");

  try {
    const data = await sendRuntimeMessage("QUIZPILOT_HIGHLIGHT_LAST");
    renderResult(data.analysis);
    setStatus("Best answer highlighted.", "success");
  } catch (error) {
    setStatus(error.message || "No result to highlight yet.", "error");
  } finally {
    setButtonsDisabled(false);
  }
});

explainBtn.addEventListener("click", async () => {
  setButtonsDisabled(true);
  setStatus("Loading explanation...");

  try {
    const data = await sendRuntimeMessage("QUIZPILOT_EXPLAIN_LAST");
    renderResult(data.analysis);
    setStatus("Explanation ready.", "success");
  } catch (error) {
    setStatus(error.message || "No explanation available.", "error");
  } finally {
    setButtonsDisabled(false);
  }
});

init().catch((error) => {
  setStatus(error.message || "Popup initialization failed.", "error");
});
