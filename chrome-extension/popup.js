const scanBtn = document.getElementById("scanBtn");
const highlightBtn = document.getElementById("highlightBtn");
const explainBtn = document.getElementById("explainBtn");
const autoHighlightToggle = document.getElementById("autoHighlightToggle");
const questionCount = document.getElementById("questionCount");
const questionSelect = document.getElementById("questionSelect");

const statusCard = document.getElementById("statusCard");
const statusText = document.getElementById("statusText");
const resultCard = document.getElementById("resultCard");
const bestAnswerText = document.getElementById("bestAnswerText");
const confidenceText = document.getElementById("confidenceText");
const explanationText = document.getElementById("explanationText");
const lowConfidenceNote = document.getElementById("lowConfidenceNote");

const LOW_CONFIDENCE_THRESHOLD = 0.55;

let scannedQuestions = [];
let selectedQuestionId = null;

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

function renderQuestionList(questions, preferredId) {
  scannedQuestions = Array.isArray(questions) ? questions : [];
  questionCount.textContent = String(scannedQuestions.length);
  questionSelect.innerHTML = "";

  if (scannedQuestions.length === 0) {
    questionSelect.disabled = true;
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Scan questions first";
    questionSelect.appendChild(option);
    selectedQuestionId = null;
    return;
  }

  questionSelect.disabled = false;
  for (const question of scannedQuestions) {
    const option = document.createElement("option");
    option.value = String(question.id);
    const preview =
      question.questionText.length > 95
        ? `${question.questionText.slice(0, 95)}...`
        : question.questionText;
    option.textContent = `${question.id + 1}. ${preview}`;
    questionSelect.appendChild(option);
  }

  const targetId =
    Number.isInteger(preferredId) && scannedQuestions.some((item) => item.id === preferredId)
      ? preferredId
      : scannedQuestions[0].id;

  questionSelect.value = String(targetId);
  selectedQuestionId = targetId;
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
    if (Array.isArray(state?.scannedQuestions)) {
      renderQuestionList(state.scannedQuestions, state.selectedQuestionId);
    }
    if (state?.analysis) {
      renderResult(state.analysis);
    }
  } catch {
    // Ignore startup sync issues.
  }
}

questionSelect.addEventListener("change", () => {
  const id = Number(questionSelect.value);
  selectedQuestionId = Number.isInteger(id) ? id : null;
});

autoHighlightToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ autoHighlight: autoHighlightToggle.checked });
  setStatus(autoHighlightToggle.checked ? "Auto-show enabled." : "Auto-show disabled.", "success");
});

scanBtn.addEventListener("click", async () => {
  setButtonsDisabled(true);
  setStatus("Scanning all visible questions...");

  try {
    const data = await sendRuntimeMessage("QUIZPILOT_SCAN_ALL_QUESTIONS");
    renderQuestionList(data.scannedQuestions, data.selectedQuestionId);
    setStatus(`Detected ${data.scannedQuestions.length} question(s).`, "success");
  } catch (error) {
    setStatus(error.message || "Failed to scan questions.", "error");
  } finally {
    setButtonsDisabled(false);
  }
});

highlightBtn.addEventListener("click", async () => {
  setButtonsDisabled(true);
  setStatus("Getting AI answer for selected question...");

  try {
    const questionId = Number.isInteger(selectedQuestionId)
      ? selectedQuestionId
      : Number(questionSelect.value);
    const data = await sendRuntimeMessage("QUIZPILOT_ANALYZE_SELECTED_QUESTION", { questionId });
    renderResult(data.analysis);
    setStatus("AI answer ready and shown beside question.", "success");
  } catch (error) {
    setStatus(error.message || "Failed to analyze selected question.", "error");
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
