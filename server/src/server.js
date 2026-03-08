require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const { callGemini } = require("./gemini");
const { validateAnalyzeRequest } = require("./validation");

const app = express();

const port = Number(process.env.PORT || 10000);
const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 60);
const corsStrictMode = String(process.env.CORS_STRICT_MODE || "false").toLowerCase() === "true";

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!geminiApiKey) {
  // Avoid crashing hard so health checks can still show config issue.
  // API endpoint returns explicit error if key is missing.
  console.warn("[startup] GEMINI_API_KEY is missing. /analyze-question will fail until configured.");
}

app.use(
  helmet({
    crossOriginResourcePolicy: false
  })
);

app.use(express.json({ limit: "32kb" }));
app.use(morgan("combined"));

const corsOptions = {
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (!corsStrictMode) {
      callback(null, true);
      return;
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error("CORS blocked for this origin in strict mode."));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  maxAge: 600
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Rate limit exceeded. Please retry later."
    }
  })
);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "quizpilot-server",
    configured: Boolean(geminiApiKey),
    model: geminiModel,
    corsStrictMode,
    allowedOrigins,
    timestamp: new Date().toISOString()
  });
});

app.post("/analyze-question", async (req, res, next) => {
  try {
    if (!geminiApiKey) {
      res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });
      return;
    }

    const payload = validateAnalyzeRequest(req.body);
    const result = await callGemini({
      ...payload,
      apiKey: geminiApiKey,
      model: geminiModel
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const message = error?.message || "Unexpected server error.";

  if (/must be between|must contain|CORS blocked/.test(message)) {
    res.status(400).json({ error: message });
    return;
  }

  if (/Gemini API error|Gemini request timed out|Gemini network error|Gemini response was not valid JSON|Gemini returned an empty response/i.test(message)) {
    res.status(502).json({ error: message });
    return;
  }

  console.error("[server-error]", error);
  res.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`[startup] QuizPilot backend running on port ${port}`);
  console.log(`[startup] CORS strict mode: ${corsStrictMode}`);
  console.log(`[startup] Allowed origins: ${allowedOrigins.join(", ") || "(any - set ALLOWED_ORIGINS)"}`);
});
