// index.js
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();

/**
 * Required ENV vars:
 * - WHATSAPP_NUMBER_ID        (Phone Number ID)
 * - WHATSAPP_TOKEN            (Permanent/System user token)
 * - SHOPIFY_SHOP              (yourstore.myshopify.com)
 * - SHOPIFY_ACCESS_TOKEN      (Admin API token)
 * - VERIFY_TOKEN_META         (string used to verify Meta webhook)
 *
 * Optional:
 * - TEMPLATE_ORDER_PLACED_NAME (default: order_placed)
 * - LANG_CODE                  (default: en or en_US)
 * - DEFAULT_COUNTRY_CODE       (default: 92)
 * - SHOPIFY_WEBHOOK_SECRET     (if you enabled HMAC on Shopify webhook)
 * - STORE_NAME                 (friendly store name to display)
 * - PORT                      (default: 3000)
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
  console.error("❌ Missing required environment variables. Please set WHATSAPP_NUMBER_ID, WHATSAPP_TOKEN, SHOPIFY_SHOP, SHOPIFY_ACCESS_TOKEN.");
  process.exit(1);
}

// simple in-memory map for demo: phone -> orderId (use DB in production)
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
  try {
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
    } else {
      console.log("✅ WhatsApp API OK:", JSON.stringify(json));
    }
    return json;
  } catch (err) {
    console.error("❌ sendWhatsAppTemplate error:", err);
    throw err;
  }
}

async function updateShopifyOrderNote(orderId, noteText) {
  try {
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
    } else {
      console.log("✅ Shopify order note updated:", json);
    }
    return json;
  } catch (err) {
    console.error("❌ updateShopifyOrderNote error:", err);
    throw err;
  }
}

// ---------- meta verification endpoint ----------
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

// Parse JSON for non-Shopify routes
app.use(express.json());

// ---------- Shopify webhook (orders/create) ----------
// Use raw body for HMAC verification; content-type = application/json
app.post("/webhook/shopify", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    // optional HMAC verify
    if (SHOPIFY_WEBHOOK_SECRET) {
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
      const digest = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET).update(req.body).digest("base64");
      if (digest !== hmacHeader) {
        console.warn("❌ Shopify HMAC verification failed");
        return res.sendStatus(401);
      }
    }

    const data = JSON.parse(req.body.toString("utf8"));
    console.log("🧾 Shopify webhook received (order id):", data.id);

    // prefer checkout phone (shipping/billing)
    const checkoutPhone = data.shipping_address?.phone || data.billing_address?.phone || null;
    const phone = normalizePhone(checkoutPhone);
    if (!phone) {
      console.warn("❌ Customer phone missing in checkout fields. Payload excerpts:");
      console.log("customer.phone:", data.customer?.phone, "shipping.address.phone:", data.shipping_address?.phone, "billing.address.phone:", data.billing_address?.phone);
      // respond 200 to avoid Shopify retry spam
      return res.status(200).send("No phone — ignoring");
    }

    // extract fields
    const firstName = data.customer?.first_name || data.billing_address?.first_name || data.shipping_address?.first_name || "Customer";
    const orderId = data.id;
    const total = String(data.total_price || data.subtotal_price || "0");
    const currency = data.currency || (data.total_price_set?.shop_money?.currency_code) || "PKR";
    const firstProduct = data.line_items?.[0]?.title || "Product";
    const courierName = data.shipping_lines?.[0]?.title || "Courier";
    const trackingUrl = data.shipping_lines?.[0]?.tracking_url || data.fulfillments?.[0]?.tracking_url || "N/A";
    const storeName = process.env.STORE_NAME || SHOPIFY_SHOP;

    // store mapping phone -> latest order (demo). Production: use DB with TTL
    recentOrders.set(phone, { orderId, createdAt: Date.now() });

    // Build components parameters in same order as your approved template placeholders
    // Ensure your approved template placeholders match this order.
    const components = [
      {
        type: "body",
        parameters: [
          { type: "text", text: firstName },        // {{1}} Customer First Name
          { type: "text", text: String(orderId) },  // {{2}} Order ID
          { type: "text", text: firstProduct },     // {{3}} Product Name
          { type: "text", text: "1" },              // {{4}} Quantity (set 1 as default; you can compute)
          { type: "text", text: storeName },        // {{5}} Store Name
          { type: "text", text: total },            // {{6}} Total Price
          { type: "text", text: currency },         // {{7}} Currency
          { type: "text", text: courierName },      // {{8}} Courier Name
          { type: "text", text: trackingUrl },      // {{9}} Tracking URL (N/A if none)
        ],
      },
    ];

    // Send WhatsApp template
    const waResp = await sendWhatsAppTemplate(phone, TEMPLATE_ORDER_PLACED_NAME, components);
    console.log("✅ WhatsApp response (order):", waResp);

    // Update Shopify order note
    await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TEMPLATE_ORDER_PLACED_NAME} (msgId: ${waResp?.messages?.[0]?.id || "N/A"})`);

    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Shopify webhook handler error:", err);
    return res.status(500).send("Error");
  }
});

// ---------- WhatsApp webhook (Meta) ----------
// receives messages, statuses, button clicks
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    console.log("📲 META webhook payload:", JSON.stringify(req.body, null, 2));

    // handle statuses (delivery receipts) if present
    const entry = req.body.entry?.[0];
    if (!entry) {
      return res.sendStatus(200);
    }

    const changes = entry.changes?.[0];
    if (!changes) return res.sendStatus(200);

    const value = changes.value || {};
    // message statuses (delivered, read, etc.)
    if (value.statuses && Array.isArray(value.statuses)) {
      console.log("🔔 WhatsApp message status event:", JSON.stringify(value.statuses, null, 2));
      // You can update DB or Shopify note here if you map message->order
      return res.sendStatus(200);
    }

    // incoming messages / button replies
    const messages = value.messages;
    if (!messages || !messages.length) return res.sendStatus(200);

    const msg = messages[0];
    console.log("✉️ Incoming WA message:", JSON.stringify(msg, null, 2));

    // handle button reply
    if (msg.type === "button") {
      const payload = msg.button?.payload;
      const from = msg.from; // customer phone (wa id)
      console.log("🔘 Button payload:", payload, "from:", from);

      // Try to find orderId from in-memory map (demo). Replace with DB lookup in prod.
      const mapped = recentOrders.get(from) || recentOrders.get(normalizePhone(from));
      const orderId = mapped?.orderId;
      if (!orderId) {
        console.warn("⚠️ No mapped order for phone:", from, "— cannot update Shopify automatically.");
        // Optionally send a reply asking customer for order id or ignore
        return res.sendStatus(200);
      }

      let note = "";
      if (payload === "CONFIRM_ORDER") note = "✅ Order Confirmed via WhatsApp";
      else if (payload === "CANCEL_ORDER") note = "❌ Order Cancelled via WhatsApp";
      else note = `User action: ${payload}`;

      // Update Shopify note
      try {
        await updateShopifyOrderNote(orderId, note);
        console.log("✅ Updated Shopify order note for", orderId);
      } catch (err) {
        console.error("❌ Failed to update Shopify order note:", err);
      }

      // Optionally send a follow-up template/text confirming action to user
      // For brevity not sending follow-up here.

      return res.sendStatus(200);
    }

    // other message types: text, interactive replies etc.
    console.log("ℹ️ Unhandled message type:", msg.type);
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ META webhook handler error:", err);
    return res.status(500).send("Error");
  }
});

// health & demo
app.get("/", (req, res) => res.send("Automation service running ✅"));
app.get("/health", (req, res) => res.json({ ok: true }));

// demo send (test)
app.get("/demo/send", async (req, res) => {
  try {
    const to = normalizePhone(req.query.to);
    if (!to) return res.status(400).json({ error: "Provide ?to=923XXXXXXXXX" });

    const components = [
      {
        type: "body",
        parameters: [
          { type: "text", text: "Moosa" },
          { type: "text", text: "ORD-987654" },
          { type: "text", text: "Nike Shoes" },
          { type: "text", text: "1" },
          { type: "text", text: STORE_NAME || SHOPIFY_SHOP },
          { type: "text", text: "4500" },
          { type: "text", text: "PKR" },
          { type: "text", text: "PostEx" },
          { type: "text", text: "https://track.postex.pk/123" },
        ],
      },
    ];

    const resp = await sendWhatsAppTemplate(to, TEMPLATE_ORDER_PLACED_NAME, components);
    return res.json(resp);
  } catch (err) {
    console.error("❌ demo/send error:", err);
    return res.status(500).json({ error: "Error" });
  }
});

app.listen(PORT, () => {
  console.log(`⚡ Server running on port ${PORT}`);
});
