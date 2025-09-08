import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

// ES Module helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use secret file path depending on environment
const credentialsPath =
  process.env.NODE_ENV === "production"
    ? "/etc/secrets/automation-4b66d-firebase-adminsdk-fbsvc-e03497e203.json"
    : path.join(__dirname, "./automation-4b66d-firebase-adminsdk-fbsvc-e03497e203.json");

// Parse the JSON
const serviceAccount = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));

// Initialize Firebase
initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://automation-4b66d-default-rtdb.firebaseio.com",
});

console.log(JSON.stringify(serviceAccount, null, 2));
// Export DB
const db = getDatabase();
export { db };
