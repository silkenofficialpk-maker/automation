import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

// 🔑 Environment Variables
const whatsappNumberId = process.env.WHATSAPP_NUMBER_ID;
const token = process.env.WHATSAPP_TOKEN;

// 🔹 Webhook Verification (Meta)
app.get("/webhook", (req, res) => {
  const verifyToken = "shopify123"; // same token jo Meta me dala hai

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && token === verifyToken) {
    console.log("✅ Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.status(403).send("Verification failed");
  }
});

// 📌 Shopify webhook
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;
    const customerNumber = data.customer?.phone;

    if (!customerNumber) {
      console.log("❌ Customer number missing!");
      return res.status(400).send("Customer number missing!");
    }

    // WhatsApp template message
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
          to: customerNumber,
          type: "template",
          template: {
            name: "order_placed", // Meta approved template
            language: { code: "en" },
            components: [
              {
                type: "body",
                parameters: [
                  { type: "text", text: data.customer?.first_name || "Customer" },
                  { type: "text", text: data.id },
                  { type: "text", text: data.total_price || "0" },
                  { type: "text", text: data.currency || "PKR" },
                  { type: "text", text: data.shipping_lines?.[0]?.title || "N/A" },
                  { type: "text", text: data.shipping_lines?.[0]?.tracking_number || "N/A" }
                ]
              }
            ]
          }
        }),
      }
    );

    const result = await response.json();
    console.log("✅ WhatsApp Template Response:", result);

    res.status(200).send("Webhook received & Template message sent!");
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

