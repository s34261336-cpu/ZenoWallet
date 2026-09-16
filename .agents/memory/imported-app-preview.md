---
name: Imported app preview
description: Preview routing behavior for imported root applications that use a standard Replit workflow.
---

Imported root applications can start successfully while the preview domain still returns `Backend Not Configured` if `.replit` has no explicit `[[ports]]` mapping for the workflow's listening port.

**Why:** Imported repositories may retain a valid workflow and open port without registering that port with the shared preview proxy.

**How to apply:** For a root workflow serving on port 8080, keep a validated `.replit` block with `[[ports]]`, `localPort = 8080`, and `externalPort = 80`; validate `.replit` through the platform replacement flow rather than editing it directly.