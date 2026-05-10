# Security

ccpluginizer is a plugin catalog for Claude Code, which makes it a software distribution channel. Vulnerabilities in the CLI, the build pipeline, or entries pointing at malicious source repos can affect anyone installing a plugin through us. Reports are taken seriously.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/lifebugz/ccpluginizer/security/advisories/new). Reports stay confidential until a fix ships, and GitHub coordinates disclosure.

I aim to acknowledge reports within 5 business days. High-severity issues affecting users at install time get a same-week fix when possible.

## In scope

- Bugs in `@ccpluginizer/ccpluginizer` (command injection, path traversal, prototype pollution, etc.)
- Flaws in the marketplace schema parsing or in `scripts/build-marketplace.ts`
- Entries in `entries/` that point at a known-malicious source repo (we will tombstone them)
- CI workflows that could be abused (e.g., to publish or push from an untrusted PR)

## Out of scope

- Bugs in the source repos listed in our catalog. Report those to the source maintainer; we only carry a metadata pointer.
- Bugs in Claude Code itself. Those go to [anthropics/claude-code](https://github.com/anthropics/claude-code/issues).
- Takedown requests for legitimate-but-unwanted entries. Those are not a security issue — see [TAKEDOWN.md](./TAKEDOWN.md).
