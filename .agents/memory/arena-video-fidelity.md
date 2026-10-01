---
name: Arena video fidelity
description: Visual reference and server-authority constraints for the ZenoWallet Arena.
---

Use the user's mobile gameplay videos as the visual source of truth for Arena changes instead of extending the old timer-pool dashboard. The reference uses a compact round/timer header, stake chips, a three-zone С/М/И field, currency choices, and stake/all-in controls.

**Why:** The previous dashboard was materially different from the requested game, and the user explicitly corrected that mismatch.

**How to apply:** Keep wager deduction and payout on the existing server-side path. The current contract exposes a weighted participant winner in ZT but no C/М/И outcome field; never derive a winning zone from an entry ID. Show ZT as active until ruble or gift betting is supported, and do not imply a disabled mode can be used.

When the current user has entered a round, show their Telegram profile photo as a token on the first purple lane, with initials as a load-failure fallback. Keep the participant list photo visible too; this is presentation only and must not alter weighted settlement.

**Why:** The supplied gameplay video shows the user's profile image on the field, and the user specifically reported that it was missing after placing a bet.

**How to apply:** Use the same Telegram photo source as the main menu, show a visible fallback if the image cannot load, and keep all winner selection and wallet changes server-authoritative.