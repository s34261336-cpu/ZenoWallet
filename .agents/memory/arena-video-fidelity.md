---
name: Arena video fidelity
description: Visual reference and server-authority constraints for the ZenoWallet Arena.
---

Use the user's mobile gameplay videos as the visual source of truth for Arena changes instead of extending the old timer-pool dashboard. The reference uses a compact round/timer header, stake chips, a colored participant field, a close winner zoom, and stake/all-in controls.

**Why:** The previous dashboard was materially different from the requested game, and the user explicitly corrected that mismatch.

**How to apply:** Keep wager deduction and payout server-authoritative. New rounds spend and pay `wallet.earn_balance`; the round records its currency so any open legacy ZT round can settle in ZT without mixing currencies. Place the ball on the participant whose server-provided `isWinner` is true, then zoom to that field. Never derive a winner from an entry ID or let the animation choose a separate result.

When displaying a finished legacy round beside new-bet controls, keep its pool, participants, and winner labeled in ZT, but render the bank and quick-bet presets in the current betting currency. Mark the old result as historical.

**Why:** Showing a finished ZT result beside coin betting controls made it appear that new Arena bets still used ZT.

**How to apply:** Derive result labels from the round's recorded currency and new-bet controls from the Arena's current `balanceCurrency`. Do not reuse legacy participant stakes as coin quick-bet presets.

When the current user has entered a round, show their Telegram profile photo on their participant field, with initials as a load-failure fallback. Keep the participant list photo visible too; this is presentation only and must not alter weighted settlement.

**Why:** The supplied gameplay video shows the user's profile image on the field, and the user specifically reported that it was missing after placing a bet.

**How to apply:** Use the same Telegram photo source as the main menu, show a visible fallback if the image cannot load, and keep all winner selection and wallet changes server-authoritative.