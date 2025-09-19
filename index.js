process.on("uncaughtException", (err) => {
  console.error("🔥 Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 Unhandled Rejection:", reason);
});

import express from "express";
import crypto from "crypto";
import axios from "axios";
import admin from "firebase-admin";

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"), }),
  databaseURL: process.env.DATABASE_URL,
});

console.log("✅ Firebase initialized for project:", process.env.FIREBASE_PROJECT_ID);

// ✅ Test Firebase Realtime Database
const db = admin.database();
db.ref("railway_test")
  .set({ status: "ok", time: Date.now() })
  .then(() => {
    console.log("✅ Database write test successful");
    return db.ref("railway_test").once("value");
  })
  .then((snapshot) => {
    console.log("✅ Database read test:", snapshot.val());
  })
  .catch((err) => {
    console.error("❌ Database test failed:", err.message);
  });



// ---- Express Setup ----

const app = express();

app.use(express.json());




// ---- ENV Vars ----
const {
  WHATSAPP_NUMBER_ID,
  WHATSAPP_TOKEN,
  SHOPIFY_SHOP,
  SHOPIFY_ACCESS_TOKEN,
  VERIFY_TOKEN_META = "shopify123",
  DEFAULT_COUNTRY_CODE = "92",
} = process.env;

if (!WHATSAPP_NUMBER_ID || !WHATSAPP_TOKEN || !SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
  console.error("❌ Missing required env vars.");
  process.exit(1);
}

// ---- WhatsApp Template Names ----
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
  ORDER_PLACED: "order_placed",
};

// ---- Button Payloads ----
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
// ---- Firebase DB Helpers ----
const dbSet = (path, data) => db.ref(path).set(data);
const dbGet = async (path) => {
  const snap = await db.ref(path).once("value");
  return snap.val();
};
const dbUpdate = (path, data) => db.ref(path).update(data);

// ---- Phone Normalization ----
function normalizePhone(raw, defaultCC = DEFAULT_COUNTRY_CODE) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("0") && defaultCC) return `${defaultCC}${digits.slice(1)}`;
  if (defaultCC && digits.startsWith(defaultCC)) return digits;
  if (defaultCC && digits.length <= 10) return `${defaultCC}${digits}`;
  return digits;
}

