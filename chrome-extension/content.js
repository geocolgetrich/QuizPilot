const OVERLAY_ID = "qp-floating-overlay";
const HIGHLIGHT_CLASS = "qp-suggested-answer";
const BADGE_CLASS = "qp-suggested-badge";

let lastScan = null;
let highlightedNodes = [];
let injectedStyleTag = null;

function ensureStyles() {
  if (injectedStyleTag) {
    return;
  }

  injectedStyleTag = document.createElement("style");
  injectedStyleTag.textContent = `
    .${HIGHLIGHT_CLASS} {
      background: #e8fbe8 !important;
      outline: 3px solid #22c55e !important;
      border-radius: 8px !important;
      box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.15) !important;
      transition: background 140ms ease, outline 140ms ease;
    }
    .${BADGE_CLASS} {
      display: inline-block;
      margin-left: 8px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: #166534;
      color: #ffffff;
      vertical-align: middle;
    }
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

  const verticallyVisible = rect.bottom > 0 && rect.top < viewportHeight;
  const horizontallyVisible = rect.right > 0 && rect.left < viewportWidth;

  return verticallyVisible && horizontallyVisible;
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
      "input[type='radio'], input[type='checkbox'], [role='radio'], [role='option'], label, li, button"
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

function pickBestContainer() {
  const containers = getVisibleContainers();
  let best = null;
  let bestScore = -Infinity;

  for (const container of containers) {
    const score = scoreContainer(container);
    if (score > bestScore) {
      bestScore = score;
      best = container;
    }
  }

  return best;
}

function extractQuestionText(container) {
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
        return text;
      }
    }
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
      if (text.length < 1 || text.length > 240) {
        continue;
      }

      if (text === questionText || text.length < 2) {
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

function clearHighlighting() {
  for (const entry of highlightedNodes) {
    if (entry.optionElement?.classList) {
      entry.optionElement.classList.remove(HIGHLIGHT_CLASS);
    }
    if (entry.badgeNode?.isConnected) {
      entry.badgeNode.remove();
    }
  }
  highlightedNodes = [];
}

function applyHighlight(bestAnswerIndex) {
  clearHighlighting();

  if (!lastScan || !Array.isArray(lastScan.optionNodes) || lastScan.optionNodes.length === 0) {
    throw new Error("No question has been scanned on this page yet.");
  }

  const target = lastScan.optionNodes[bestAnswerIndex];
  if (!target || !target.isConnected) {
    throw new Error("Suggested option is no longer visible. Please re-scan.");
  }

  ensureStyles();

  target.classList.add(HIGHLIGHT_CLASS);

  const badge = document.createElement("span");
  badge.className = BADGE_CLASS;
  badge.textContent = "QuizPilot suggestion";

  target.appendChild(badge);
  highlightedNodes.push({ optionElement: target, badgeNode: badge });

  target.scrollIntoView({ block: "nearest", behavior: "smooth" });
  showOverlay("Best answer highlighted.", "success");
}

function scanQuestion() {
  showOverlay("Scanning visible question...");
  const container = pickBestContainer();

  if (!container) {
    throw new Error("Could not find a visible quiz block. Scroll to the question and try again.");
  }

  const questionText = extractQuestionText(container);
  const options = extractOptions(container, questionText);

  if (!questionText || questionText.length < 8) {
    throw new Error("Detected quiz block but question text is unclear.");
  }

  if (options.length < 2) {
    throw new Error("Detected question text but not enough answer options.");
  }

  lastScan = {
    questionText,
    options,
    optionNodes: options.map((entry) => entry.element),
    scannedAt: Date.now()
  };

  showOverlay(`Detected ${options.length} options.`, "success");

  return {
    questionText,
    options: options.map((entry) => entry.text),
    pageTitle: normalizeWhitespace(document.title || ""),
    hostname: window.location.hostname
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    switch (message?.type) {
      case "QUIZPILOT_SCAN": {
        clearHighlighting();
        const data = scanQuestion();
        sendResponse({ ok: true, data });
        return;
      }
      case "QUIZPILOT_HIGHLIGHT": {
        const bestAnswerIndex = Number(message?.payload?.bestAnswerIndex);
        if (!Number.isInteger(bestAnswerIndex) || bestAnswerIndex < 0) {
          throw new Error("Invalid bestAnswerIndex value.");
        }
        applyHighlight(bestAnswerIndex);
        sendResponse({ ok: true, data: { highlighted: true } });
        return;
      }
      case "QUIZPILOT_CLEAR_HIGHLIGHT": {
        clearHighlighting();
        showOverlay("Highlight cleared.");
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
