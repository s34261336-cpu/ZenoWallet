---
name: Single Telegram poller
description: Runtime rule preventing Telegram update conflicts in the ZenoWallet project.
---

Only the `ZenoWallet bot` workflow may poll Telegram updates. The legacy API artifact can serve its HTTP API, but must not start a second Telegram polling loop.

**Why:** Telegram allows only one active `getUpdates` consumer per bot token; a second poller causes conflicts and makes users see inconsistent bot versions.

**How to apply:** Keep the legacy artifact's Telegram start disabled by default, and investigate any `Conflict: terminated by other getUpdates request` log before changing bot logic.