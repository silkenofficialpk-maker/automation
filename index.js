import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import admin from "firebase-admin";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const serviceAccount = require("./automation-4b66d-firebase-adminsdk-fbsvc-8261178347.json");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://automation-4b66d-default-rtdb.firebaseio.com/",
  });
  console.log("✅ Firebase Admin initialized");
}

export const db = admin.database();

const app = express();
app.use(express.json());

/**
 * ENV / CONFIG
 */
const {
  WHATSAPP_NUMBER_ID,
  WHATSAPP_TOKEN,
  SHOPIFY_SHOP,
  SHOPIFY_ACCESS_TOKEN,
  VERIFY_TOKEN_META = "shopify123",
  STORE_NAME,
  DEFAULT_COUNTRY_CODE = "92",
  SHOPIFY_WEBHOOK_SECRET,
  SHOPIFY_STOREFRONT_DOMAIN = "SILKENROOT.COM",
  DEFAULT_PRODUCT_URL,
  DEFAULT_CHECKOUT_URL,
  PORT = 3000,
} = process.env;

/**
 * TEMPLATE NAMES (LOCKED as per your data)
 * Keep these exactly as you created in Meta
 */
const TPL = {
  ORDER_CONFIRMATION: "order_confirmation",
  ORDER_CONFIRMED_REPLY: "order_confirmed_reply",
  ORDER_CANCELLED_REPLY_AUTO: "order_cancelled_reply_auto",
  ORDER_DISPATCH_REMINDER: "order_dispatch_reminder",
  DELIVERY_ATTEMPTED: "delivery_attempted",
  FAILED_DELIVERY_FOLLOWUP: "failed_delivery_followup",
  REDELIVERY_SCHEDULED: "redelivery_scheduled",
  RETURN_INITIATED_CUST: "return_initiated_cust",
  ORDER_DELIVERED: "order_delivered",
  ABANDONED_CHECKOUT: "abandoned_checkout",
  FEEDBACK_REQUEST: "request",
  YOUR_ORDER_IS_SHIPPED: "your_order_is_shipped_2025",
  ORDER_PLACED: "order_placed" // optional
};

if (!WHATSAPP_NUMBER_ID || !WHATSAPP_TOKEN || !SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
  console.error("❌ Missing required env vars. Set WHATSAPP_NUMBER_ID, WHATSAPP_TOKEN, SHOPIFY_SHOP, SHOPIFY_ACCESS_TOKEN.");
  process.exit(1);
}

/**
 * Button payload strings
 * If your Meta templates use different payload text, update these values.
 * Keep payload naming consistent across Meta template and code.
 */
const PAYLOADS = {
  CONFIRM_ORDER: "CONFIRM_ORDER",
  CANCEL_ORDER: "CANCEL_ORDER",
  DELIVERED_OK: "DELIVERED_OK",
  NEED_HELP: "NEED_HELP",
  REDELIVER_TOMORROW: "REDELIVER_TOMORROW",
  CANCEL_ORDER_RETURN: "CANCEL_ORDER_RETURN",
  TRY_AGAIN: "TRY_AGAIN",
  CANCEL_FAILED: "CANCEL_FAILED",
  RET_WRONG_ADDRESS: "RET_WRONG_ADDRESS",
  RET_NOT_AVAILABLE: "RET_NOT_AVAILABLE",
  RET_CHANGED_MIND: "RET_CHANGED_MIND",
  RET_CONTACT_SUPPORT: "RET_CONTACT_SUPPORT",
  CONFIRM_AVAILABLE_TODAY: "CONFIRM_AVAILABLE_TODAY",
  RETRY_DELIVERY: "RETRY_DELIVERY",
};

/**
 * In-memory stores (demo). Use DB for production.
 * - orderMeta: orderId -> { phone, name, createdAt, status }
 * - recentOrders: phone -> orderId (latest) (for mapping incoming WA messages)
 */
const orderMeta = new Map();
const recentOrders = new Map();
const msgToOrder = new Map();

