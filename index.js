import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

// 🔑 Replace with your credentials
const whatsappNumberId = "YOUR_WHATSAPP_NUMBER_ID";
const token = "YOUR_WHATSAPP_ACCESS_TOKEN";
const phoneNumber = "923103556217"; // jis number pe WhatsApp msg bhejna hai

// 📌 Shopify webhook route
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;

    // ✅ FIXED message string with backticks
    const message = `✅ New Shopify Order Received!\n\n🆔 Order ID: ${data.id}\n👤 Customer: ${data.customer?.first_name || "N/A"} ${data.customer?.last_name || ""}\n💰 Total: ${data.total_price || "N/A"} ${data.currency || ""}`;

    // 📤 Send message to WhatsApp
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${whatsappNumberId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phoneNumber,
          type: "text",
          text: { body: message },
        }),
      }
    );

    const result = await response.json();
    console.log("✅ WhatsApp API Response:", result);

    res.status(200).send("Webhook received & WhatsApp message sent!");
  } catch (error) {
    console.error("❌ Error handling webhook:", error);
    res.status(500).send("Server error");
  }
});

// 🚀 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡ Server running on http://localhost:${PORT}`);
});