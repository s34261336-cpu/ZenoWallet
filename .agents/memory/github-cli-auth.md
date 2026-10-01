---
name: GitHub shell authentication
description: Replit GitHub connector authorization and shell Git push credentials are separate.
---

Replit's GitHub connector authenticates API calls through its SDK; adding that connection does not provide credentials to the shell's Git CLI. Public fetches can work while pushes still fail for missing credentials.

**Why:** A GitHub connector was available in the project, but a shell `git push --dry-run` still failed with a missing-password error.

**How to apply:** Configure the repository remote and branch normally, then authorize shell Git through Replit's Tools → Git flow before expecting `git push` to work. Never copy a token into chat.