# MVP Definition & Non-Goals

## MVP Goals
- One-click WordPress install that injects the scheduling widget and JSON-LD discovery hints.
- OpenAPI endpoints for listing services, querying availability, creating, canceling, and rescheduling appointments.
- Google and Microsoft calendar writes via OAuth with ICS read-only fallback.
- Agent-friendly mode: JSON-LD discovery and stable DOM selectors for GUI fallback.
- Basic security: HMAC-signed agent requests and per-IP rate limiting.

## Non-Goals
- Full-featured CRM or customer database.
- Payment processing beyond storing Stripe secrets for future use.
- Rich analytics or dashboarding.
- Offline booking flows or phone/SMS integrations.
- Multi-location or multi-tenant management beyond a single business account.