// ---- Extended WhatsApp Template Sender ----
async function sendWhatsAppTemplate(phone, templateName, params = {}) {
  try {
    const components = [];

    // Body params (dynamic count)
    if (params.body && params.body.length > 0) {
      components.push({
        type: "body",
        parameters: params.body.map((p) => ({
          type: "text",
          text: String(p),
        })),
      });
    }

    // Header params (e.g., invoice number, image, etc.)
    if (params.header && params.header.length > 0) {
      components.push({
        type: "header",
        parameters: params.header.map((p) => ({
          type: "text",
          text: String(p),
        })),
      });
    }

    // Button params (e.g., quick replies or URL buttons)
    if (params.button && params.button.length > 0) {
      params.button.forEach((btn, index) => {
        components.push({
          type: "button",
          sub_type: btn.sub_type || "quick_reply", // "quick_reply" or "url"
          index: String(index),
          parameters: [
            btn.sub_type === "url"
              ? { type: "text", text: String(btn.value) } // url button requires "text"
              : { type: "payload", payload: String(btn.value) }, // quick_reply requires "payload"
          ],
        });
      });
    }

    const resp = await axios.post(
      `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en" },
          components,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Sent template:", templateName, "to", phone);
    return resp.data;
  } catch (err) {
    console.error(
      "❌ WhatsApp Template Send Error:",
      err.response?.data || err.message
    );
    throw err;
  }
}


// ---- Shopify Order Note Updater ----
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
    if (!res.ok) console.error("❌ Shopify update error:", res.status, json);
    else console.log("✅ Order note updated for", orderId);
    return json;
  } catch (err) {
    console.error("❌ updateShopifyOrderNote error:", err);
    throw err;
  }
}
// ----------------- Meta (WhatsApp) Webhook -----------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN_META) {
    console.log("✅ Meta webhook verified");
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

app.post("/webhook", express.json(), async (req, res) => {
  try {
    const body = req.body;
    if (body.object) {
      console.log("📩 Incoming Meta webhook:", JSON.stringify(body, null, 2));

      // Example: handle WhatsApp messages
      const entry = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (entry && entry.from) {
        const from = normalizePhone(entry.from);
        const text = entry.text?.body || null;

        await dbSet(`/whatsapp/incoming/${Date.now()}`, { from, text });
        console.log("✅ Stored incoming WA msg from:", from);
      }
      return res.sendStatus(200);
    }
   
  } catch (err) {
    console.error("❌ WA webhook handler error:", err);
    res.sendStatus(500);
  }
});

// ----------------- Shopify Webhook -----------------
function verifyShopifyWebhook(req, res, buf) {
  try {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    if (!hmacHeader) return false;
    const hash = crypto
      .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
      .update(buf, "utf8")
      .digest("base64");
    return hash === hmacHeader;
  } catch {
    return false;
  }
}

app.post(
  "/shopify/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    
    try {
      const event = JSON.parse(req.body.toString("utf8"));
      console.log("📦 Shopify webhook received:", event);

      // Example: order create event
      if (event?.id && event?.email) {
        await dbSet(`/shopify/orders/${event.id}`, event);
        console.log("✅ Stored Shopify order:", event.id);
      }

      res.sendStatus(200);
    } catch (err) {
      console.error("❌ Shopify webhook handler error:", err);
      res.sendStatus(500);
    }
  }
);
// ----------------- COD Delivery & Return Logic -----------------

// Save order with COD status in Firebase
async function saveCODOrder(order) {
  const orderPath = `/orders/${order.id}`;
  await dbSet(orderPath, {
    ...order,
    status: "PENDING_COD",
    createdAt: Date.now(),
  });
  console.log("✅ COD order saved:", order.id);
}

// Update order status (Delivered, Returned, Cancelled, etc.)
async function updateOrderStatus(orderId, status) {
  const orderPath = `/orders/${orderId}`;
  await dbUpdate(orderPath, { status, updatedAt: Date.now() });
  console.log(`✅ Order ${orderId} status updated ->`, status);
}

// Send confirmation message to customer (COD flow)
// Send confirmation message to customer (COD flow)
async function sendOrderConfirmation(order) {
  const phone = normalizePhone(order.phone);
  if (!phone) return;

  await sendWhatsAppTemplate(phone, TPL.ORDER_CONFIRMATION, {
    body: [
      order.customerName || "Customer",   // {{1}} Hello NAME 👋
      order.id?.toString() || "-",        // {{2}} Order #
      order.productName || "Product",     // {{3}} Product name
      order.variant || "-",               // {{4}} Variant (e.g., Size/Color)
      order.storeName || "Our Store",     // {{5}} Store name
      order.total_price || "0",           // {{6}} Amount
      order.currency || "PKR",            // {{7}} Currency
    ],
  });

  console.log("📩 Sent COD confirmation to:", phone);
}


// Handle delivery attempt
async function deliveryAttempt(orderId, success = true) {
  const order = await dbGet(`/orders/${orderId}`);
  if (!order) return;

  if (success) {
    await updateOrderStatus(orderId, "DELIVERED");
    await sendWhatsAppTemplate(normalizePhone(order.phone), TPL.ORDER_DELIVERED);
  } else {
    await updateOrderStatus(orderId, "DELIVERY_FAILED");
    await sendWhatsAppTemplate(
      normalizePhone(order.phone),
      TPL.DELIVERY_ATTEMPTED
    );
  }
}

// Handle return process
async function processReturn(orderId, reason = "Customer Request") {
  const order = await dbGet(`/orders/${orderId}`);
  if (!order) return;

  await updateOrderStatus(orderId, "RETURN_INITIATED");
  await sendWhatsAppTemplate(normalizePhone(order.phone), TPL.RETURN_INITIATED_CUST, [
    {
      type: "body",
      parameters: [{ type: "text", text: reason }],
    },
  ]);
}
// ----------------- API Endpoints -----------------

// Save new COD order
app.post("/orders/cod", async (req, res) => {
  try {
    const order = req.body;
    if (!order.id) return res.status(400).json({ error: "Order ID required" });

    await saveCODOrder(order);
    await sendOrderConfirmation(order);

    res.json({ ok: true, msg: "COD order saved & confirmation sent" });
  } catch (err) {
    console.error("❌ Error saving COD order:", err);
    res.status(500).json({ error: err.message });
  }
});

// Mark order as delivered
app.post("/orders/:id/deliver", async (req, res) => {
  try {
    const { id } = req.params;
    await deliveryAttempt(id, true);
    res.json({ ok: true, msg: `Order ${id} marked as delivered ✅` });
  } catch (err) {
    console.error("❌ Error delivering order:", err);
    res.status(500).json({ error: err.message });
  }
});

// Mark order as delivery failed
app.post("/orders/:id/failed", async (req, res) => {
  try {
    const { id } = req.params;
    await deliveryAttempt(id, false);
    res.json({ ok: true, msg: `Order ${id} marked as failed ❌` });
  } catch (err) {
    console.error("❌ Error failing delivery:", err);
    res.status(500).json({ error: err.message });
  }
});

// Initiate return
app.post("/orders/:id/return", async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    await processReturn(id, reason || "No reason provided");
    res.json({ ok: true, msg: `Return initiated for order ${id} 🔄` });
  } catch (err) {
    console.error("❌ Error initiating return:", err);
    res.status(500).json({ error: err.message });
  }
});



// Parse raw body
function parseRawBody(req) {
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
  if (typeof req.body === "string") return JSON.parse(req.body);
  return req.body;
}

// Shopify → Order Created webhook
// ---- Shopify → Order Created webhook ----
app.post(
  "/webhook/shopify/order",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
     
res.sendStatus(200);
      const order = parseRawBody(req);
      console.log("🛒 Shopify Order Created:", order.id);

      // Save to Firebase
      await saveCODOrder({
        id: order.id,
        customerName: order.customer?.first_name || "Customer",
        phone: order.shipping_address?.phone || order.customer?.phone,
        total: order.total_price,
        currency: order.currency,
        product: order.line_items?.[0]?.title || "Product",
        qty: order.line_items?.[0]?.quantity || 1,
      });

      // Send WhatsApp Confirmation
      await sendOrderConfirmation({
        id: order.id,
        customerName: order.customer?.first_name || "Customer",
        phone: order.shipping_address?.phone || order.customer?.phone,
        total: order.total_price,
        currency: order.currency,
        product: order.line_items?.[0]?.title || "Product",
        qty: order.line_items?.[0]?.quantity || 1,
      });

      
    } catch (err) {
      console.error("❌ Shopify order webhook error:", err);
      res.sendStatus(500);
    }
  }
);


// Shopify → Order Cancelled webhook
app.post(
  "/webhook/shopify/cancel",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
    

      const order = parseRawBody(req);
      console.log("🚫 Shopify Order Cancelled:", order.id);

      // Update Firebase
      await db.ref("orders").child(order.id).update({ status: "cancelled" });

      // Send WhatsApp Cancellation
      await sendWhatsAppTemplate(
        normalizePhone(order.shipping_address?.phone || order.customer?.phone),
        "order_cancelled_reply_auto",
        [{ type: "body", parameters: [{ type: "text", text: String(order.id) }] }]
      );

      res.sendStatus(200);
    } catch (err) {
      console.error("❌ Shopify cancel webhook error:", err);
      res.sendStatus(500);
    }
  }
);
// WhatsApp Webhook (Messages + Button Clicks)
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    console.log("📩 WA Webhook:", JSON.stringify(req.body, null, 2));
    res.sendStatus(200); // Always ACK fast

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value) return;

    // ✅ Delivery Receipts (message status updates)
    if (Array.isArray(value.statuses)) {
      value.statuses.forEach((s) => {
        console.log(`📦 Status update: ${s.status} (msgId: ${s.id})`);
      });
      return;
    }

    // ✅ Incoming Customer Messages
    const msg = value.messages?.[0];
    if (!msg) return;

    const from = msg.from; // WhatsApp number
    const phone = normalizePhone(from);

    // 🟢 Button Click Handling
    if (msg.type === "button") {
      const payload = msg.button?.payload;
      console.log("🔘 Button clicked:", payload);

      const orderRef = db.ref("orders");
      const snapshot = await orderRef.orderByChild("phone").equalTo(phone).limitToLast(1).once("value");
      if (!snapshot.exists()) return;

      const [orderId, meta] = Object.entries(snapshot.val())[0];
      let newStatus = "pending";

      switch (payload) {
        case "CONFIRM_ORDER":
          newStatus = "confirmed";
          await sendWhatsAppTemplate(phone, "order_confirmed_reply", [
            { type: "body", parameters: [{ type: "text", text: meta.customerName }, { type: "text", text: orderId }] }
          ]);
          break;

        case "CANCEL_ORDER":
          newStatus = "cancelled";
          await sendWhatsAppTemplate(phone, "order_cancelled_reply_auto", [
            { type: "body", parameters: [{ type: "text", text: orderId }] }
          ]);
          break;

        case "REDELIVER_TOMORROW":
          newStatus = "redelivery";
          await sendWhatsAppTemplate(phone, "redelivery_scheduled", [
            { type: "body", parameters: [
              { type: "text", text: orderId },
              { type: "text", text: "Tomorrow" },
              { type: "text", text: "10am–6pm" }
            ] }
          ]);
          break;

        default:
          newStatus = `action_${payload}`;
      }

      await db.ref("orders").child(orderId).update({ status: newStatus, updatedAt: Date.now() });
      console.log(`✅ Order ${orderId} updated to ${newStatus}`);
    }
  } catch (err) {
    console.error("❌ WA webhook error:", err);
  }
});
// Courier Webhook (COD status updates)
app.post("/webhook/courier", express.json(), async (req, res) => {
  try {
    const p = req.body;
    console.log("🚚 Courier event:", JSON.stringify(p, null, 2));

    const phone = normalizePhone(p.phone);
    const orderId = p.orderId;
    if (!phone || !orderId) return res.sendStatus(200);

    const orderRef = db.ref("orders").child(orderId);
    const snap = await orderRef.once("value");
    let meta = snap.exists() ? snap.val() : {};
    meta.phone = phone;
    meta.updatedAt = Date.now();

    // tracking URL fallback
    const trackingUrl = p.tracking_url || (p.tracking_no ? `https://${SHOPIFY_SHOP}/apps/track?tn=${p.tracking_no}` : "");

    switch ((p.status || "").toLowerCase()) {
      case "shipped":
        await sendWhatsAppTemplate(phone, "your_order_is_shipped_2025", [
          { type: "body", parameters: [{ type: "text", text: String(orderId) }] },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: trackingUrl }]
          }
        ]);
        meta.status = "shipped";
        break;

      case "attempted":
        await sendWhatsAppTemplate(phone, "delivery_attempted", [
          { type: "body", parameters: [{ type: "text", text: meta.customerName || "Customer" }, { type: "text", text: orderId }] }
        ]);
        meta.status = "attempted";
        break;

      case "pending":
        await sendWhatsAppTemplate(phone, "failed_delivery_followup", [
          { type: "body", parameters: [{ type: "text", text: meta.customerName || "Customer" }, { type: "text", text: orderId }] }
        ]);
        meta.status = "pending_followup";
        break;

      case "delivered":
        await sendWhatsAppTemplate(phone, "order_delivered", [
          { type: "body", parameters: [{ type: "text", text: meta.customerName || "Customer" }, { type: "text", text: orderId }] }
        ]);
        await sendWhatsAppTemplate(phone, "request", [
          { type: "body", parameters: [{ type: "text", text: meta.customerName || "Customer" }] }
        ]);
        meta.status = "delivered";
        break;

      case "rto":
      case "return_initiated":
        await sendWhatsAppTemplate(phone, "return_initiated_cust", [
          { type: "body", parameters: [{ type: "text", text: orderId }] }
        ]);
        meta.status = "return_initiated";
        break;

      case "dispatch_reminder":
        await sendWhatsAppTemplate(phone, "order_dispatch_reminder", [
          { type: "body", parameters: [
            { type: "text", text: meta.customerName || "Customer" },
            { type: "text", text: orderId },
            { type: "text", text: meta.product || "Product" }
          ] }
        ]);
        meta.status = "dispatch_reminder";
        break;

      default:
        console.log("ℹ️ Unknown courier status:", p.status);
    }

    await orderRef.update(meta);
    console.log("💾 Order updated in DB:", orderId, meta.status);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Courier webhook error:", err);
    res.sendStatus(500);
  }
});
import cron from "node-cron";

