---
name: Arena video fidelity
description: Visual reference and server-authority constraints for the ZenoWallet Arena.
---

Use the user's mobile gameplay videos as the visual source of truth for Arena changes instead of extending the old timer-pool dashboard. The reference uses a compact round/timer header, stake chips, a three-zone С/М/И field, currency choices, and stake/all-in controls.

**Why:** The previous dashboard was materially different from the requested game, and the user explicitly corrected that mismatch.

**How to apply:** Keep wager deduction and payout on the existing server-side path. The current contract exposes a weighted participant winner in ZT but no C/М/И outcome field; never derive a winning zone from an entry ID. Show ZT as active until ruble or gift betting is supported, and do not imply a disabled mode can be used.