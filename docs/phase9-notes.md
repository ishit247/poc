# Phase 9: aggregator adapters (scaffolding only)

Status: **no partner access yet**. Everything below is built to our own placeholder contract and is
unverified against Zomato or Swiggy. Q1 answer: outlets are listed on the platforms, onboarding is per outlet.

## What exists
- `outlet_integration` (db/migrations/0006_integrations.sql): per outlet and platform, a store id, a webhook secret,
  the user the sale is booked to and the counter that receives it. The store id is globally unique per channel, so it
  alone resolves the tenant (through the `webhook_lookup` policy, same pattern as the expiry and outbox jobs).
- `item_channel_map`: the platform's item id to our item, per outlet.
- `inbound_event`: every authenticated webhook with its raw payload and result. Append-only.
- `online_order.unmapped_lines` (in 0005): platform lines with no mapping. Shown in the order list as `unmappedLines`.
- `POST /webhooks/zomato`, `POST /webhooks/swiggy` (apps/api/src/routes/webhooks.ts): lookup, verify signature, then write.
  Unsigned calls leave no row. Duplicates return 200. An order with no mappable line is rejected (422) and recorded.
- `apps/api/src/providers/index.ts`: the `OrderProvider` boundary.
- `senders.zomato` / `senders.swiggy` throw "partner API not configured", so outbound messages retry and end up
  `failed` and visible instead of pretending the platform was told.

## Placeholders to replace when documentation arrives
- Payload shape (`store_id`, `order_id`, `lines[].item_id|qty|unit_price_paise`), money in paise.
- Signature: hex HMAC-SHA256 of `<unix seconds>.<raw body>` in `x-signature` with `x-timestamp`, 5 minute window.
- Outbound calls (accept, reject, ready, handed over, cancel) and item availability / outlet open pushes.
- The webhook secret is stored in plain text (HMAC needs it); encrypt at rest in phase 11.

## Not done
- No manager UI or API to create integrations or item mappings (rows come from the seed). Needed before a real outlet.
- The counter UI does not yet show `unmappedLines`.
- No monitoring alert on `last_event_at` going quiet (phase 11).
- Menu and stock push to platforms.