// ---------------- Abandoned Checkout Webhook ----------------
app.post("/webhook/abandoned_checkout", express.json(), async (req, res) => {
  try {
    const checkout = req.body;
    console.log("🛒 Abandoned checkout:", JSON.stringify(checkout, null, 2));

    const phone = normalizePhone(checkout.phone);
    if (!phone) return res.sendStatus(200);

    const checkoutId = checkout.id;
    const orderRef = db.ref("abandoned_checkouts").child(checkoutId);

    await orderRef.set({
      phone,
      checkoutId,
      product: checkout.line_items?.[0]?.title || "Product",
      url: checkout.abandoned_checkout_url || DEFAULT_CHECKOUT_URL,
      createdAt: Date.now(),
      reminded: false
    });

    // Send WhatsApp abandoned cart template
    await sendWhatsAppTemplate(phone, "abandoned_checkout", [
      { type: "body", parameters: [
        { type: "text", text: checkout.customer?.first_name || "Customer" },
        { type: "text", text: checkout.line_items?.[0]?.title || "your product" }
      ] },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: checkout.abandoned_checkout_url || DEFAULT_CHECKOUT_URL }]
      }
    ]);

    console.log("✅ Abandoned checkout notification sent:", checkoutId);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Abandoned checkout webhook error:", err);
    res.sendStatus(500);
  }
});

