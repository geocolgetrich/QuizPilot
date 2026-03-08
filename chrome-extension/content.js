const OVERLAY_ID = "qp-floating-overlay";
const PANEL_ID = "qp-question-suggestion-panel";

let lastScans = [];
let suggestionPanelNode = null;
let injectedStyleTag = null;

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
    #${PANEL_ID} {
      margin: 10px 0 12px;
      padding: 10px 12px;
      border: 2px solid #22c55e;
      border-radius: 12px;
      background: #ecfdf5;
      color: #14532d;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif;
    }
    #${PANEL_ID} .qp-title {
      font-weight: 700;
      margin-bottom: 4px;
    }
    #${PANEL_ID} .qp-sub {
      font-size: 12px;
      opacity: 0.9;
      margin-top: 4px;
    }
  `;

  document.documentElement.appendChild(injectedStyleTag);
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

  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  return rect.bottom > 0 && rect.top < viewportHeight && rect.right > 0 && rect.left < viewportWidth;
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
    if (text.length < 30 || text.length > 3000) {
      return false;
    }

    const optionsCount = element.querySelectorAll(
      "input[type='radio'], input[type='checkbox'], [role='radio'], [role='option'], label, li, button, .option, .answer, .choice"
    ).length;
    return optionsCount >= 2;
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

  const rect = container.getBoundingClientRect();
  if (rect.top >= -80 && rect.top <= window.innerHeight * 0.7) {
    score += 1;
  }

  return score;
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
      if (text.length < 12 || text.length > 500) {
        continue;
      }
      if (text.includes("?") || /choose|select|which|what|true|false/i.test(text)) {
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
  if (suggestionPanelNode && suggestionPanelNode.isConnected) {
    suggestionPanelNode.remove();
  }
  suggestionPanelNode = null;
}

function parseContainerToQuestion(container, id) {
  const questionText = extractQuestionText(container);
  const options = extractOptions(container, questionText);

  if (!questionText || questionText.length < 8 || options.length < 2) {
    return null;
  }

  return {
    id,
    questionText,
    options: options.map((entry) => entry.text),
    pageTitle: normalizeWhitespace(document.title || ""),
    hostname: window.location.hostname,
    refs: {
      containerNode: container,
      questionNode: getQuestionNode(container)
    }
  };
}

function scanAllQuestions() {
  showOverlay("Scanning all visible questions...");
  clearSuggestionPanel();

  const rankedContainers = getVisibleContainers()
    .map((container) => ({ container, score: scoreContainer(container) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.container);

  const dedupe = new Set();
  const results = [];

  for (const container of rankedContainers) {
    const parsed = parseContainerToQuestion(container, results.length);
    if (!parsed) {
      continue;
    }

    const key = parsed.questionText.toLowerCase();
    if (dedupe.has(key)) {
      continue;
    }

    dedupe.add(key);
    results.push(parsed);
    if (results.length >= 20) {
      break;
    }
  }

  if (results.length === 0) {
    throw new Error("Could not find visible multiple-choice questions on this page.");
  }

  lastScans = results;
  showOverlay(`Detected ${results.length} question(s).`, "success");

  return {
    questions: results.map((item) => ({
      id: item.id,
      questionText: item.questionText,
      options: item.options,
      pageTitle: item.pageTitle,
      hostname: item.hostname
    }))
  };
}

function applySuggestionPanel(analysis, questionId) {
  clearSuggestionPanel();

  const target = lastScans.find((item) => item.id === questionId);
  if (!target || !target.refs?.containerNode?.isConnected) {
    throw new Error("Selected question is no longer visible. Re-scan questions.");
  }

  const answerText = normalizeWhitespace(analysis?.bestAnswerText || "");
  if (!answerText) {
    throw new Error("No suggested answer text available.");
  }

  ensureStyles();

  const confidence = Number.isFinite(analysis?.confidence)
    ? Math.round(Math.max(0, Math.min(1, analysis.confidence)) * 100)
    : 0;
  const explanation = normalizeWhitespace(analysis?.explanation || "");

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="qp-title">QuizPilot suggestion: ${answerText}</div>
    <div>Confidence: ${confidence}%</div>
    ${explanation ? `<div class="qp-sub">${explanation}</div>` : ""}
  `;

  if (target.refs.questionNode && target.refs.questionNode.parentElement) {
    target.refs.questionNode.insertAdjacentElement("afterend", panel);
  } else {
    target.refs.containerNode.prepend(panel);
  }

  suggestionPanelNode = panel;
  panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  showOverlay("Suggestion shown beside selected question.", "success");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    switch (message?.type) {
      case "QUIZPILOT_SCAN_ALL": {
        const data = scanAllQuestions();
        sendResponse({ ok: true, data });
        return;
      }
      case "QUIZPILOT_SCAN": {
        const data = scanAllQuestions();
        sendResponse({ ok: true, data: data.questions[0] });
        return;
      }
      case "QUIZPILOT_HIGHLIGHT": {
        const analysis = message?.payload?.analysis;
        const questionId = Number(message?.payload?.questionId);
        if (!analysis || typeof analysis !== "object") {
          throw new Error("Invalid analysis payload.");
        }
        if (!Number.isInteger(questionId)) {
          throw new Error("Invalid selected question.");
        }
        applySuggestionPanel(analysis, questionId);
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
