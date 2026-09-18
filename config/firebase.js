const admin = require('firebase-admin');
require('dotenv').config();

let serviceAccount;

// Check if GOOGLE_APPLICATION_CREDENTIALS env var is set (path to JSON file)
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  // Firebase Admin will auto-detect the credentials file
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
} else if (
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
) {
  // Use inline config from .env
  serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} else {
  console.warn(
    '⚠️  Firebase credentials not configured. Using Firestore emulator or mock mode.'
  );
  console.warn(
    '   Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_* env vars in server/.env'
  );

  // Initialize without credentials for local development
  // This will work with Firebase Emulator Suite
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || 'demo-live-seminar',
  });
}

const db = admin.firestore();

module.exports = { admin, db };
