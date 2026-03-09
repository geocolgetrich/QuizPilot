const OVERLAY_ID = "qp-floating-overlay";
const PANEL_CLASS = "qp-question-suggestion-panel";
const LAUNCHER_ID = "qp-mini-launcher";

let lastScans = [];
let suggestionPanelNodes = [];
let injectedStyleTag = null;

function canonicalQuestionKey(text) {
  return normalizeWhitespace(String(text || ""))
    .replace(/^\s*\d+\s*[\).:-]\s*/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function ensureStyles() {
  if (injectedStyleTag) {
    return;
  }

  injectedStyleTag = document.createElement("style");
  injectedStyleTag.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      max-width: 320px;
      padding: 10px 12px;
      border-radius: 12px;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
      opacity: 0;
      transform: translateY(10px);
      pointer-events: none;
      transition: opacity 140ms ease, transform 140ms ease;
    }
    #${OVERLAY_ID}.visible {
      opacity: 0.96;
      transform: translateY(0);
    }
    .${PANEL_CLASS} {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin: 4px 0 6px;
      padding: 2px 6px;
      border: 1px solid rgba(71, 85, 105, 0.35);
      border-radius: 999px;
      background: rgba(241, 245, 249, 0.8);
      color: #334155;
      font: 11px/1.2 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif;
      opacity: 0.65;
      cursor: pointer;
    }
    .${PANEL_CLASS} .qp-title {
      font-weight: 600;
    }
    .${PANEL_CLASS} .qp-answer {
      display: none;
      font-weight: 500;
    }
    .${PANEL_CLASS}.qp-open .qp-answer {
      display: inline;
    }
    #${LAUNCHER_ID} {
      position: fixed;
      right: 14px;
      bottom: 88px;
      z-index: 2147483646;
      width: 34px;
      height: 34px;
      border-radius: 999px;
      border: 1px solid rgba(15, 23, 42, 0.18);
      background:
        radial-gradient(circle at 30% 30%, rgba(255, 255, 255, 0.9), rgba(241, 245, 249, 0.92) 48%, rgba(226, 232, 240, 0.95) 100%);
      color: #0f172a;
      font: 700 11px/1 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif;
      letter-spacing: 0.3px;
      opacity: 0.82;
      cursor: pointer;
      box-shadow:
        0 4px 12px rgba(15, 23, 42, 0.14),
        inset 0 1px 0 rgba(255, 255, 255, 0.7);
      backdrop-filter: blur(3px);
      transition: transform 120ms ease, opacity 120ms ease, box-shadow 120ms ease;
    }
    #${LAUNCHER_ID}:hover {
      opacity: 1;
      transform: translateY(-1px);
      box-shadow:
        0 8px 16px rgba(15, 23, 42, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.78);
    }
  `;

  document.documentElement.appendChild(injectedStyleTag);
}

function ensureLauncher() {
  ensureStyles();
  if (document.getElementById(LAUNCHER_ID)) {
    return;
  }

  const launcher = document.createElement("button");
  launcher.id = LAUNCHER_ID;
  launcher.type = "button";
  launcher.textContent = "qp";
  launcher.title = "QuizPilot: scan and solve all";
  launcher.addEventListener("click", async () => {
    try {
      showOverlay("Scanning and solving all questions...");
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "QUIZPILOT_ONE_CLICK_SOLVE" }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || "One-click solve failed."));
            return;
          }
          resolve(response.data);
        });
      });
    } catch (error) {
      showOverlay(error?.message || "One-click solve failed.", "error");
    }
  });

  document.documentElement.appendChild(launcher);
}

function isVisible(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return false;
  }
  return true;
}

function normalizeWhitespace(input) {
  return (input || "").replace(/\s+/g, " ").trim();
}

function cleanOptionText(text) {
  return normalizeWhitespace(text).replace(/^[A-H][\).:-]\s+/i, "");
}

function getTextFromElement(element) {
  if (!element) {
    return "";
  }
  return normalizeWhitespace(element.innerText || element.textContent || "");
}

function uniqueByText(optionEntries) {
  const seen = new Set();
  const result = [];
  for (const entry of optionEntries) {
    const key = entry.text.toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function getVisibleContainers() {
  const selectors = "main, form, section, article, [role='main'], [role='dialog'], div";
  return Array.from(document.querySelectorAll(selectors)).filter((element) => {
    if (!isVisible(element)) {
      return false;
    }

    const text = getTextFromElement(element);
    if (text.length < 20 || text.length > 6000) {
      return false;
    }

    const optionsCount = element.querySelectorAll(
      "input[type='radio'], input[type='checkbox'], [role='radio'], [role='option'], label, li, button, .option, .answer, .choice"
    ).length;
    return optionsCount >= 1 || text.includes("?");
  });
}

function scoreContainer(container) {
  let score = 0;
  const text = getTextFromElement(container);
  if (text.includes("?")) {
    score += 3;
  }

  const radioCount = container.querySelectorAll("input[type='radio'], [role='radio']").length;
  if (radioCount >= 2) {
    score += 4;
  }

  const optionLikeCount = container.querySelectorAll(
    "label, li, button, [role='option'], .option, .answer, .choice"
  ).length;
  if (optionLikeCount >= 2 && optionLikeCount <= 12) {
    score += 2;
  }

  return score;
}

function extractQuestionNumber(questionText) {
  const match = String(questionText || "").match(/^\s*(\d+)\s*[\).:-]\s+/);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

function isLikelyQuestionText(text) {
  const normalized = normalizeWhitespace(text || "");
  if (normalized.length < 12 || normalized.length > 500) {
    return false;
  }
  if (!normalized.includes("?")) {
    return false;
  }

  // Sentence-like question with enough words.
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 4) {
    return false;
  }

  // Reject obvious non-question UI snippets.
  const low = normalized.toLowerCase();
  const blocked = [
    "subscribe?",
    "profile?",
    "playlist?",
    "quizzes?",
    "start quiz?",
    "featured quiz?",
    "more quiz info?",
    "last updated?",
    "rate?"
  ];
  if (blocked.some((token) => low.includes(token))) {
    return false;
  }

  // Must look like a normal question sentence.
  const hasQuestionWord = /\b(what|which|who|when|where|why|how|true|false|select|choose|is|are|does|do|can)\b/i.test(
    normalized
  );
  const hasSentencePattern = /^[\d\)\.\-\s]*[A-Z].+\?$/.test(normalized);
  return hasQuestionWord || hasSentencePattern;
}

function getQuestionNode(container) {
  const preferredSelectors = [
    "h1",
    "h2",
    "h3",
    "h4",
    "legend",
    "[role='heading']",
    "p",
    ".question",
    "[data-question]"
  ];

  for (const selector of preferredSelectors) {
    const nodes = Array.from(container.querySelectorAll(selector));
    for (const node of nodes) {
      if (!isVisible(node)) {
        continue;
      }
      const text = getTextFromElement(node);
      if (isLikelyQuestionText(text)) {
        return node;
      }
    }
  }

  return null;
}

function extractQuestionText(container) {
  const questionNode = getQuestionNode(container);
  if (questionNode) {
    return getTextFromElement(questionNode);
  }

  const fallback = getTextFromElement(container)
    .split(/\n|\./)
    .find((part) => part.trim().length > 12);
  return normalizeWhitespace(fallback || "");
}

function findLabelForInput(input, container) {
  if (!input) {
    return null;
  }

  if (input.id) {
    const explicit = container.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (explicit && isVisible(explicit)) {
      return explicit;
    }
  }

  const wrapped = input.closest("label");
  if (wrapped && isVisible(wrapped)) {
    return wrapped;
  }

  const nearby = input.parentElement;
  if (nearby && isVisible(nearby)) {
    return nearby;
  }

  return null;
}

function extractOptions(container, questionText) {
  const rawOptions = [];

  const choiceInputs = Array.from(
    container.querySelectorAll("input[type='radio'], input[type='checkbox']")
  );
  for (const input of choiceInputs) {
    const labelNode = findLabelForInput(input, container);
    const text = cleanOptionText(getTextFromElement(labelNode));
    if (text.length >= 1 && text.length <= 240 && text !== questionText) {
      rawOptions.push({ text, element: labelNode || input });
    }
  }

  if (rawOptions.length < 2) {
    const genericSelectors =
      "[role='radio'], [role='option'], label, li, button, .option, .answer, .choice";
    const candidates = Array.from(container.querySelectorAll(genericSelectors));

    for (const candidate of candidates) {
      if (!isVisible(candidate)) {
        continue;
      }

      const text = cleanOptionText(getTextFromElement(candidate));
      if (text.length < 1 || text.length > 240 || text === questionText || text.length < 2) {
        continue;
      }

      const nestedOptionCount = candidate.querySelectorAll(
        "label, li, button, [role='option'], [role='radio']"
      ).length;
      if (nestedOptionCount > 3) {
        continue;
      }

      rawOptions.push({ text, element: candidate });
    }
  }

  if (rawOptions.length < 2) {
    const blockCandidates = Array.from(container.querySelectorAll("div, button, li, p"));
    for (const candidate of blockCandidates) {
      if (!isVisible(candidate) || candidate.children.length > 4) {
        continue;
      }

      const text = cleanOptionText(getTextFromElement(candidate));
      if (!text || text === questionText || text.length < 1 || text.length > 120) {
        continue;
      }

      const childOptionLike = Array.from(candidate.children).filter((child) => {
        const childText = cleanOptionText(getTextFromElement(child));
        return childText.length >= 1 && childText.length <= 120;
      }).length;
      if (childOptionLike >= 2) {
        continue;
      }

      rawOptions.push({ text, element: candidate });
    }
  }

  const uniqueOptions = uniqueByText(rawOptions).filter((entry) => entry.text !== questionText);
  return uniqueOptions.slice(0, 10);
}

function showOverlay(message, type = "info") {
  ensureStyles();

  let overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    document.documentElement.appendChild(overlay);
  }

  overlay.textContent = `QuizPilot: ${message}`;
  if (type === "error") {
    overlay.style.background = "#7f1d1d";
  } else if (type === "success") {
    overlay.style.background = "#166534";
  } else {
    overlay.style.background = "#0f172a";
  }

  overlay.classList.add("visible");

  clearTimeout(showOverlay.timeoutId);
  showOverlay.timeoutId = setTimeout(() => {
    overlay.classList.remove("visible");
  }, 2200);
}

function clearSuggestionPanel() {
  for (const panel of suggestionPanelNodes) {
    if (panel?.isConnected) {
      panel.remove();
    }
  }
  suggestionPanelNodes = [];
}

function parseContainerToQuestion(container, id) {
  const questionNode = getQuestionNode(container);
  const questionText = questionNode ? getTextFromElement(questionNode) : extractQuestionText(container);
  const options = extractOptions(container, questionText);
  return buildQuestionRecord({
    id,
    questionText,
    options,
    containerNode: container,
    questionNode
  });
}

function buildQuestionRecord({ id, questionText, options, containerNode, questionNode }) {
  const displayNumber = extractQuestionNumber(questionText);

  if (!questionText || questionText.length < 8 || !Array.isArray(options) || options.length < 2) {
    return null;
  }
  // Strong guardrail to prevent non-quiz noise explosions:
  // keep only numbered question lines like "4. ...?".
  if (!Number.isInteger(displayNumber)) {
    return null;
  }
  const answerLikeCount = options.filter((opt) => {
    const text = String(opt?.text || opt || "").trim();
    return text.length >= 1 && text.length <= 180;
  }).length;
  if (answerLikeCount < 2 || options.length > 8) return null;

  return {
    id,
    displayNumber,
    questionText,
    options: options.map((entry) => entry.text),
    pageTitle: normalizeWhitespace(document.title || ""),
    hostname: window.location.hostname,
    refs: {
      containerNode,
      questionNode,
      optionAnchorNode: options[0]?.element || null
    }
  };
}

function findQuestionNodes() {
  const selectors = "h1, h2, h3, h4, legend, p, .question, [data-question], [class*='question'], [id*='question']";
  return Array.from(document.querySelectorAll(selectors)).filter((node) => {
    if (!isVisible(node)) {
      return false;
    }
    const text = getTextFromElement(node);
    if (!isLikelyQuestionText(text)) {
      return false;
    }

    // Avoid duplicated parent/child captures of identical question text.
    const childQuestion = Array.from(node.children || []).some((child) =>
      isLikelyQuestionText(getTextFromElement(child))
    );
    if (childQuestion) {
      return false;
    }

    return true;
  });
}

function parseQuestionFromNode(questionNode, id) {
  const questionText = getTextFromElement(questionNode);
  let ancestor = questionNode.parentElement;
  let depth = 0;

  while (ancestor && depth < 8) {
    const options = extractOptions(ancestor, questionText);
    const record = buildQuestionRecord({
      id,
      questionText,
      options,
      containerNode: ancestor,
      questionNode
    });
    if (record) {
      return record;
    }
    ancestor = ancestor.parentElement;
    depth += 1;
  }

  return null;
}

function scanAllQuestions() {
  showOverlay("Scanning all visible questions...");
  clearSuggestionPanel();

  const rankedContainers = getVisibleContainers()
    .map((container) => ({ container, score: scoreContainer(container) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.container);

  const dedupe = new Set();
  const usedNumbers = new Set();
  const results = [];
  const MAX_RESULTS = 25;

  const questionNodes = findQuestionNodes();
  for (const questionNode of questionNodes) {
    const parsed = parseQuestionFromNode(questionNode, results.length);
    if (!parsed) {
      continue;
    }
    const key = canonicalQuestionKey(parsed.questionText);
    if (dedupe.has(key)) {
      continue;
    }
    if (Number.isInteger(parsed.displayNumber) && usedNumbers.has(parsed.displayNumber)) {
      continue;
    }
    dedupe.add(key);
    if (Number.isInteger(parsed.displayNumber)) {
      usedNumbers.add(parsed.displayNumber);
    }
    results.push(parsed);
    if (results.length >= MAX_RESULTS) {
      break;
    }
  }

  for (const container of rankedContainers) {
    const parsed = parseContainerToQuestion(container, results.length);
    if (!parsed) {
      continue;
    }

    const key = canonicalQuestionKey(parsed.questionText);
    if (dedupe.has(key)) {
      continue;
    }
    if (Number.isInteger(parsed.displayNumber) && usedNumbers.has(parsed.displayNumber)) {
      continue;
    }

    dedupe.add(key);
    if (Number.isInteger(parsed.displayNumber)) {
      usedNumbers.add(parsed.displayNumber);
    }
    results.push(parsed);
    if (results.length >= MAX_RESULTS) {
      break;
    }
  }

  if (results.length === 0) {
    throw new Error("Could not find visible multiple-choice questions on this page.");
  }

  results.sort((a, b) => (a.displayNumber || 9999) - (b.displayNumber || 9999));
  lastScans = results;
  showOverlay(`Detected ${results.length} question(s).`, "success");

  return {
    questions: results.map((item) => ({
      id: item.id,
      displayNumber: item.displayNumber,
      questionText: item.questionText,
      options: item.options,
      pageTitle: item.pageTitle,
      hostname: item.hostname
    }))
  };
}

function applySuggestionPanelForQuestion(answer) {
  const target = lastScans.find((item) => item.id === answer.id);
  if (!target || !target.refs?.containerNode?.isConnected) {
    return;
  }

  const answerText = normalizeWhitespace(answer?.bestAnswerText || "");
  if (!answerText) {
    return;
  }

  const panel = document.createElement("div");
  panel.className = PANEL_CLASS;
  panel.innerHTML = `<span class="qp-title">qp</span><span class="qp-answer">${answerText}</span>`;
  panel.addEventListener("click", () => {
    panel.classList.toggle("qp-open");
  });

  if (target.refs.questionNode && target.refs.questionNode.parentElement) {
    target.refs.questionNode.insertAdjacentElement("afterend", panel);
  } else if (target.refs.optionAnchorNode && target.refs.optionAnchorNode.parentElement) {
    target.refs.optionAnchorNode.insertAdjacentElement("beforebegin", panel);
  } else {
    target.refs.containerNode.prepend(panel);
  }

  suggestionPanelNodes.push(panel);
}

function applySuggestionPanelsForAll(answers) {
  clearSuggestionPanel();
  ensureStyles();

  for (const answer of answers) {
    applySuggestionPanelForQuestion(answer);
  }

  if (suggestionPanelNodes.length === 0) {
    throw new Error("No answer panels could be displayed. Re-scan questions.");
  }
  suggestionPanelNodes[0].scrollIntoView({ block: "nearest", behavior: "smooth" });
  showOverlay(`Displayed answers for ${suggestionPanelNodes.length} questions.`, "success");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    switch (message?.type) {
      case "QUIZPILOT_SCAN_ALL": {
        const data = scanAllQuestions();
        sendResponse({ ok: true, data });
        return;
      }
      case "QUIZPILOT_SHOW_ALL_ANSWERS": {
        const answers = Array.isArray(message?.payload?.answers)
          ? message.payload.answers
          : [];
        if (answers.length === 0) {
          throw new Error("No answers available to display.");
        }
        applySuggestionPanelsForAll(answers);
        sendResponse({ ok: true, data: { shown: true } });
        return;
      }
      case "QUIZPILOT_SHOW_PARTIAL_ANSWER": {
        const answer = message?.payload?.answer;
        if (!answer || typeof answer !== "object") {
          throw new Error("No partial answer provided.");
        }
        applySuggestionPanelForQuestion(answer);
        showOverlay("Answer added.", "success");
        sendResponse({ ok: true, data: { shown: true } });
        return;
      }
      case "QUIZPILOT_PROGRESS": {
        const solved = Number(message?.payload?.solved || 0);
        const total = Number(message?.payload?.total || 0);
        if (total > 0) {
          showOverlay(`Solved ${solved}/${total}...`);
        }
        sendResponse({ ok: true, data: { shown: true } });
        return;
      }
      case "QUIZPILOT_CLEAR_HIGHLIGHT": {
        clearSuggestionPanel();
        showOverlay("Suggestion cleared.");
        sendResponse({ ok: true, data: { cleared: true } });
        return;
      }
      default:
        sendResponse({ ok: false, error: "Unknown content action." });
    }
  } catch (error) {
    showOverlay(error.message || "Unexpected content script error.", "error");
    sendResponse({ ok: false, error: error.message || "Unexpected content script error." });
  }
});

ensureLauncher();