// ---------------- Reminder Jobs (CRON) ----------------
// Every hour check abandoned checkouts older than 1h but not reminded
cron.schedule("0 * * * *", async () => {
  console.log("⏰ Running abandoned checkout reminders...");

  const snap = await db.ref("abandoned_checkouts").once("value");
  if (!snap.exists()) return;

  const checkouts = snap.val();
  const now = Date.now();

  for (const [checkoutId, c] of Object.entries(checkouts)) {
    if (!c.reminded && now - c.createdAt > 60 * 60 * 1000) {
      console.log("🔔 Sending reminder for checkout:", checkoutId);

      await sendWhatsAppTemplate(c.phone, "abandoned_checkout", [
        { type: "body", parameters: [
          { type: "text", text: "Dear Customer" },
          { type: "text", text: c.product }
        ] },
        {
          type: "button",
          sub_type: "url",
          index: "0",
          parameters: [{ type: "text", text: c.url || DEFAULT_CHECKOUT_URL }]
        }
      ]);

      await db.ref("abandoned_checkouts").child(checkoutId).update({ reminded: true });
    }
  }
});
// ---------------- WhatsApp Interactive Replies ----------------
app.post("/webhook/whatsapp_interactive", express.json(), async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;

    if (!messages) return res.sendStatus(200);

    for (const msg of messages) {
      if (msg.type !== "interactive") continue;

      const phone = msg.from;
      const payload = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;

      console.log("📲 Interactive reply:", payload, "from", phone);

      switch (payload) {
        // ---------------- Redelivery ----------------
        case PAYLOADS.REDELIVER_TOMORROW:
        case PAYLOADS.RETRY_DELIVERY:
        case PAYLOADS.CONFIRM_AVAILABLE_TODAY: {
          await sendWhatsAppTemplate(phone, TPL.REDELIVERY_SCHEDULED, [
            { type: "body", parameters: [{ type: "text", text: "Your redelivery has been scheduled ✅" }] }
          ]);

          await db.ref("redelivery").push({
            phone,
            payload,
            timestamp: Date.now()
          });
          break;
        }

        // ---------------- Return ----------------
        case PAYLOADS.RET_WRONG_ADDRESS:
        case PAYLOADS.RET_NOT_AVAILABLE:
        case PAYLOADS.RET_CHANGED_MIND:
        case PAYLOADS.RET_CONTACT_SUPPORT: {
          await sendWhatsAppTemplate(phone, TPL.RETURN_INITIATED_CUST, [
            { type: "body", parameters: [{ type: "text", text: "We have initiated your return process." }] }
          ]);

          await db.ref("returns").push({
            phone,
            reason: payload,
            timestamp: Date.now()
          });
          break;
        }

        // ---------------- Delivery Confirmation ----------------
        case PAYLOADS.DELIVERED_OK: {
          await sendWhatsAppTemplate(phone, TPL.ORDER_DELIVERED, [
            { type: "body", parameters: [{ type: "text", text: "Thanks for confirming delivery 🙏" }] }
          ]);

          await db.ref("delivered_confirmations").push({
            phone,
            timestamp: Date.now()
          });
          break;
        }

        default:
          console.log("⚠️ Unhandled interactive payload:", payload);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ WhatsApp interactive webhook error:", err);
    res.sendStatus(500);
  }
});
// ---------------- Feedback Request ----------------
async function sendFeedbackRequest(phone, orderId) {
  try {
    await sendWhatsAppTemplate(phone, TPL.FEEDBACK_REQUEST, [
      {
        type: "body",
        parameters: [{ type: "text", text: `We’d love to hear your feedback for order #${orderId}` }]
      },
      {
        type: "button",
        sub_type: "quick_reply",
        index: "0",
        parameters: [{ type: "payload", payload: "FEEDBACK_POSITIVE" }]
      },
      {
        type: "button",
        sub_type: "quick_reply",
        index: "1",
        parameters: [{ type: "payload", payload: "FEEDBACK_NEGATIVE" }]
      }
    ]);

    console.log("📩 Feedback request sent to", phone);
  } catch (err) {
    console.error("❌ Feedback request error:", err);
  }
}

