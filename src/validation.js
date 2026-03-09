function sanitizeText(input) {
  return String(input || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validateAnalyzeRequest(body) {
  const questionText = sanitizeText(body?.questionText);
  const options = Array.isArray(body?.options)
    ? body.options.map((value) => sanitizeText(value)).filter(Boolean)
    : [];

  const context = {
    pageTitle: sanitizeText(body?.context?.pageTitle),
    hostname: sanitizeText(body?.context?.hostname)
  };

  if (questionText.length < 8 || questionText.length > 1200) {
    throw new Error("questionText must be between 8 and 1200 characters.");
  }

  if (options.length < 2 || options.length > 10) {
    throw new Error("options must contain between 2 and 10 entries.");
  }

  for (const option of options) {
    if (option.length < 1 || option.length > 240) {
      throw new Error("Each option must be between 1 and 240 characters.");
    }
  }

  return { questionText, options, context };
}

module.exports = { validateAnalyzeRequest, sanitizeText };
