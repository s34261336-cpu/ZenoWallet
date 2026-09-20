---
name: Persisted case settings
description: Shared gameplay configuration and per-user case usage state for the two bot runtimes.
---

Mutable case configuration belongs in the shared `bot_state` storage, not process memory: keep odds and the hourly limit in a dedicated settings row, and keep each user's recent case timestamps in that user's state. Both Python and Node runtimes must validate the configuration and fall back to safe defaults when it is malformed.

**Why:** BotHost and the API workflow can run different runtimes across restarts, so in-memory settings would make admin changes inconsistent and reset usage limits.

**How to apply:** Any future case-related change should update both runtimes against the same Supabase state shape and preserve the 100% odds-sum validation.