---
name: ZenoToken balance source
description: The displayed and spendable ZenoToken balance for roulette must come from the users JSON state.
---

Use `bot_state.state_key = 'users'` and each user's `zenotoken` value as the source of truth for ZenoToken. Keep `wallet.zeno_balance` only as a synchronized legacy mirror when database functions update it. Standard roulette's paid extra spins spend ZT; premium roulette charges its fee and stake only from the main wallet balance and must not spend ZT.

**Why:** Withdrawals and the web app already read and write ZenoToken in `bot_state.users`; checking only `wallet.zeno_balance` made premium roulette reject users who visibly had enough ZT.

**How to apply:** Any new ZT spend or reward must lock and update the `bot_state.users` row atomically with the related wallet/game transaction, then return the resulting balance. Do not add that update to premium roulette; its fixed premium fee and selected stake are deducted from `wallet.earn_balance`.