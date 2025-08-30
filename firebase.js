// firebase.js
import admin from "firebase-admin";

let app;
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://automation-4b66d-default-rtdb.firebaseio.com"
  });
}

const db = admin.firestore();
export { db };