// ---------------- Handle Feedback Reply ----------------
app.post("/webhook/whatsapp_feedback", express.json(), async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;

    if (!messages) return res.sendStatus(200);

    for (const msg of messages) {
      if (msg.type !== "interactive") continue;

      const phone = msg.from;
      const payload = msg.interactive?.button_reply?.id;

      if (payload === "FEEDBACK_POSITIVE" || payload === "FEEDBACK_NEGATIVE") {
        await db.ref("feedback").push({
          phone,
          feedback: payload,
          timestamp: Date.now()
        });

        await sendWhatsAppTemplate(phone, "thank_you_feedback", [
          { type: "body", parameters: [{ type: "text", text: "Thank you for your feedback 🙏" }] }
        ]);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Feedback webhook error:", err);
    res.sendStatus(500);
  }
});
// ---------------- META Webhook Verification ----------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN_META) {
    console.log("✅ Webhook verified!");
    res.status(200).send(challenge);
  } else {
    console.error("❌ Webhook verification failed.");
    res.sendStatus(403);
  }
});

// ---------------- Shopify Webhook Endpoint ----------------
// ---------------- Shopify Webhook Endpoint ----------------
// ---------------- Shopify Webhook Endpoint ----------------
app.post(
  "/webhook/shopify",
  express.json({ type: "application/json" }),
  async (req, res) => {
    try {
      const event = req.headers["x-shopify-topic"];
      const order = req.body;

      console.log("📦 Shopify Webhook:", event, "Order ID:", order.id);

      if (event === "orders/create") {
        // Extract needed details for WhatsApp template
        const customerName = order.customer?.first_name || "Customer";
        const orderId = order.id;
        const firstLineItem = order.line_items?.[0] || {};
        const productName = firstLineItem.title || "Product";
        const variant = firstLineItem.variant_title || "-";
        const shopName = "SILKEN ROOT"; // 🔧 Change this to your shop name
        const total = order.total_price;
        const currency = order.currency;

        // Customer phone (from Shopify order)
        const phone =
          order.phone ||
          order.customer?.phone ||
          order.shipping_address?.phone;

        if (phone) {
          await sendWhatsAppTemplate(phone, "order_confirmation", [
            customerName, // {{1}}
            orderId,      // {{2}}
            productName,  // {{3}}
            variant,      // {{4}}
            shopName,     // {{5}}
            total,        // {{6}}
            currency,     // {{7}}
          ]);
        } else {
          console.warn("⚠️ No phone number found for order:", orderId);
        }
      }

      res.sendStatus(200);
    } catch (err) {
      console.error("❌ Shopify webhook error:", err);
      res.sendStatus(500);
    }
  }
);


