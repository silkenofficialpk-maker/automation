// index.js
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();

/**
 * ========= ENV VARS (set them in Render or .env) =========
 * REQUIRED:
 *  WHATSAPP_NUMBER_ID         e.g. 123456789012345
 *  WHATSAPP_TOKEN             Permanent system-user token
 *  SHOPIFY_SHOP               yourstore.myshopify.com
 *  SHOPIFY_ACCESS_TOKEN       Shopify Admin API token (orders, fulfillments write)
 *  VERIFY_TOKEN_META          any string you set for Meta webhook verify (e.g. "shopify123")
 *
 * NICE TO HAVE:
 *  TEMPLATE_ORDER_PLACED_NAME default: order_placed
 *  LANG_CODE                  default: en   (use en_US if your template is en_US)
 *  DEFAULT_COUNTRY_CODE       default: 92   (Pakistan)
 *  SHOPIFY_WEBHOOK_SECRET     if you enabled HMAC verification on Shopify webhooks
 *  TEST_TO                    a phone to hit GET /demo/send (e.g. 923001234567)
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
  PORT = 3000,
} = process.env;

// ---------- Helpers ----------
function normalizePhone(raw, defaultCC = DEFAULT_COUNTRY_CODE) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  // If starts with 0, replace leading 0 with default country code
  if (digits.startsWith("0") && defaultCC) return `${defaultCC}${digits.slice(1)}`;

  // If already begins with country code
  if (defaultCC && digits.startsWith(defaultCC)) return digits;

  // If likely local number, prepend default code
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
  if (!res.ok) {
    console.error("❌ WhatsApp API error:", res.status, json);
  }
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
  if (!res.ok) {
    console.error("❌ Shopify update error:", res.status, json);
  }
  return json;
}

// ---------- Meta Webhook (Verify + Receive) ----------
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
  // Incoming user replies / interactive button clicks will land here
  console.log("📨 META webhook event:", JSON.stringify(req.body, null, 2));
  // TODO: Parse messages & postbacks and act (confirm/cancel/reschedule etc.)
  res.sendStatus(200);
});

// ---------- Shopify Webhook (orders/create etc.) ----------
// Use raw body to let us verify HMAC if provided
app.post(
  "/webhook/shopify",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      // HMAC verify (optional)
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

      // Parse JSON
      const data = JSON.parse(req.body.toString("utf8"));
      console.log("🧾 Shopify webhook received:", data.id);

      // Phone only from checkout field (shipping/billing phone)
      const checkoutPhone =
        data.shipping_address?.phone || data.billing_address?.phone || null;

      const phone = normalizePhone(checkoutPhone);
      if (!phone) {
        console.warn("❌ Customer number missing in checkout phone field!");
        return res.status(200).send("No phone — ignoring");
      }

      // Extract values for template placeholders
      const firstName =
        data.customer?.first_name ||
        data.billing_address?.first_name ||
        data.shipping_address?.first_name ||
        "Customer";
      const orderId = data.id;
      const total = String(data.total_price || "0");
      const currency = data.currency || "PKR";

      // Courier data (best-effort from order)
      const courierName = data.shipping_lines?.[0]?.title || "Courier";
      const trackingUrl =
        data.shipping_lines?.[0]?.tracking_url ||
        data.fulfillments?.[0]?.tracking_url ||
        "N/A";

      // WhatsApp template with 6 placeholders (your approved template must match!)
      const components = [
        {
          type: "body",
          parameters: [
            { type: "text", text: firstName },       // 1. Customer First Name
            { type: "text", text: String(orderId) }, // 2. Order ID
            { type: "text", text: total },           // 3. Total Price
            { type: "text", text: currency },        // 4. Currency
            { type: "text", text: courierName },     // 5. Courier Name
            { type: "text", text: trackingUrl },     // 6. Tracking URL
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

// ---------- Courier Webhook (PostEx or others) ----------
app.use("/webhook/courier", express.json());
app.post("/webhook/courier", async (req, res) => {
  // TODO: Map your courier payload → orderId, trackingNo, status, city, timestamp.
  const payload = req.body;
  console.log("🚚 Courier webhook:", JSON.stringify(payload, null, 2));

  // Example (pseudo):
  // const orderId = payload.order_id;
  // const status = payload.status;         // e.g. "in_transit", "out_for_delivery", "delivered", "rto"
  // const city   = payload.current_city;
  // const phone  = lookupPhoneFromDB(orderId); // you'd need a DB to map order->phone

  // Then send WA template per status and update Shopify note.
  res.sendStatus(200);
});

// ---------- Utilities / Health ----------
app.get("/", (_req, res) => res.send("Automation service running ✅"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Quick demo sender (useful to test token/number/template fast)
app.get("/demo/send", async (req, res) => {
  const to = normalizePhone(req.query.to || TEST_TO);
  if (!to) return res.status(400).json({ error: "Provide ?to=923XXXXXXXXX or set TEST_TO" });

  const components = [
    {
      type: "body",
      parameters: [
        { type: "text", text: "Moosa" },
        { type: "text", text: "ORD-987654" },
        { type: "text", text: "4500" },
        { type: "text", text: "PKR" },
        { type: "text", text: "PostEx" },
        { type: "text", text: "https://track.postex.pk/123" },
      ],
    },
  ];
  const resp = await sendWhatsAppTemplate(to, TEMPLATE_ORDER_PLACED_NAME, components);
  res.json(resp);
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`⚡ Server running on port ${PORT}`);
});
