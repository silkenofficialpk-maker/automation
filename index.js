// index.js
import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();

/**
 * Required ENV
 * ----------
 * WHATSAPP_NUMBER_ID
 * WHATSAPP_TOKEN
 * SHOPIFY_SHOP                  e.g. mystore.myshopify.com
 * SHOPIFY_ACCESS_TOKEN
 * VERIFY_TOKEN_META             e.g. "shopify123"
 *
 * Optional (strongly recommended)
 * ----------
 * STORE_NAME                    Friendly store name (fallback: SHOPIFY_SHOP)
 * DEFAULT_COUNTRY_CODE          default "92"
 * SHOPIFY_WEBHOOK_SECRET        if using HMAC (optional)
 * SHOPIFY_STOREFRONT_DOMAIN     e.g. mystore.com  (for product/review links)
 * DEFAULT_PRODUCT_URL           fallback product page url if handle absent
 * DEFAULT_CHECKOUT_URL          fallback checkout url for abandoned
 *
 * PORT                          default 3000
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

  SHOPIFY_STOREFRONT_DOMAIN,     // e.g. mystore.com
  DEFAULT_PRODUCT_URL,           // e.g. https://mystore.com/collections/all
  DEFAULT_CHECKOUT_URL,          // e.g. https://mystore.com/cart

  PORT = 3000,
} = process.env;

// Template names (LOCKED per your list)
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
};

if (!WHATSAPP_NUMBER_ID || !WHATSAPP_TOKEN || !SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
  console.error("❌ Missing required env. Set WHATSAPP_NUMBER_ID, WHATSAPP_TOKEN, SHOPIFY_SHOP, SHOPIFY_ACCESS_TOKEN.");
  process.exit(1);
}

const recentOrders = new Map(); // phone -> { orderId, createdAt }
const msgToOrder = new Map();   // waMessageId -> orderId (optional)

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

async function sendWhatsAppTemplate(to, templateName, components = [], lang = "en") {
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
  if (!res.ok) {
    console.error("❌ WhatsApp API error:", res.status, JSON.stringify(json));
  } else {
    console.log("✅ WhatsApp API OK:", JSON.stringify(json));
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
  } else {
    console.log("✅ Shopify order note updated:", json?.order?.id);
  }
  return json;
}

// Build URLs (best-effort fallbacks)
function buildProductUrl(lineItem) {
  // If we have storefront domain + product handle (not in all webhooks)
  const handle = lineItem?.handle; // rarely present in order webhook
  if (handle && SHOPIFY_STOREFRONT_DOMAIN) {
    return `https://${SHOPIFY_STOREFRONT_DOMAIN}/products/${handle}`;
  }
  // fallback configured
  return DEFAULT_PRODUCT_URL || (SHOPIFY_STOREFRONT_DOMAIN ? `https://${SHOPIFY_STOREFRONT_DOMAIN}` : `https://${SHOPIFY_SHOP}`);
}

function buildCheckoutUrl(data) {
  // If you capture checkout_url in app/db, plug here. Else fallback:
  return DEFAULT_CHECKOUT_URL || (SHOPIFY_STOREFRONT_DOMAIN ? `https://${SHOPIFY_STOREFRONT_DOMAIN}/cart` : `https://${SHOPIFY_SHOP}`);
}

function buildTrackingUrl(trackingUrl, trackingNumber) {
  if (trackingUrl) return trackingUrl;
  if (trackingNumber) {
    // generic fallback tracker page pattern (adjust to your courier)
    return `https://${SHOPIFY_STOREFRONT_DOMAIN || SHOPIFY_SHOP}/apps/track?tn=${encodeURIComponent(trackingNumber)}`;
  }
  return `https://${SHOPIFY_STOREFRONT_DOMAIN || SHOPIFY_SHOP}/pages/track-order`;
}

// ------------- WEBHOOK VERIFY (Meta) -------------
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

// Parse JSON for non-Shopify
app.use(express.json());

// ------------- SHOPIFY: orders/create -------------
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

    // ✅ Safe parse
    let data;
    if (Buffer.isBuffer(req.body)) {
      data = JSON.parse(req.body.toString("utf8"));
    } else if (typeof req.body === "string") {
      data = JSON.parse(req.body);
    } else {
      data = req.body; // already object
    }

    console.log("🧾 Shopify webhook order:", data.id);

    // (rest of your logic remains same...)


    const checkoutPhone = data.shipping_address?.phone || data.billing_address?.phone || data.customer?.phone;
    const phone = normalizePhone(checkoutPhone);
    if (!phone) {
      console.warn("❌ No phone in order:", data.id);
      return res.status(200).send("No phone — ignoring");
    }

    // Extract fields (strictly matching your locked template orders)
    const firstName =
      data.customer?.first_name ||
      data.billing_address?.first_name ||
      data.shipping_address?.first_name ||
      "Customer";
    const orderId = data.id;
    const total = String(data.total_price || data.subtotal_price || "0");
    const currency = data.currency || data.total_price_set?.shop_money?.currency_code || "PKR";
    const firstLine = data.line_items?.[0] || {};
    const firstProduct = firstLine?.title || "Product";
    const quantity = String(firstLine?.quantity || 1);
    const storeName = STORE_NAME || SHOPIFY_SHOP;

    // map phone -> order
    recentOrders.set(phone, { orderId, createdAt: Date.now() });

    // ===== Send order_confirmation =====
    // Hello {{1}}, your order #{{2}} of {{3}} ({{4}}) from {{5}} worth {{6}} {{7}} has been placed. Please confirm…
    const components = [{
      type: "body",
      parameters: [
        { type: "text", text: firstName },        // {{1}}
        { type: "text", text: String(orderId) },  // {{2}}
        { type: "text", text: firstProduct },     // {{3}}
        { type: "text", text: quantity },         // {{4}}
        { type: "text", text: storeName },        // {{5}}
        { type: "text", text: total },            // {{6}}
        { type: "text", text: currency },         // {{7}}
      ],
    }];

    const waResp = await sendWhatsAppTemplate(phone, TPL.ORDER_CONFIRMATION, components);
    const msgId = waResp?.messages?.[0]?.id;
    if (msgId) msgToOrder.set(msgId, orderId);

    await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.ORDER_CONFIRMATION} (msgId: ${msgId || "N/A"})`);

    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Shopify webhook handler error:", err);
    return res.sendStatus(500);
  }
});

// ------------- WHATSAPP: incoming/status/button -------------
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    console.log("📲 WA webhook payload:", JSON.stringify(req.body, null, 2));
    res.sendStatus(200); // ACK fast

    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value) return;

    // Status receipts
    if (Array.isArray(value.statuses)) {
      // Map back to order if we stored msgId
      value.statuses.forEach(s => {
        const oid = msgToOrder.get(s.id);
        if (oid) console.log(`🔔 Status ${s.status} for order ${oid}`);
      });
      return;
    }

    // Incoming messages / button replies
    const msg = value.messages?.[0];
    if (!msg) return;

    const from = msg.from; // 923xxxxxxxxx
    const mapped = recentOrders.get(from) || recentOrders.get(normalizePhone(from));
    const orderId = mapped?.orderId;

    // Only handle interactive button payloads defined below
    if (msg.type === "button") {
      const payload = msg.button?.payload;
      if (!orderId) {
        console.warn("⚠️ No order mapped for", from, "payload:", payload);
        return;
      }

      switch (payload) {
        case "CONFIRM_ORDER": {
          await updateShopifyOrderNote(orderId, "✅ Order Confirmed via WhatsApp");
          // order_confirmed_reply: Thanks {{1}} — your order #{{2}} is confirmed...
          const name = "Customer"; // we can’t access order JSON here; OK to use generic or cache name too
          await sendWhatsAppTemplate(from, TPL.ORDER_CONFIRMED_REPLY, [{
            type: "body",
            parameters: [
              { type: "text", text: name },               // {{1}}
              { type: "text", text: String(orderId) },    // {{2}}
            ],
          }]);
          break;
        }

        case "CANCEL_ORDER": {
          await updateShopifyOrderNote(orderId, "❌ Order Cancelled via WhatsApp");
          // order_cancelled_reply_auto: Your order #{{1}} has been cancelled as requested.
          await sendWhatsAppTemplate(from, TPL.ORDER_CANCELLED_REPLY_AUTO, [{
            type: "body",
            parameters: [{ type: "text", text: String(orderId) }], // {{1}}
          }]);
          break;
        }

        case "DELIVERED_OK": {
          await updateShopifyOrderNote(orderId, "✅ Customer marked delivered OK");
          break;
        }
        case "NEED_HELP": {
          await updateShopifyOrderNote(orderId, "🆘 Customer needs help");
          break;
        }

        case "RETRY_DELIVERY":
        case "REDELIVER_TOMORROW": {
          await updateShopifyOrderNote(orderId, "🚚 Redelivery requested");
          // redelivery_scheduled requires: order id, day, time, courier, total, currency
          const day = "Tomorrow";
          const time = "10am–6pm";
          const courier = "Courier";
          const total = "—";
          const currency = "PKR";
          await sendWhatsAppTemplate(from, TPL.REDELIVERY_SCHEDULED, [{
            type: "body",
            parameters: [
              { type: "text", text: String(orderId) }, // {{1}}
              { type: "text", text: day },             // {{2}}
              { type: "text", text: time },            // {{3}}
              { type: "text", text: courier },         // {{4}}
              { type: "text", text: total },           // {{5}}
              { type: "text", text: currency },        // {{6}}
            ],
          }]);
          break;
        }

        case "CANCEL_ORDER_RETURN":
        case "CANCEL": {
          await updateShopifyOrderNote(orderId, "❌ Customer requested cancel/return on failed delivery");
          // order_cancelled_reply_auto
          await sendWhatsAppTemplate(from, TPL.ORDER_CANCELLED_REPLY_AUTO, [{
            type: "body",
            parameters: [{ type: "text", text: String(orderId) }],
          }]);
          break;
        }

        case "CONFIRM_AVAILABLE_TODAY": {
          await updateShopifyOrderNote(orderId, "✅ Customer available for delivery today");
          break;
        }

        // Return reason capture
        case "RET_WRONG_ADDRESS":
        case "RET_NOT_AVAILABLE":
        case "RET_CHANGED_MIND":
        case "RET_CONTACT_SUPPORT": {
          await updateShopifyOrderNote(orderId, `↩️ Return reason: ${payload}`);
          break;
        }

        default:
          await updateShopifyOrderNote(orderId, `ℹ️ User action: ${payload}`);
      }
    }
  } catch (err) {
    console.error("❌ WA webhook handler error:", err);
  }
});

// ------------- COURIER / FULFILLMENT EVENTS -------------
// Send shipped / attempted / delivered updates here from your courier webhook OR your own job.
app.post("/webhook/courier", express.json(), async (req, res) => {
  try {
    const p = req.body;
    console.log("🚚 Courier event:", JSON.stringify(p, null, 2));
    // Expecting at least: phone, orderId, status, tracking_url?, tracking_no?, courier?, product_title?, price?, currency?
    const phone = normalizePhone(p.phone);
    const orderId = p.orderId;
    if (!phone || !orderId) return res.sendStatus(200);

    // cache mapping for reply flow if not present
    if (!recentOrders.get(phone)) recentOrders.set(phone, { orderId, createdAt: Date.now() });

    // Compute variables
    const trackingUrl = buildTrackingUrl(p.tracking_url, p.tracking_no);
    const name = p.name || "Customer";
    const productTitle = p.product_title || "Product";
    const price = p.price || "—";
    const currency = p.currency || "PKR";
    const courier = p.courier || "Courier";

    switch ((p.status || "").toLowerCase()) {
      case "shipped": {
        // your_order_is_shipped_2025: body {{1}} = order id; URL button param {{1}} = trackingUrl
        const components = [
          {
            type: "body",
            parameters: [{ type: "text", text: String(orderId) }], // {{1}}
          },
          // If your template has URL button with a variable:
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: trackingUrl }], // {{1}} for URL button
          },
        ];
        await sendWhatsAppTemplate(phone, TPL.YOUR_ORDER_IS_SHIPPED, components);
        await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.YOUR_ORDER_IS_SHIPPED}`);
        break;
      }

      case "attempted": {
        // delivery_attempted: name, order id + buttons (Redeliver Tomorrow / Cancel Order / Return)
        const components = [{
          type: "body",
          parameters: [
            { type: "text", text: name },              // {{1}}
            { type: "text", text: String(orderId) },   // {{2}}
          ],
        }];
        await sendWhatsAppTemplate(phone, TPL.DELIVERY_ATTEMPTED, components);
        await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.DELIVERY_ATTEMPTED}`);
        break;
      }

      case "pending": {
        // failed_delivery_followup: name, order id (Try Again / Cancel)
        const components = [{
          type: "body",
          parameters: [
            { type: "text", text: name },              // {{1}}
            { type: "text", text: String(orderId) },   // {{2}}
          ],
        }];
        await sendWhatsAppTemplate(phone, TPL.FAILED_DELIVERY_FOLLOWUP, components);
        await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.FAILED_DELIVERY_FOLLOWUP}`);
        break;
      }

      case "delivered": {
        // order_delivered: name, order id (Yes all good / Need help)
        const components = [{
          type: "body",
          parameters: [
            { type: "text", text: name },              // {{1}}
            { type: "text", text: String(orderId) },   // {{2}}
          ],
        }];
        await sendWhatsAppTemplate(phone, TPL.ORDER_DELIVERED, components);
        await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.ORDER_DELIVERED}`);
        // Optional: feedback template after delivered
        const productUrl = buildProductUrl({}); // best-effort
        await sendWhatsAppTemplate(phone, TPL.FEEDBACK_REQUEST, [
          { type: "body", parameters: [{ type: "text", text: name }] }, // {{1}}
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: productUrl }], // {{1}} URL param
          },
        ]);
        break;
      }

      case "rto":
      case "return_initiated": {
        // return_initiated_cust: order id; buttons with reasons
        const components = [{
          type: "body",
          parameters: [{ type: "text", text: String(orderId) }], // {{1}}
        }];
        await sendWhatsAppTemplate(phone, TPL.RETURN_INITIATED_CUST, components);
        await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.RETURN_INITIATED_CUST}`);
        break;
      }

      case "dispatch_reminder": {
        // order_dispatch_reminder: name, order id, product name
        const components = [{
          type: "body",
          parameters: [
            { type: "text", text: name },                // {{1}}
            { type: "text", text: String(orderId) },     // {{2}}
            { type: "text", text: productTitle },        // {{3}}
          ],
        }];
        await sendWhatsAppTemplate(phone, TPL.ORDER_DISPATCH_REMINDER, components);
        await updateShopifyOrderNote(orderId, `WhatsApp: sent ${TPL.ORDER_DISPATCH_REMINDER}`);
        break;
      }

      default:
        console.log("ℹ️ Unhandled courier status:", p.status);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Courier webhook handler error:", err);
    res.sendStatus(500);
  }
});

// ------------- ABANDONED CHECKOUT TRIGGER (optional) -------------
// If you wire Shopify "carts/update" or your own cron — call this.
app.post("/trigger/abandoned", express.json(), async (req, res) => {
  try {
    const { phone, name, checkout_url } = req.body;
    const to = normalizePhone(phone);
    if (!to) return res.status(400).json({ error: "phone required" });

    const url = checkout_url || buildCheckoutUrl({});
    const components = [
      { type: "body", parameters: [{ type: "text", text: name || "Friend" }] }, // {{1}}
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: url }], // {{1}} URL param
      },
    ];
    await sendWhatsAppTemplate(to, TPL.ABANDONED_CHECKOUT, components);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// Health
app.get("/", (_req, res) => res.send("✅ Service running"));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`⚡ Server running on port ${PORT}`));