/* ---------- Helpers ---------- */
function normalizePhone(raw, defaultCC = DEFAULT_COUNTRY_CODE) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("0") && defaultCC) return `${defaultCC}${digits.slice(1)}`;
  if (defaultCC && digits.startsWith(defaultCC)) return digits;
  if (defaultCC && digits.length <= 10) return `${defaultCC}${digits}`;
  return digits;
}

async function sendWhatsAppTemplate(to, templateName, components = [], lang = "en") {
  try {
    const url = `https://graph.facebook.com/v19.0/${WHATSAPP_NUMBER_ID}/messages`;
    const body = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: templateName, language: { code: lang }, components },
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) console.error("❌ WhatsApp API error:", res.status, json);
    else console.log("✅ sent template", templateName, "to", to, "=>", JSON.stringify(json));
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
      headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ order: { id: orderId, note: noteText } }),
    });
    const json = await res.json();
    if (!res.ok) console.error("❌ Shopify update error:", res.status, json);
    else console.log("✅ Shopify note updated for", orderId);
    return json;
  } catch (err) {
    console.error("❌ updateShopifyOrderNote error:", err);
    throw err;
  }
}

function buildProductUrl(lineItem) {
  const handle = lineItem?.handle;
  if (handle && SHOPIFY_STOREFRONT_DOMAIN) return `https://${SHOPIFY_STOREFRONT_DOMAIN}/products/${handle}`;
  return DEFAULT_PRODUCT_URL || (SHOPIFY_STOREFRONT_DOMAIN ? `https://${SHOPIFY_STOREFRONT_DOMAIN}` : `https://${SHOPIFY_SHOP}`);
}
function buildCheckoutUrl() {
  return DEFAULT_CHECKOUT_URL || (SHOPIFY_STOREFRONT_DOMAIN ? `https://${SHOPIFY_STOREFRONT_DOMAIN}/cart` : `https://${SHOPIFY_SHOP}`);
}
function buildTrackingUrl(trackingUrl, trackingNumber) {
  if (trackingUrl) return trackingUrl;
  if (trackingNumber) return `https://${SHOPIFY_STOREFRONT_DOMAIN || SHOPIFY_SHOP}/apps/track?tn=${encodeURIComponent(trackingNumber)}`;
  return `https://${SHOPIFY_STOREFRONT_DOMAIN || SHOPIFY_SHOP}/pages/track-order`;
}

/* ---------- Webhook verify (Meta) ---------- */
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

/* ---------- Body parsers ---------- */
// We use express.raw for Shopify route below so don't app.use(express.json()) globally before that.
// But we will enable json for other routes:
app.use((req, res, next) => {
  // do not parse raw Shopify POST (we set raw for that route)
  next();
});
app.use(express.json());

/* ---------- Safe parse helper for Shopify raw body ---------- */
function parseShopifyRaw(req) {
  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    return JSON.parse(req.body.toString("utf8"));
  }
  if (typeof req.body === "string") return JSON.parse(req.body);
  return req.body;
}

