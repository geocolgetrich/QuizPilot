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
const googleOAuthClientId = sanitizeText(process.env.GOOGLE_OAUTH_CLIENT_ID);

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
if (!googleOAuthClientId) {
  console.warn("[startup] GOOGLE_OAUTH_CLIENT_ID is not set. Audience checks are disabled.");
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

function mountBoth(path, ...handlers) {
  app.use(path, ...handlers);
  app.use(`/api${path}`, ...handlers);
}

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

async function inspectGoogleAccessToken(googleAccessToken) {
  const endpoint = `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(googleAccessToken)}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const err = new Error(
      `Google access token validation failed: ${sanitizeText(payload?.error_description || payload?.error || "unknown error")}`
    );
    err.statusCode = 401;
    throw err;
  }

  return {
    sub: sanitizeText(payload.sub),
    aud: sanitizeText(payload.aud),
    azp: sanitizeText(payload.azp),
    email: sanitizeText(payload.email),
    name: sanitizeText(payload.name),
    picture: sanitizeText(payload.picture)
  };
}

async function exchangeCustomToken(customToken) {
  if (!firebaseWebApiKey) {
    throw new Error("Server is missing FIREBASE_WEB_API_KEY.");
  }

  const endpoint = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(firebaseWebApiKey)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: customToken,
      returnSecureToken: true
    })
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Firebase custom token exchange failed (${response.status}): ${sanitizeText(text).slice(0, 500)}`);
    err.statusCode = 502;
    throw err;
  }

  return response.json();
}

function healthPayload() {
  return {
    ok: true,
    service: "quizpilot-server",
    configured: Boolean(geminiApiKey),
    firebaseReady,
    model: geminiModel,
    starterCredits,
    corsStrictMode,
    allowedOrigins,
    timestamp: new Date().toISOString()
  };
}

app.get("/", (_req, res) => {
  res.status(200).json({
    ...healthPayload(),
    docs: {
      health: "/health",
      authGoogle: "/auth/google",
      authMe: "/auth/me",
      analyzeQuestion: "/analyze-question"
    }
  });
});

app.head("/", (_req, res) => {
  res.status(200).end();
});

mountBoth("/health", (_req, res) => {
  res.json(healthPayload());
});

async function handleGoogleAuth(req, res, next) {
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

    const tokenInfo = await inspectGoogleAccessToken(googleAccessToken);
    if (googleOAuthClientId && tokenInfo.aud && tokenInfo.aud !== googleOAuthClientId) {
      const err = new Error(
        `Google token audience mismatch. Token aud=${tokenInfo.aud}. Expected GOOGLE_OAUTH_CLIENT_ID=${googleOAuthClientId}.`
      );
      err.statusCode = 400;
      throw err;
    }

    const uid = sanitizeText(tokenInfo.sub) ? `google:${sanitizeText(tokenInfo.sub)}` : "";
    if (!uid) {
      const err = new Error("Google token did not contain a valid subject.");
      err.statusCode = 401;
      throw err;
    }

    const auth = getAuth();
    const existingUser = await auth
      .getUser(uid)
      .catch((error) => (error?.code === "auth/user-not-found" ? null : Promise.reject(error)));

    if (!existingUser) {
      await auth.createUser({
        uid,
        email: tokenInfo.email || undefined,
        displayName: tokenInfo.name || undefined,
        photoURL: tokenInfo.picture || undefined
      });
    } else {
      await auth.updateUser(uid, {
        email: tokenInfo.email || undefined,
        displayName: tokenInfo.name || undefined,
        photoURL: tokenInfo.picture || undefined
      });
    }

    const customToken = await auth.createCustomToken(uid, {
      provider: "google",
      googleAud: tokenInfo.aud
    });
    const firebaseExchange = await exchangeCustomToken(customToken);
    const firebaseIdToken = sanitizeText(firebaseExchange.idToken);
    if (!firebaseIdToken) {
      throw new Error("Firebase custom token exchange did not return idToken.");
    }

    const decoded = await auth.verifyIdToken(firebaseIdToken);
    const profile = {
      email: sanitizeText(tokenInfo.email || decoded.email),
      name: sanitizeText(tokenInfo.name || decoded.name),
      picture: sanitizeText(tokenInfo.picture || decoded.picture)
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
}

mountBoth("/auth/google", express.json(), handleGoogleAuth);

mountBoth("/auth/me", verifyFirebaseUser, async (req, res, next) => {
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

mountBoth("/analyze-question", verifyFirebaseUser, async (req, res, next) => {
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
