import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

// 🔑 Credentials from Environment Variables
const whatsappNumberId = process.env.WHATSAPP_NUMBER_ID;
const token = process.env.WHATSAPP_TOKEN;

// Helper function to send WhatsApp message
async function sendWhatsAppMessage(to, message) {
  try {
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
          to: to,
          type: "text",
          text: { body: message },
        }),
      }
    );

    const result = await response.json();
    console.log("✅ WhatsApp API Response:", result);
  } catch (error) {
    console.error("❌ Error sending WhatsApp message:", error);
  }
}

// 📌 Shopify webhook route
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;

    // Extract customer phone number (ensure it's in international format for WhatsApp)
    const phoneNumber = data.customer?.phone;

    if (!phoneNumber) {
      console.log("❌ Customer phone number is missing!");
      return res.status(400).send("Customer phone number is missing.");
    }

    // Construct WhatsApp message
    const message = `✅ New Shopify Order Received!\n\n🆔 Order ID: ${data.id}\n👤 Customer: ${data.customer?.first_name || "N/A"} ${data.customer?.last_name || ""}\n💰 Total: ${data.total_price || "N/A"} ${data.currency || ""}\n📦 Courier: ${data.shipping_lines?.[0]?.title || "N/A"}\n📍 Tracking: ${data.shipping_lines?.[0]?.tracking_number || "N/A"}`;

    // Send WhatsApp message
    await sendWhatsAppMessage(phoneNumber, message);

    res.status(200).send("Webhook received & WhatsApp message sent!");
  } catch (error) {
    console.error("❌ Error handling webhook:", error);
    res.status(500).send("Server error");
  }
});

// 🚀 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`⚡ Server running on port ${PORT}`);
});
