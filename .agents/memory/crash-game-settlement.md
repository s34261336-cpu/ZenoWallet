---
name: Crash game settlement
description: Security boundary for the Rocket crash game and wallet mutations.
---

Crash rounds must deduct bets and settle payouts inside Supabase RPC functions that lock the wallet and game row. The client may animate the multiplier and request cashout, but it must never determine the payout or final result.

**Why:** The mini-app runs in an untrusted Telegram Web App browser, and separate REST updates could lose or duplicate coins under concurrent requests.

**How to apply:** Any future crash-game change must keep the server-side multiplier formula and the browser animation synchronized, while treating all client-supplied bet and timing values as untrusted.

When the Telegram mini-app loses animation frames or becomes hidden during an active round, protect the round with one server-authoritative cashout request instead of letting the browser visually catch up several seconds at once.

**Why:** A suspended WebView cannot show a cashout control while the server round continues, so a client-only animation fix cannot protect the user's action window.

**How to apply:** Keep lag/visibility protection idempotent and let the existing Supabase cashout RPC decide whether the round was still payable; never manufacture a payout in the browser.

Core wallet state should degrade gracefully when the optional crash-game schema is not installed: return an unavailable game state instead of failing the whole mini-app.

**Why:** The wallet predates the game, so a partial Supabase rollout must not hide balances and existing earning flows.

**How to apply:** Catch only known games-table/RPC-schema errors around crash reads, keep other Supabase failures fatal, and show the migration requirement inside the game view.