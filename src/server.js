require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const { callGemini } = require("./gemini");
const { validateAnalyzeRequest, sanitizeText } = require("./validation");
const { admin, firebaseReady, getAuth, getDb } = require("./firebase-admin");

const app = express();

const port = Number(process.env.PORT || 10000);
const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 60);
const corsStrictMode = String(process.env.CORS_STRICT_MODE || "false").toLowerCase() === "true";
const starterCredits = Number(process.env.STARTER_CREDITS || 100);
const firebaseWebApiKey = process.env.FIREBASE_WEB_API_KEY;

const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!geminiApiKey) {
  console.warn("[startup] GEMINI_API_KEY is missing. /analyze-question will fail until configured.");
}
if (!firebaseReady) {
  console.warn("[startup] Firebase Admin is not configured. Auth + credits will fail until configured.");
}
if (!firebaseWebApiKey) {
  console.warn("[startup] FIREBASE_WEB_API_KEY is missing. /auth/google will fail until configured.");
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
    if (!corsStrictMode || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("CORS blocked for this origin in strict mode."));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
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
    message: { error: "Rate limit exceeded. Please retry later." }
  })
);

function authTokenFromHeader(req) {
  const raw = String(req.headers.authorization || "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

async function verifyFirebaseUser(req, _res, next) {
  try {
    if (!firebaseReady) {
      throw new Error("Firebase Admin is not configured on server.");
    }

    const token = authTokenFromHeader(req);
    if (!token) {
      const err = new Error("Missing bearer token.");
      err.statusCode = 401;
      throw err;
    }

    const decoded = await getAuth().verifyIdToken(token);
    req.user = {
      uid: decoded.uid,
      email: sanitizeText(decoded.email),
      name: sanitizeText(decoded.name),
      picture: sanitizeText(decoded.picture)
    };
    next();
  } catch (error) {
    next(error);
  }
}

async function ensureUserDoc(uid, profile = {}) {
  const db = getDb();
  const ref = db.collection("users").doc(uid);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      tx.set(ref, {
        uid,
        email: sanitizeText(profile.email),
        name: sanitizeText(profile.name),
        picture: sanitizeText(profile.picture),
        creditsRemaining: starterCredits,
        totalUsed: 0,
        createdAt: now,
        updatedAt: now
      });
      return;
    }

    tx.set(
      ref,
      {
        email: sanitizeText(profile.email || snap.get("email")),
        name: sanitizeText(profile.name || snap.get("name")),
        picture: sanitizeText(profile.picture || snap.get("picture")),
        updatedAt: now
      },
      { merge: true }
    );
  });

  const latest = await ref.get();
  return latest.data();
}

async function consumeOneCredit(uid) {
  const db = getDb();
  const ref = db.collection("users").doc(uid);
  const now = admin.firestore.FieldValue.serverTimestamp();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new Error("User record missing.");
    }

    const current = Number(snap.get("creditsRemaining") || 0);
    if (current <= 0) {
      const err = new Error("No credits remaining.");
      err.statusCode = 402;
      throw err;
    }

    tx.update(ref, {
      creditsRemaining: current - 1,
      totalUsed: Number(snap.get("totalUsed") || 0) + 1,
      updatedAt: now
    });

    return current - 1;
  });
}

async function refundOneCredit(uid) {
  const db = getDb();
  const ref = db.collection("users").doc(uid);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    tx.update(ref, {
      creditsRemaining: Number(snap.get("creditsRemaining") || 0) + 1,
      totalUsed: Math.max(Number(snap.get("totalUsed") || 0) - 1, 0),
      updatedAt: now
    });
  });
}