// ---------------- COD Delivery & Return Handling ----------------
async function handleDeliveryEvent(order, status) {
  try {
    const orderId = order.id;
    const phone = normalizePhone(order.phone || order.shipping_address?.phone);

    if (!phone) {
      console.error("❌ No phone number found for order:", orderId);
      return;
    }

    if (status === "out_for_delivery") {
      await sendWhatsAppTemplate(phone, TPL.ORDER_DISPATCH_REMINDER);
      await dbUpdate(`orders/${orderId}`, { status: "Out For Delivery" });
      console.log("🚚 Out for delivery:", orderId);
    }

    if (status === "delivered") {
      await sendWhatsAppTemplate(phone, TPL.ORDER_DELIVERED);
      await dbUpdate(`orders/${orderId}`, { status: "Delivered" });
      console.log("📦 Delivered:", orderId);
    }

    if (status === "return_initiated") {
      await sendWhatsAppTemplate(phone, TPL.RETURN_INITIATED_CUST);
      await dbUpdate(`orders/${orderId}`, { status: "Return Initiated" });
      console.log("🔄 Return initiated:", orderId);
    }
  } catch (err) {
    console.error("❌ handleDeliveryEvent error:", err);
  }
}
// ---------------- Shopify Fulfillment Webhook ----------------
// Helper: fetch order name
async function getOrderName(orderId) {
  const url = `https://${process.env.SHOPIFY_SHOP}/admin/api/2025-01/orders/${orderId}.json`;
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("❌ Shopify order fetch failed:", res.status, text);
    throw new Error(`Shopify order fetch failed: ${res.status}`);
  }

  const data = await res.json();
  return data.order?.name || null;
}

