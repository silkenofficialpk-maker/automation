
// firebase.js
import admin from "firebase-admin";
import { readFileSync } from "fs";

// Load service account file (local or Render secret file)
const serviceAccount = JSON.parse(
  readFileSync("./automation-4b66d-firebase-adminsdk-fbsvc-e03497e203.json", "utf8")
);

// Initialize only once
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://automation-4b66d-default-rtdb.firebaseio.com",
  });
}

const db = admin.database();

// ✅ Make sure both are exported
export { admin, db };
