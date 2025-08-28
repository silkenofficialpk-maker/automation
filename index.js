// index.js
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();

/**
 * ========= ENV VARS =========
 * WHATSAPP_NUMBER_ID
 * WHATSAPP_TOKEN
 * SHOPIFY_SHOP
 * SHOPIFY_ACCESS_TOKEN
 * VERIFY_TOKEN_META
 * TEMPLATE_ORDER_PLACED_NAME
 * LANG_CODE
 * DEFAULT_COUNTRY_CODE
 * SHOPIFY_WEBHOOK_SECRET
 * TEST_TO
 */
const {
  WHATSAPP_NUMBER_ID,
  WHATSAPP_TOKEN,
  SHOPIFY_SHOP,
  SHOPIFY_ACCESS_TOKEN,
  VERIFY_TOKEN_META = "shopify123",
  TEMPLATE_ORDER_PLACED_NAME = "order_placed",
  LANG_CODE = "en",
  DEFAULT_COUNTRY_CODE = "92",
  SHOPIFY_WEBHOOK_SECRET,
  TEST_TO,
  VERIFY_TOKEN = "shopify123",
  PORT = 3000,
} = process.env;

// ---------- Helpers ----------
function normalizePhone(raw, defaultCC = DEFAULT_COUNTRY_CODE) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("0") && defaultCC) return `${defaultCC}${digits.slice(1)}`;
  if (defaultCC && digits.startsWith(defaultCC)) return digits;
  if (defaultCC && digits.length <= 10) return `${defaultCC}${digits}`;
  return digits;
}

async function sendWhatsAppTemplate(to, templateName, components = [], lang = LANG_CODE) {
  const url = `https://graph.facebook.com/v23.0/${WHATSAPP_NUMBER_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      components,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (!res.ok) console.error("❌ WhatsApp API error:", res.status, json);
  return json;
}

async function updateShopifyOrderNote(orderId, noteText) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/2023-10/orders/${orderId}.json`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ order: { id: orderId, note: noteText } }),
  });
  const json = await res.json();
  if (!res.ok) console.error("❌ Shopify update error:", res.status, json);
  return json;
}

// ---------- META WEBHOOK ----------
app.get("/webhook/meta", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token === VERIFY_TOKEN_META) {
    console.log("✅ META webhook verified");
    return res.status(200).send(challenge);
  }
  console.warn("❌ META webhook verify failed");
  return res.sendStatus(403);
});

app.use("/webhook/meta", express.json());
app.post("/webhook/meta", (req, res) => {
  console.log("📨 META webhook event:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// ---------- SHOPIFY WEBHOOK ----------
app.post(
  "/webhook/shopify",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (SHOPIFY_WEBHOOK_SECRET) {
        const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
        const digest = crypto
          .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
          .update(req.body)
          .digest("base64");
        if (digest !== hmacHeader) {
          console.warn("❌ Shopify HMAC verification failed");
          return res.sendStatus(401);
        }
      }

      const data = JSON.parse(req.body.toString("utf8"));
      console.log("🧾 Shopify webhook received:", data.id);

      const checkoutPhone =
        data.shipping_address?.phone || data.billing_address?.phone || null;
      const phone = normalizePhone(checkoutPhone);
      if (!phone) {
        console.warn("❌ Customer number missing!");
        return res.status(200).send("No phone — ignoring");
      }

      const firstName =
        data.customer?.first_name ||
        data.billing_address?.first_name ||
        data.shipping_address?.first_name ||
        "Customer";
      const orderId = data.id;
      const total = String(data.total_price || "0");
      const currency = data.currency || "PKR";
      const courierName = data.shipping_lines?.[0]?.title || "Courier";
      const trackingUrl =
        data.shipping_lines?.[0]?.tracking_url ||
        data.fulfillments?.[0]?.tracking_url ||
        "N/A";

      // ✅ NEW FIELDS
      const storeName = process.env.STORE_NAME || SHOPIFY_SHOP;
      const firstProduct = data.line_items?.[0]?.title || "Product";

      const components = [
        {
          type: "body",
          parameters: [
            { type: "text", text: firstName },     // {{1}} Customer name
            { type: "text", text: String(orderId) }, // {{2}} Order ID
            { type: "text", text: total },        // {{3}} Total
            { type: "text", text: currency },     // {{4}} Currency
            { type: "text", text: firstProduct }, // {{5}} Product Name
            { type: "text", text: storeName },    // {{6}} Store Name
            { type: "text", text: courierName },  // {{7}} Courier
            { type: "text", text: trackingUrl },  // {{8}} Tracking link
          ],
        },
      ];

      const waResp = await sendWhatsAppTemplate(
        phone,
        TEMPLATE_ORDER_PLACED_NAME,
        components
      );
      console.log("✅ WhatsApp Template Response:", waResp);

      await updateShopifyOrderNote(
        orderId,
        `WhatsApp: sent ${TEMPLATE_ORDER_PLACED_NAME} (msg: ${waResp?.messages?.[0]?.id || "N/A"})`
      );

      res.status(200).send("OK");
    } catch (err) {
      console.error("❌ Shopify webhook handler error:", err);
      res.status(500).send("Error");
    }
  }
);


// ---------- WhatsApp Button Handler ----------
app.use("/webhook/whatsapp", express.json());
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    console.log("Webhook received:", JSON.stringify(req.body, null, 2));
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages || messages.length === 0) return res.sendStatus(200);

    const message = messages[0];
    if (message.type === "button") {
      const payload = message.button.payload; // CONFIRM_ORDER / CANCEL_ORDER
      const customerPhone = message.from;

      console.log("📩 Button clicked:", payload, "From:", customerPhone);

      // For now DEMO: you’ll need a DB to map phone → orderId
      const ORDER_ID = "1234567890";

      let note = "";
      if (payload === "CONFIRM_ORDER") note = "✅ Order Confirmed via WhatsApp";
      if (payload === "CANCEL_ORDER") note = "❌ Order Cancelled via WhatsApp";

      await updateShopifyOrderNote(ORDER_ID, note);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Webhook Error:", error);
    res.sendStatus(500);
  }
});

// ---------- Verify webhook (Meta setup) ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified ✅");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`⚡ Server running on port ${PORT}`);
});


