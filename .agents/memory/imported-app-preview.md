---
name: Imported app preview
description: Preview routing behavior for imported root applications that use a standard Replit workflow.
---

Imported root applications can start successfully while the preview domain still returns `Backend Not Configured` if `.replit` has no explicit `[[ports]]` mapping for the workflow's listening port.

**Why:** Imported repositories may retain a valid workflow and open port without registering that port with the shared preview proxy.

**How to apply:** For a root workflow, keep a validated `.replit` block with `[[ports]]`, matching `internalPort`, and `externalPort = 80`; validate `.replit` through the platform replacement flow rather than editing it directly. Verify both the direct workflow port and the shared preview, because artifact-owned services can leave the shared root route returning 404 even while the app is running.

If a root mini-app and a registered API artifact both claim `/api`, shared-proxy requests go to the artifact instead of the root app. Keep the mini-app API under its own mounted path (for example `/webapp/api`) and support that path server-side.

**Why:** A healthy root server can still appear broken in preview when the proxy resolves `/api/*` to another service first; the browser then receives a misleading 404 or `Backend Not Configured`.

**How to apply:** Check the actual proxy response for static files and API calls, not only the direct workflow port, whenever an imported app has sibling artifacts mounted under a path prefix.