// 📦 Fulfillment Webhook
app.post("/webhook/shopify/fulfillment", async (req, res) => {
  try {
    const fulfillment = req.body;
    res.sendStatus(200); // ✅ Always ACK quickly

    const { id: fulfillmentId, order_id: orderId, status, shipment_status, tracking_url } = fulfillment;

    // 1️⃣ Fetch order name
    const orderName = await getOrderName(orderId);

    // 2️⃣ Save/update fulfillment info in Firebase
    await db.ref(`orders/${orderId}/fulfillments/${fulfillmentId}`).set({
      order_id: orderId,
      order_name: orderName,  // <--- this is the "#1001" friendly ID
      status,
      shipment_status: shipment_status || null,
      tracking_url,
      updated_at: new Date().toISOString()
    });

    console.log(`🔥 Saved fulfillment update for order ${orderName} (${orderId})`);

    // 3️⃣ Fetch customer phone (from DB or Shopify)
    const phone = await getCustomerPhone(orderId);

    // 4️⃣ WhatsApp logic
    if (status === "success" && !shipment_status) {
      await sendWhatsAppTemplate(phone, "your_order_is_shipped_2025", {
        body: [
          fulfillment.customer?.first_name || "Customer",
          orderName,       // 👈 Friendly ID instead of numeric
          tracking_url
        ]
      });
    }

    if (shipment_status) {
      const templateMap = {
        in_transit: "order_in_transit",
        out_for_delivery: "order_out_for_delivery",
        delivered: "order_delivered",
        failure: "order_failed_delivery"
      };
      if (templateMap[shipment_status]) {
        await sendWhatsAppTemplate(phone, templateMap[shipment_status], {
          body: [orderName]  // 👈 use friendly order name
        });
      }
    }
  } catch (err) {
    console.error("❌ Fulfillment webhook error:", err);
  }
});
// ---------------- Abandoned Checkout Recovery ----------------
app.post("/webhook/abandoned_checkout", express.json({ type: "application/json" }), async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      return res.sendStatus(401);
    }

    const checkout = req.body;
    const phone = normalizePhone(checkout?.phone || checkout?.shipping_address?.phone);

    if (!phone) {
      console.error("❌ No phone number in abandoned checkout:", checkout.id);
      return res.sendStatus(200);
    }

    console.log("🛒 Abandoned checkout detected:", checkout.id);

    await sendWhatsAppTemplate(phone, TPL.ABANDONED_CHECKOUT, [
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [
          { type: "text", text: DEFAULT_CHECKOUT_URL || checkout?.abandoned_checkout_url },
        ],
      },
    ]);

    await dbSet(`abandoned/${checkout.id}`, {
      phone,
      email: checkout.email,
      cart: checkout.line_items,
      createdAt: Date.now(),
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ abandoned_checkout webhook error:", err);
    res.sendStatus(500);
  }
});
// ---------------- Feedback Request ----------------
async function requestFeedback(order) {
  try {
    const phone = normalizePhone(order.phone || order.shipping_address?.phone);
    if (!phone) return;

    await sendWhatsAppTemplate(phone, TPL.FEEDBACK_REQUEST);
    await dbUpdate(`orders/${order.id}`, { feedbackRequested: true });

    console.log("⭐ Feedback request sent for Order:", order.id);
  } catch (err) {
    console.error("❌ requestFeedback error:", err);
  }
}
// ---------------- Shopify Order Handling ----------------
async function handleNewOrder(order) {
  try {
    const orderId = order.id;
    const customerPhone = normalizePhone(order.shipping_address?.phone);

    // Save order in Firebase
    await dbSet(`orders/${orderId}`, {
      orderId,
      createdAt: Date.now(),
      customer: {
        name: order.customer?.first_name || "Unknown",
        phone: customerPhone,
        address: order.shipping_address?.address1 || "",
      },
      status: "PENDING_CONFIRMATION",
    });

    console.log("✅ Order saved in Firebase:", orderId);

    // Send WhatsApp confirmation
    if (customerPhone) {
      await sendWhatsAppTemplate(customerPhone, TPL.ORDER_CONFIRMATION, []);
    }
  } catch (err) {
    console.error("❌ handleNewOrder error:", err);
  }
}
// ---------------- Shopify Webhooks ----------------
app.post("/webhook/shopify/orders", express.json(), async (req, res) => {
  try {
    const order = req.body;

    console.log("📦 Received Shopify Order:", order.id);

    await handleNewOrder(order);

    res.status(200).send("✅ Order received");
  } catch (err) {
    console.error("❌ Shopify webhook error:", err);
    res.status(500).send("Error processing order");
  }
});
// ---------------- Meta / WhatsApp Webhook ----------------
app.get("/webhook/meta", (req, res) => {
  const verifyToken = VERIFY_TOKEN_META;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === verifyToken) {
    console.log("✅ Meta webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook/meta", async (req, res) => {
  try {
    const body = req.body;

    if (body.object) {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const msg = change.value?.messages?.[0];
          if (msg) {
            console.log("💬 Incoming WA message:", msg);

            // Store raw message in Firebase
            const msgId = msg.id || Date.now();
            await dbSet(`/whatsapp/incoming/${msgId}`, msg);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Meta webhook error:", err);
    res.sendStatus(500);
  }
});
// ---------------- Utility Routes ----------------

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// Firebase test route
app.get("/test-db", async (req, res) => {
  try {
    const testData = {
      timestamp: Date.now(),
      message: "Hello from Render 🚀",
    };

    await db.ref("test").set(testData);

    const snapshot = await db.ref("test").once("value");
    const savedData = snapshot.val();

    console.log("✅ Firebase saved data:", savedData);

    res.json({ success: true, savedData, });
  } catch (err) {
    console.error("❌ Firebase test failed:", err);
    res.status(500).json({ error: err.message });
  }
});




// Root
app.get("/", (req, res) => {
  res.send("✅ Shopify x WhatsApp Automation Service Running");
});
// ---------------- Start Server ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`⚡ Server running on port ${PORT}`);
});


















































