/* ---------- SHOPIFY: orders/create ---------- */
app.post("/webhook/shopify", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    // Optional HMAC verify
    if (SHOPIFY_WEBHOOK_SECRET) {
      const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
      const digest = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET).update(req.body).digest("base64");
      if (digest !== hmacHeader) {
        console.warn("❌ Shopify HMAC verification failed");
        return res.sendStatus(401);
      }
    }

    const data = parseShopifyRaw(req);
    console.log("🧾 Shopify order created:", data.id);

    const checkoutPhone = data.shipping_address?.phone || data.billing_address?.phone || data.customer?.phone;
    const phone = normalizePhone(checkoutPhone);
    if (!phone) {
      console.warn("❌ No phone in order:", data.id);
      return res.status(200).send("No phone — ignoring");
    }

    // Extract fields (match your locked template variable order)
    const firstName = data.customer?.first_name || data.billing_address?.first_name || data.shipping_address?.first_name || "Customer";
    const orderId = data.id;
    const total = String(data.total_price || data.subtotal_price || "0");
    const currency = data.currency || data.total_price_set?.shop_money?.currency_code || "PKR";
    const firstLine = data.line_items?.[0] || {};
    const firstProduct = firstLine?.title || "Product";
    const quantity = String(firstLine?.quantity || 1);
    const storeName = STORE_NAME || SHOPIFY_SHOP;

    // store order meta (for reminder + mapping)
    orderMeta.set(orderId, {
      phone,
      name: firstName,
      createdAt: Date.now(),
      status: "pending", // pending / confirmed / cancelled
      product: firstProduct,
      qty: quantity,
      total,
      currency,
    });
    recentOrders.set(phone, orderId);

    // Build components for order_confirmation (exact placeholders order)
    const components = [{
      type: "body",
      parameters: [
        { type: "text", text: firstName },        // {{1}} Customer First Name
        { type: "text", text: String(orderId) },  // {{2}} Order ID
        { type: "text", text: firstProduct },     // {{3}} Product Name
        { type: "text", text: quantity },         // {{4}} Quantity
        { type: "text", text: storeName },        // {{5}} Store Name
        { type: "text", text: total },            // {{6}} Total Price
        { type: "text", text: currency },         // {{7}} Currency
      ],
    }];

    const waResp = await sendWhatsAppTemplate(phone, TPL.ORDER_CONFIRMATION, components);
    const msgId = waResp?.messages?.[0]?.id;
    if (msgId) msgToOrder.set(msgId, orderId);

    await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.ORDER_CONFIRMATION} (msgId: ${msgId || "N/A"})`);

    // Respond 200 to Shopify
    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Shopify webhook handler error:", err);
    return res.sendStatus(500);
  }
});

/* ---------- WA WEBHOOK (messages + statuses + buttons) ---------- */
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    console.log("📲 WA webhook:", JSON.stringify(req.body, null, 2));
    res.sendStatus(200); // ack quickly

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value) return;

    // handle statuses (delivery receipts)
    if (Array.isArray(value.statuses)) {
      value.statuses.forEach(s => {
        const oid = msgToOrder.get(s.id);
        if (oid) console.log(`🔔 status ${s.status} for order ${oid}`);
      });
      return;
    }

    const msg = value.messages?.[0];
    if (!msg) return;
    console.log("✉️ Incoming WA message:", msg);

    const from = msg.from; // customer's wa id (e.g. 92300...)
    const phone = normalizePhone(from);
    const orderId = recentOrders.get(phone) || [...orderMeta.entries()].find(([k,v])=>v.phone===phone)?.[0];

    if (!orderId) {
      console.warn("⚠️ No mapped order for incoming WA from", phone);
      return;
    }

    // handle interactive button types
if (msg.type === "button") {
  const payload = msg.button?.payload;
  console.log("🔘 Button payload:", payload, "from", phone, "order", orderId);

  const orderRef = db.ref("orders").child(orderId);
  const snapshot = await orderRef.get();
  let meta = snapshot.exists() ? snapshot.val() : {};
  meta.phone = phone;
  meta.updatedAt = Date.now();

  switch (payload) {
    case PAYLOADS.CONFIRM_ORDER:
      meta.status = "confirmed";
      await orderRef.set(meta);
      await updateShopifyOrderNote(orderId, "✅ Order Confirmed via WhatsApp");
      await sendWhatsAppTemplate(phone, TPL.ORDER_CONFIRMED_REPLY, [{
        type: "body",
        parameters: [
          { type: "text", text: meta.name || "Customer" },
          { type: "text", text: String(orderId) },
        ],
      }]);
      break;

    case PAYLOADS.CANCEL_ORDER:
      meta.status = "cancelled";
      await orderRef.set(meta);
      await updateShopifyOrderNote(orderId, "❌ Order Cancelled via WhatsApp");
      await sendWhatsAppTemplate(phone, TPL.ORDER_CANCELLED_REPLY_AUTO, [{
        type: "body",
        parameters: [{ type: "text", text: String(orderId) }],
      }]);
      break;

    case PAYLOADS.DELIVERED_OK:
      meta.status = "delivered_ok";
      await orderRef.set(meta);
      await updateShopifyOrderNote(orderId, "✅ Customer confirmed delivery OK");
      break;

    case PAYLOADS.NEED_HELP:
      meta.status = "need_help";
      await orderRef.set(meta);
      await updateShopifyOrderNote(orderId, "🆘 Customer needs help after delivery");
      break;

    case PAYLOADS.REDELIVER_TOMORROW:
    case PAYLOADS.RETRY_DELIVERY:
      meta.status = "redelivery";
      await orderRef.set(meta);
      await updateShopifyOrderNote(orderId, "🚚 Redelivery requested by customer");
      await sendWhatsAppTemplate(phone, TPL.REDELIVERY_SCHEDULED, [{
        type: "body",
        parameters: [
          { type: "text", text: String(orderId) },
          { type: "text", text: "Tomorrow" },
          { type: "text", text: "10am–6pm" },
          { type: "text", text: "Courier" },
          { type: "text", text: meta.total || "—" },
          { type: "text", text: meta.currency || "PKR" },
        ],
      }]);
      break;

    default:
      meta.status = `action_${payload}`;
      await orderRef.set(meta);
      await updateShopifyOrderNote(orderId, `ℹ️ User action: ${payload}`);
  }
}
  } catch (err) {
    console.error("❌ WA webhook handler error:", err);
  }
});

/* ---------- Courier webhook / fulfillment events ---------- */
app.post("/webhook/courier", express.json(), async (req, res) => {
  try {
    const p = req.body;
    console.log("🚚 Courier event:", JSON.stringify(p, null, 2));
    const phone = normalizePhone(p.phone);
    const orderId = p.orderId;
    if (!phone || !orderId) return res.sendStatus(200);

    if (!recentOrders.get(phone)) recentOrders.set(phone, orderId);
    const meta = orderMeta.get(orderId) || {};
    meta.phone = phone;
    meta.name = meta.name || p.name || "Customer";
    meta.product = meta.product || p.product_title;
    meta.total = meta.total || p.price;
    meta.currency = meta.currency || p.currency || "PKR";
    orderMeta.set(orderId, meta);

    const trackingUrl = buildTrackingUrl(p.tracking_url, p.tracking_no);

    switch ((p.status || "").toLowerCase()) {
      case "shipped":
        // your_order_is_shipped_2025 — body {{1}} = order id ; URL button param = trackingUrl
        await sendWhatsAppTemplate(phone, TPL.YOUR_ORDER_IS_SHIPPED, [
          { type: "body", parameters: [{ type: "text", text: String(orderId) }] },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: trackingUrl }],
          },
        ]);
        await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.YOUR_ORDER_IS_SHIPPED}`);
        break;

      case "attempted":
        await sendWhatsAppTemplate(phone, TPL.DELIVERY_ATTEMPTED, [
          { type: "body", parameters: [{ type: "text", text: meta.name || "Customer" }, { type: "text", text: String(orderId) }] },
        ]);
        await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.DELIVERY_ATTEMPTED}`);
        break;

      case "pending":
        await sendWhatsAppTemplate(phone, TPL.FAILED_DELIVERY_FOLLOWUP, [
          { type: "body", parameters: [{ type: "text", text: meta.name || "Customer" }, { type: "text", text: String(orderId) }] },
        ]);
        await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.FAILED_DELIVERY_FOLLOWUP}`);
        break;

      case "delivered":
        await sendWhatsAppTemplate(phone, TPL.ORDER_DELIVERED, [
          { type: "body", parameters: [{ type: "text", text: meta.name || "Customer" }, { type: "text", text: String(orderId) }] },
        ]);
        await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.ORDER_DELIVERED}`);
        // optional feedback prompt
        await sendWhatsAppTemplate(phone, TPL.FEEDBACK_REQUEST, [
          { type: "body", parameters: [{ type: "text", text: meta.name || "Customer" }] },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: buildProductUrl({ handle: p.product_handle }) }],
          },
        ]);
        break;

      case "rto":
      case "return_initiated":
        await sendWhatsAppTemplate(phone, TPL.RETURN_INITIATED_CUST, [
          { type: "body", parameters: [{ type: "text", text: String(orderId) }] },
        ]);
        await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.RETURN_INITIATED_CUST}`);
        break;

      case "dispatch_reminder":
        await sendWhatsAppTemplate(phone, TPL.ORDER_DISPATCH_REMINDER, [
          { type: "body", parameters: [{ type: "text", text: meta.name || "Customer" }, { type: "text", text: String(orderId) }, { type: "text", text: meta.product || "Product" }] },
        ]);
        await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.ORDER_DISPATCH_REMINDER}`);
        break;

      default:
        console.log("ℹ️ Unknown courier status:", p.status);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ courier webhook error:", err);
    res.sendStatus(500);
  }
});

/* ---------- Abandoned checkout trigger (manual) ---------- */
app.post("/trigger/abandoned", express.json(), async (req, res) => {
  try {
    const { phone, name, checkout_url } = req.body;
    const to = normalizePhone(phone);
    if (!to) return res.status(400).json({ error: "phone required" });
    const url = checkout_url || buildCheckoutUrl();
    await sendWhatsAppTemplate(to, TPL.ABANDONED_CHECKOUT, [
      { type: "body", parameters: [{ type: "text", text: name || "Friend" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: url }] },
    ]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ trigger/abandoned error:", err);
    return res.sendStatus(500);
  }
});

/* ---------- Periodic job: reminders (runs every minute) ----------
   - Checks orderMeta for pending orders older than 6 hours and not confirmed/cancelled,
   - Sends second confirmation reminder (you must have template approved: could reuse order_confirmation or create a reminder template)
*/
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const REMINDER_INTERVAL_MS = 60 * 1000; // every 60s for demo; adjust lower frequency in prod

setInterval(async () => {
  try {
    const now = Date.now();
    for (const [orderId, meta] of orderMeta.entries()) {
      if (!meta || !meta.createdAt) continue;
      if (meta.status === "pending" && now - meta.createdAt > SIX_HOURS_MS && !meta.reminderSent) {
        // send second confirmation (we'll reuse ORDER_CONFIRMATION template for reminder)
        const to = meta.phone;
        if (!to) continue;
        const components = [{
          type: "body",
          parameters: [
            { type: "text", text: meta.name || "Customer" },
            { type: "text", text: String(orderId) },
            { type: "text", text: meta.product || "Product" },
            { type: "text", text: meta.qty || "1" },
            { type: "text", text: meta.store || STORE_NAME || SHOPIFY_SHOP },
            { type: "text", text: meta.total || "—" },
            { type: "text", text: meta.currency || "PKR" },
          ],
        }];
        console.log("⏰ Sending 2nd confirmation reminder for order", orderId);
        await sendWhatsAppTemplate(to, TPL.ORDER_CONFIRMATION, components);
        await updateShopifyOrderNote(orderId, "WhatsApp: 2nd confirmation reminder sent");
        meta.reminderSent = true;
        orderMeta.set(orderId, meta);
      }
    }
  } catch (err) {
    console.error("❌ Reminder interval error:", err);
  }
}, REMINDER_INTERVAL_MS);

/* ---------- Health & demo ---------- */
app.get("/", (_req, res) => res.send("✅ Automation service running"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Demo send (manual test)
app.get("/demo/send", async (req, res) => {
  try {
    const to = normalizePhone(req.query.to || "");
    if (!to) return res.status(400).json({ error: "Provide ?to=923XXXXXXXXX" });
    const orderId = `TEST-${Date.now()}`;
    const components = [{
      type: "body",
      parameters: [
        { type: "text", text: "TestUser" },
        { type: "text", text: orderId },
        { type: "text", text: "Sample Product" },
        { type: "text", text: "1" },
        { type: "text", text: STORE_NAME || SHOPIFY_SHOP },
        { type: "text", text: "1000" },
        { type: "text", text: "PKR" },
      ],
    }];
    await sendWhatsAppTemplate(to, TPL.ORDER_CONFIRMATION, components);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error" });
  }
});

/* ---------- Start server ---------- */
app.listen(PORT, () => console.log(`⚡ Server running on port ${PORT}`));














