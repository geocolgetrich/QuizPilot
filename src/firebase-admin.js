const admin = require("firebase-admin");

function getServiceAccountFromEnv() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
    };
  }

  return null;
}

const serviceAccount = getServiceAccountFromEnv();

let firebaseReady = false;
if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  firebaseReady = true;
}

function ensureFirebaseReady() {
  if (!firebaseReady) {
    throw new Error("Firebase Admin is not configured on server.");
  }
}

function getAuth() {
  ensureFirebaseReady();
  return admin.auth();
}

function getDb() {
  ensureFirebaseReady();
  return admin.firestore();
}

module.exports = {
  admin,
  firebaseReady,
  ensureFirebaseReady,
  getAuth,
  getDb
};
