# Security Policy

## API Keys

**Never place API keys in source code.**

API keys must be supplied through environment variables (e.g. `OJIN_API_KEY`) and read at
runtime on the server side. Hardcoding a key in source or committing it to version control
exposes it to anyone with repository access and to all future git history — rotation alone
cannot undo that exposure.

```
# .env (never commit this file)
OJIN_API_KEY=sk-...
```

Because this SDK is a **Node/server-only** package, the API key is handled exclusively on
the backend. It must not be bundled into a browser-side application or exposed to end users.

## Session Tokens (v1.5+)

Once short-lived session tokens are available (v1.5 and later), the following rules apply:

- **Do not store session tokens in `localStorage` or `sessionStorage`.** Both are accessible
  to any JavaScript running on the same origin; an XSS vulnerability would allow exfiltration.
- **Preferred alternatives:**
  - Keep the token in memory (a module-scoped variable or framework state) and discard it
    when the session ends.
  - Use a short-lived, `HttpOnly` cookie set by your own server if you need the token to
    survive a page refresh.

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please **do not open a public
GitHub issue**.

Instead, email **security@journee.live** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce (or a minimal proof-of-concept)
- Any suggested remediation if you have one

**What to expect:**

| Timeline | Commitment |
|---|---|
| Within **3 business days** | Acknowledgement of your report |
| Within **14 days** | Initial triage and severity assessment |
| Within **90 days** | Coordinated disclosure — a fix is released before details are made public |

We follow a coordinated disclosure model. We will keep you informed of progress and credit
your finding in the release notes (unless you prefer to remain anonymous).
