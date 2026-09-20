---
name: Crash game settlement
description: Security boundary for the Rocket crash game and wallet mutations.
---

Crash rounds must deduct bets and settle payouts inside Supabase RPC functions that lock the wallet and game row. The client may animate the multiplier and request cashout, but it must never determine the payout or final result.

**Why:** The mini-app runs in an untrusted Telegram Web App browser, and separate REST updates could lose or duplicate coins under concurrent requests.

**How to apply:** Any future crash-game change must keep the server-side multiplier formula and the browser animation synchronized, while treating all client-supplied bet and timing values as untrusted.