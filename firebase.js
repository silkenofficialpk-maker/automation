var admin = require("firebase-admin");

var serviceAccount = require("./automation-4b66d-firebase-adminsdk-fbsvc-e03497e203.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://automation-4b66d-default-rtdb.firebaseio.com"
});

module.exports = admin;
