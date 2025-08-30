// firebase.js (Backend version)
const admin = require("firebase-admin");

// Load service account key from environment variable (safe way)
// JSON ko string ke form me store karke parse karna
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://automation-4b66d-default-rtdb.firebaseio.com"
});

const db = admin.database();

module.exports = db;