async function exchangeGoogleAccessToken(googleAccessToken) {
  if (!firebaseWebApiKey) {
    throw new Error("Server is missing FIREBASE_WEB_API_KEY.");
  }

  const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(firebaseWebApiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      postBody: `access_token=${encodeURIComponent(googleAccessToken)}&providerId=google.com`,
      requestUri: "https://quizpilot.app",
      returnSecureToken: true,
      returnIdpCredential: true
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firebase IdP exchange failed (${response.status}): ${sanitizeText(text).slice(0, 400)}`);
  }

  return response.json();
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "quizpilot-server",
    configured: Boolean(geminiApiKey),
    firebaseReady,
    model: geminiModel,
    starterCredits,
    corsStrictMode,
    allowedOrigins,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "quizpilot-server",
    firebaseReady,
    model: geminiModel,
    starterCredits,
    corsStrictMode,
    allowedOrigins,
    timestamp: new Date().toISOString()
  });
});

app.post("/auth/google", async (req, res, next) => {
  try {
    if (!firebaseReady) {
      throw new Error("Firebase Admin is not configured on server.");
    }

    const googleAccessToken = sanitizeText(req.body?.googleAccessToken);
    if (!googleAccessToken) {
      const err = new Error("googleAccessToken is required.");
      err.statusCode = 400;
      throw err;
    }

    const exchange = await exchangeGoogleAccessToken(googleAccessToken);
    const firebaseIdToken = sanitizeText(exchange.idToken);
    if (!firebaseIdToken) {
      throw new Error("Firebase exchange did not return idToken.");
    }

    const decoded = await getAuth().verifyIdToken(firebaseIdToken);
    const profile = {
      email: sanitizeText(exchange.email || decoded.email),
      name: sanitizeText(exchange.displayName || decoded.name),
      picture: sanitizeText(exchange.photoUrl || decoded.picture)
    };
    const userDoc = await ensureUserDoc(decoded.uid, profile);

    res.json({
      idToken: firebaseIdToken,
      user: {
        uid: decoded.uid,
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
        creditsRemaining: Number(userDoc?.creditsRemaining || 0),
        totalUsed: Number(userDoc?.totalUsed || 0)
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/google", async (req, res, next) => {
  try {
    if (!firebaseReady) {
      throw new Error("Firebase Admin is not configured on server.");
    }

    const googleAccessToken = sanitizeText(req.body?.googleAccessToken);
    if (!googleAccessToken) {
      const err = new Error("googleAccessToken is required.");
      err.statusCode = 400;
      throw err;
    }

    const exchange = await exchangeGoogleAccessToken(googleAccessToken);
    const firebaseIdToken = sanitizeText(exchange.idToken);
    if (!firebaseIdToken) {
      throw new Error("Firebase exchange did not return idToken.");
    }

    const decoded = await getAuth().verifyIdToken(firebaseIdToken);
    const profile = {
      email: sanitizeText(exchange.email || decoded.email),
      name: sanitizeText(exchange.displayName || decoded.name),
      picture: sanitizeText(exchange.photoUrl || decoded.picture)
    };
    const userDoc = await ensureUserDoc(decoded.uid, profile);

    res.json({
      idToken: firebaseIdToken,
      user: {
        uid: decoded.uid,
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
        creditsRemaining: Number(userDoc?.creditsRemaining || 0),
        totalUsed: Number(userDoc?.totalUsed || 0)
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/auth/me", verifyFirebaseUser, async (req, res, next) => {
  try {
    const userDoc = await ensureUserDoc(req.user.uid, req.user);
    res.json({
      user: {
        uid: req.user.uid,
        email: req.user.email,
        name: req.user.name,
        picture: req.user.picture,
        creditsRemaining: Number(userDoc?.creditsRemaining || 0),
        totalUsed: Number(userDoc?.totalUsed || 0)
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", verifyFirebaseUser, async (req, res, next) => {
  try {
    const userDoc = await ensureUserDoc(req.user.uid, req.user);
    res.json({
      user: {
        uid: req.user.uid,
        email: req.user.email,
        name: req.user.name,
        picture: req.user.picture,
        creditsRemaining: Number(userDoc?.creditsRemaining || 0),
        totalUsed: Number(userDoc?.totalUsed || 0)
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/analyze-question", verifyFirebaseUser, async (req, res, next) => {
  let charged = false;
  try {
    if (!geminiApiKey) {
      throw new Error("Server is missing GEMINI_API_KEY.");
    }

    const payload = validateAnalyzeRequest(req.body);
    const creditsRemaining = await consumeOneCredit(req.user.uid);
    charged = true;

    const result = await callGemini({
      ...payload,
      apiKey: geminiApiKey,
      model: geminiModel
    });

    res.json({
      ...result,
      usage: {
        creditsRemaining
      }
    });
  } catch (error) {
    if (charged) {
      await refundOneCredit(req.user.uid).catch(() => {});
    }
    next(error);
  }
});

app.post("/api/analyze-question", verifyFirebaseUser, async (req, res, next) => {
  let charged = false;
  try {
    if (!geminiApiKey) {
      throw new Error("Server is missing GEMINI_API_KEY.");
    }

    const payload = validateAnalyzeRequest(req.body);
    const creditsRemaining = await consumeOneCredit(req.user.uid);
    charged = true;

    const result = await callGemini({
      ...payload,
      apiKey: geminiApiKey,
      model: geminiModel
    });

    res.json({
      ...result,
      usage: {
        creditsRemaining
      }
    });
  } catch (error) {
    if (charged) {
      await refundOneCredit(req.user.uid).catch(() => {});
    }
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  const message = error?.message || "Unexpected server error.";

  if (error?.statusCode) {
    res.status(error.statusCode).json({ error: message });
    return;
  }
  if (/must be between|must contain|CORS blocked|required/i.test(message)) {
    res.status(400).json({ error: message });
    return;
  }
  if (/Missing bearer token|verifyIdToken|auth/i.test(message)) {
    res.status(401).json({ error: message });
    return;
  }
  if (
    /Gemini API error|Gemini request timed out|Gemini network error|Gemini response was not valid JSON|Gemini returned an empty response/i.test(
      message
    )
  ) {
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
  console.log(`[startup] Firebase configured: ${firebaseReady}`);
});
