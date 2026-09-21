---
name: Imported project handoff
description: How to recover a repository after a conversation-to-project transition.
---

After a conversation becomes a project, the imported repository may be preserved under `.local/conversation-workspace/files` while `.conversation` is a busy workspace mount. Copy the preserved repository contents into the project root and restore its Git metadata from that same snapshot instead of trying to move or delete the mount.

**Why:** The project scaffold can otherwise hide the imported app, and the mounted `.conversation` path can reject filesystem moves with a device-busy error.

**How to apply:** Prefer the preserved snapshot for the source of truth, keep the original remote and branch history, then verify the root workflow and `git status`.