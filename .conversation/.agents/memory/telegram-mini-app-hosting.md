---
name: Telegram mini-app hosting
description: Stable hosting requirement for the Telegram Web App URL.
---

The Telegram mini-app URL must be an explicitly configured, working external HTTPS address. Replit development or published domains must not be used as an automatic fallback.

**Why:** Imported accounts have different Replit domains, and a fallback silently sends Telegram users to the wrong account or to an unavailable preview. An external URL that returns 404 is also not a valid fix.

**How to apply:** Keep the button disabled until `WEBAPP_URL` points to a live host serving `/webapp/` and routing the mini-app's `/api/*` requests to the bot backend.