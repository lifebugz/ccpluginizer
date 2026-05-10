# Takedown Policy

If you are the author of a source repository listed in ccpluginizer's catalog and want it removed, you have two options:

1. **Open an issue** at `github.com/lifebugz/ccpluginizer/issues` titled "Takedown: <owner>/<repo>" and identify yourself.
2. **Open a PR** that moves the corresponding `entries/<name>.json` file to `tombstones/<name>.json` with a brief reason.

We will action takedown requests within 7 days. The tombstoned entry will be excluded from `marketplace.json` on the next build, so users will lose access on their next `/plugin marketplace update`.

You do not need to provide a reason. Authorship verification: we accept any reasonable proof — a comment from your verified GitHub account on the source repository, an email from a verified domain, etc.

ccpluginizer does not redistribute your source code. The catalog contains only a JSON pointer plus path mappings. Removing the entry causes Claude Code to no longer install plugins through ccpluginizer for your repo; users with the plugin already installed retain it until they uninstall, but receive no further updates from this catalog.
