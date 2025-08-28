# Shopify ↔ WhatsApp Automation (Render ready)

## Env Vars (set these on Render)
- `WHATSAPP_NUMBER_ID` (Phone Number ID from WhatsApp > API Setup)
- `WHATSAPP_TOKEN` (Permanent System-User token with whatsapp_business_messaging + management)
- `SHOPIFY_SHOP` e.g. `mystore.myshopify.com`
- `SHOPIFY_ACCESS_TOKEN` Shopify Admin API token (orders + fulfillments write)
- `VERIFY_TOKEN_META` e.g. `shopify123` (use same while adding Meta webhook)
- `TEMPLATE_ORDER_PLACED_NAME` default: `order_placed` (must be approved & match placeholders)
- `LANG_CODE` default: `en` (or `en_US` if template created as en_US)
- `DEFAULT_COUNTRY_CODE` default: `92` (Pakistan)
- `SHOPIFY_WEBHOOK_SECRET` optional (if you set secret in Shopify webhook)
- `TEST_TO` optional (e.g. `923001234567`) for GET `/demo/send`

## Endpoints
- `GET /` -> "Automation service running"
- `GET /health` -> `{ ok: true }`
- `GET /demo/send?to=923XXXXXXXXX` -> sends `TEMPLATE_ORDER_PLACED_NAME` with dummy params (good for testing)
- `GET /webhook/meta` -> Meta verification (use `VERIFY_TOKEN_META`)
- `POST /webhook/meta` -> Receives WhatsApp user replies / button clicks
- `POST /webhook/shopify` -> Shopify orders/create webhook (sends template)
- `POST /webhook/courier` -> Courier status webhook (stub)

## Meta (WhatsApp) Setup
1. Generate permanent token via Business Settings > System Users (give app + WhatsApp account full access).
2. Copy **Phone Number ID** (not WABA ID).
3. Add webhook in Meta App: **Callback URL** = `https://<your-render-domain>/webhook/meta`, Verify Token = `VERIFY_TOKEN_META`.

## Shopify Setup
1. Create Admin API access token with Orders write scope.
2. Add webhook `orders/create` to: `https://<your-render-domain>/webhook/shopify`
   - Content type: JSON
   - (Optional) Webhook secret: set and also put `SHOPIFY_WEBHOOK_SECRET` in env
3. Ensure checkout collects **phone number** (shipping or billing).

## Test
- Hit: `https://<your-render-domain>/demo/send?to=923XXXXXXXXX`
- Place a test order; watch logs for "Shopify webhook received" and "WhatsApp Template Response".
