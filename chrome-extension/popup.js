const scanBtn = document.getElementById("scanBtn");
const solveAllBtn = document.getElementById("highlightBtn");
const autoHighlightToggle = document.getElementById("autoHighlightToggle");
const questionCount = document.getElementById("questionCount");
const authStatus = document.getElementById("authStatus");
const creditsText = document.getElementById("creditsText");
const signInBtn = document.getElementById("signInBtn");
const signOutBtn = document.getElementById("signOutBtn");

const statusCard = document.getElementById("statusCard");
const statusText = document.getElementById("statusText");

function setStatus(message, type = "info") {
  statusCard.classList.remove("error", "success");
  if (type === "error") statusCard.classList.add("error");
  if (type === "success") statusCard.classList.add("success");
  statusText.textContent = message;
}

function setButtonsDisabled(disabled) {
  scanBtn.disabled = disabled;
  solveAllBtn.disabled = disabled;
  signInBtn.disabled = disabled;
  signOutBtn.disabled = disabled;
}

function renderQuestionList(questions) {
  const list = Array.isArray(questions) ? questions : [];
  questionCount.textContent = String(list.length);
}

function renderAuthState(state) {
  const isAuthenticated = Boolean(state?.isAuthenticated);
  const user = state?.userProfile || null;

  authStatus.textContent = isAuthenticated
    ? user?.email || "Signed in"
    : "Not signed in";
  creditsText.textContent = isAuthenticated
    ? String(user?.creditsRemaining ?? 0)
    : "-";

  signInBtn.hidden = isAuthenticated;
  signOutBtn.hidden = !isAuthenticated;
  scanBtn.disabled = !isAuthenticated;
  solveAllBtn.disabled = !isAuthenticated;
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

async function refreshState() {
  const [state, auth] = await Promise.all([
    sendRuntimeMessage("QUIZPILOT_GET_STATE"),
    sendRuntimeMessage("QUIZPILOT_GET_AUTH_STATE")
  ]);
  renderQuestionList(state?.scannedQuestions || []);
  renderAuthState(auth);
}

async function init() {
  const stored = await chrome.storage.local.get(["autoHighlight"]);
  autoHighlightToggle.checked = Boolean(stored.autoHighlight);
  await refreshState();
}

autoHighlightToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ autoHighlight: autoHighlightToggle.checked });
  setStatus(autoHighlightToggle.checked ? "Auto-show enabled." : "Auto-show disabled.", "success");
});

signInBtn.addEventListener("click", async () => {
  setButtonsDisabled(true);
  setStatus("Signing in with Google...");
  try {
    const data = await sendRuntimeMessage("QUIZPILOT_SIGN_IN_GOOGLE");
    renderAuthState({ isAuthenticated: true, userProfile: data.userProfile });
    setStatus("Signed in successfully.", "success");
  } catch (error) {
    setStatus(error.message || "Google sign-in failed.", "error");
  } finally {
    setButtonsDisabled(false);
  }
});

signOutBtn.addEventListener("click", async () => {
  setButtonsDisabled(true);
  setStatus("Signing out...");
  try {
    await sendRuntimeMessage("QUIZPILOT_SIGN_OUT");
    renderAuthState({ isAuthenticated: false, userProfile: null });
    setStatus("Signed out.", "success");
  } catch (error) {
    setStatus(error.message || "Sign-out failed.", "error");
  } finally {
    setButtonsDisabled(false);
  }
});

scanBtn.addEventListener("click", async () => {
  setButtonsDisabled(true);
  setStatus("Scanning all visible quiz questions...");
  try {
    const data = await sendRuntimeMessage("QUIZPILOT_SCAN_ALL_QUESTIONS");
    renderQuestionList(data.scannedQuestions);
    setStatus(`Detected ${data.scannedQuestions.length} quiz question(s).`, "success");
  } catch (error) {
    setStatus(error.message || "Failed to scan questions.", "error");
  } finally {
    setButtonsDisabled(false);
  }
});

solveAllBtn.addEventListener("click", async () => {
  setButtonsDisabled(true);
  setStatus("Getting AI answers for all detected questions...");
  try {
    const data = await sendRuntimeMessage("QUIZPILOT_ANALYZE_ALL_QUESTIONS");
    setStatus(`Placed discreet answers on page for ${data.answers.length} question(s).`, "success");
    await refreshState();
  } catch (error) {
    setStatus(error.message || "Failed to analyze questions.", "error");
  } finally {
    setButtonsDisabled(false);
  }
});

init().catch((error) => {
  setStatus(error.message || "Popup initialization failed.", "error");
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "QUIZPILOT_PROGRESS") return;

  const solved = Number(message?.payload?.solved || 0);
  const total = Number(message?.payload?.total || 0);
  if (total > 0) {
    setStatus(`Solving questions... ${solved}/${total}`, "info");
  }
  if (message?.payload?.done && total > 0) {
    setStatus(`Discreet answers placed for ${solved}/${total} question(s).`, "success");
    refreshState().catch(() => {});
  }
});
