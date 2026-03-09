const { sanitizeText } = require("./validation");

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 25000);
const MODEL_CACHE_TTL_MS = Number(process.env.GEMINI_MODEL_CACHE_TTL_MS || 5 * 60 * 1000);

let cachedModelNames = [];
let cachedAt = 0;

function extractModelText(responseJson) {
  const candidate = responseJson?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function stripCodeFences(text) {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return "";
  }
  return text.slice(start, end + 1);
}

function normalizeModelName(name) {
  const normalized = sanitizeText(name);
  return normalized.replace(/^models\//i, "");
}

function shouldUseCache() {
  return cachedModelNames.length > 0 && Date.now() - cachedAt < MODEL_CACHE_TTL_MS;
}

async function listAvailableGenerateModels(apiKey) {
  if (shouldUseCache()) {
    return cachedModelNames;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`ListModels failed (${response.status}): ${sanitizeText(text).slice(0, 300)}`);
    }

    const data = await response.json();
    const models = Array.isArray(data?.models) ? data.models : [];
    const available = models
      .filter((item) =>
        Array.isArray(item?.supportedGenerationMethods) &&
        item.supportedGenerationMethods.includes("generateContent")
      )
      .map((item) => normalizeModelName(item?.name))
      .filter(Boolean);

    if (available.length === 0) {
      throw new Error("ListModels returned no models that support generateContent.");
    }

    cachedModelNames = available;
    cachedAt = Date.now();
    return available;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("ListModels timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
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

function normalizeModelOutput(parsed, options) {
  let bestAnswerIndex = Number.isInteger(parsed?.bestAnswerIndex) ? parsed.bestAnswerIndex : -1;
  const bestAnswerTextRaw = sanitizeText(parsed?.bestAnswerText || "");
  let confidence = clampConfidence(Number(parsed?.confidence));

  if (bestAnswerIndex < 0 || bestAnswerIndex >= options.length) {
    if (bestAnswerTextRaw) {
      const matchedIndex = options.findIndex(
        (option) => option.toLowerCase() === bestAnswerTextRaw.toLowerCase()
      );
      if (matchedIndex >= 0) {
        bestAnswerIndex = matchedIndex;
      }
    }
  }

  if (bestAnswerIndex < 0 || bestAnswerIndex >= options.length) {
    bestAnswerIndex = 0;
    confidence = Math.min(confidence || 0.25, 0.45);
  }

  const bestAnswerText = options[bestAnswerIndex];

  return {
    bestAnswerIndex,
    bestAnswerText,
    confidence
  };
}

function buildPrompt({ questionText, options, context }) {
  const formattedOptions = options.map((option, index) => `${index}. ${option}`).join("\n");

  return `You are assisting with study and revision in a user-authorized practice quiz context.
Read the question and options, then choose exactly one best answer.
If uncertain, still pick the most likely option and set a lower confidence.

Return ONLY strict JSON with this exact schema:
{
  "bestAnswerIndex": number,
  "bestAnswerText": string,
  "confidence": number
}

Rules:
- bestAnswerIndex must be the zero-based index from the provided options.
- confidence must be between 0 and 1.
- No markdown, no code fences, no extra keys.

Context:
- hostname: ${context.hostname || "unknown"}
- pageTitle: ${context.pageTitle || "unknown"}

Question:
${questionText}

Options:
${formattedOptions}`;
}

async function callGeminiWithModel({ questionText, options, context, apiKey, model }) {
  const endpoint = `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = buildPrompt({ questionText, options, context });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.15,
          topP: 0.9
        }
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Gemini request timed out.");
    }
    throw new Error(`Gemini network error: ${error.message || "unknown error"}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${sanitizeText(errorText).slice(0, 400)}`);
  }

  const responseJson = await response.json();
  const rawText = extractModelText(responseJson);

  if (!rawText) {
    throw new Error("Gemini returned an empty response.");
  }

  const stripped = stripCodeFences(rawText);
  const jsonCandidate = extractJsonObject(stripped) || stripped;

  let parsed;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    throw new Error("Gemini response was not valid JSON.");
  }

  return normalizeModelOutput(parsed, options);
}

async function callGemini({ questionText, options, context, apiKey, model }) {
  const preferred = [
    normalizeModelName(model),
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash"
  ].filter(Boolean);

  const available = await listAvailableGenerateModels(apiKey);
  const candidateModels = [
    ...preferred.filter((item) => available.includes(item)),
    ...available
  ].filter((item, index, arr) => arr.indexOf(item) === index);

  let lastError;
  for (const candidateModel of candidateModels) {
    try {
      return await callGeminiWithModel({
        questionText,
        options,
        context,
        apiKey,
        model: candidateModel
      });
    } catch (error) {
      lastError = error;
      // Retry with next model only when model is not found/unsupported.
      if (!/Gemini API error \((404|400)\)/i.test(error.message || "")) {
        throw error;
      }
    }
  }

  throw lastError || new Error("Gemini call failed.");
}

module.exports = { callGemini };
