const { sanitizeText } = require("./validation");

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 25000);

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
  const explanation = sanitizeText(parsed?.explanation || "") || "No explanation provided by model.";
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
    explanation,
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
  "explanation": string,
  "confidence": number
}

Rules:
- bestAnswerIndex must be the zero-based index from the provided options.
- explanation must be concise (max 3 sentences).
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

async function callGemini({ questionText, options, context, apiKey, model }) {
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

module.exports = { callGemini };
