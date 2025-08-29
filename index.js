// index.js
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();

/**
 * Required ENV vars
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
  STORE_NAME,
  PORT = 3000,
} = process.env;

if (!WHATSAPP_NUMBER_ID || !WHATSAPP_TOKEN || !SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

// in-memory phone -> order mapping
const recentOrders = new Map();

// ---------- helpers ----------
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
  const url = `https://graph.facebook.com/v19.0/${WHATSAPP_NUMBER_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name: templateName, language: { code: lang }, components },
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
  else console.log("✅ WhatsApp API OK:", JSON.stringify(json));
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
  else console.log("✅ Shopify order note updated:", json);
  return json;
}

// ---------- webhook verification ----------
app.get(["/webhook", "/webhook/whatsapp", "/webhook/meta"], (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN_META) {
    console.log("✅ Meta webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- Shopify webhook (orders/create) ----------
app.post("/webhook/shopify", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    // verify HMAC (optional)
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
    console.log("🧾 Shopify webhook order:", data.id);

    const checkoutPhone =
      data.shipping_address?.phone ||
      data.billing_address?.phone ||
      data.customer?.phone;
    const phone = normalizePhone(checkoutPhone);
    if (!phone) {
      console.warn("❌ No phone in order:", data.id);
      return res.status(200).send("No phone — ignoring");
    }

   // extract fields
const firstName =
  data.customer?.first_name ||
  data.billing_address?.first_name ||
  data.shipping_address?.first_name ||
  "Customer";
const orderId = data.id;
const total = String(data.total_price || data.subtotal_price || "0");
const currency =
  data.currency ||
  data.total_price_set?.shop_money?.currency_code ||
  "PKR";
const firstProduct = data.line_items?.[0]?.title || "Product";
const storeName = STORE_NAME || SHOPIFY_SHOP;

// map phone -> order
recentOrders.set(phone, { orderId, createdAt: Date.now() });

// ✅ template parameters (only 7 placeholders!)
const components = [
  {
    type: "body",
    parameters: [
      { type: "text", text: firstName },        // {{1}}
      { type: "text", text: String(orderId) },  // {{2}}
      { type: "text", text: firstProduct },     // {{3}}
      { type: "text", text: "1" },              // {{4}} quantity
      { type: "text", text: storeName },        // {{5}}
      { type: "text", text: total },            // {{6}}
      { type: "text", text: currency },         // {{7}}
    ],
  },
];

// send WhatsApp template
const waResp = await sendWhatsAppTemplate(
  phone,
  TEMPLATE_ORDER_PLACED_NAME, // should be "order_confirmation"
  components
);
console.log("✅ WhatsApp sent to", phone);

    // update Shopify order note
    await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TEMPLATE_ORDER_PLACED_NAME} (msgId: ${waResp?.messages?.[0]?.id || "N/A"})`);

    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Shopify webhook handler error:", err);
    return res.sendStatus(500);
  }
});

// ---------- WhatsApp webhook (incoming msgs) ----------
app.post("/webhook/whatsapp", express.json(), async (req, res) => {
  console.log("📲 META webhook payload:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200); // ack immediately

  const entry = req.body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  if (!value) return;

  // status updates
  if (value.statuses) {
    console.log("🔔 Status update:", value.statuses);
    return;
  }

  // incoming message
  const msg = value.messages?.[0];
  if (!msg) return;
  console.log("✉️ Incoming WA message:", msg);

  if (msg.type === "button") {
    const payload = msg.button?.payload;
    const from = msg.from;
    const mapped = recentOrders.get(from) || recentOrders.get(normalizePhone(from));
    const orderId = mapped?.orderId;
    if (!orderId) return;

    let note = "";
    if (payload === "CONFIRM_ORDER") note = "✅ Order Confirmed via WhatsApp";
    else if (payload === "CANCEL_ORDER") note = "❌ Order Cancelled via WhatsApp";
    else note = `User action: ${payload}`;

    await updateShopifyOrderNote(orderId, note);
  }
});

// ---------- test/demo ----------
app.get("/", (req, res) => res.send("✅ Service running"));
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`⚡ Server running on port ${PORT}`));

