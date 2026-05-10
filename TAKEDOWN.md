# Takedown Policy

If you are the author of a source repository listed in ccpluginizer's catalog and want it removed, you have two options:

1. **Open an issue** at `github.com/lifebugz/ccpluginizer/issues` titled "Takedown: <owner>/<repo>" and identify yourself.
2. **Open a PR** that moves the corresponding `entries/<name>.json` file to `tombstones/<name>.json` with a brief reason.

We process takedown requests within 7 days. The tombstoned entry is excluded from `marketplace.json` on the next build, so users lose access on their next `/plugin marketplace update`.

You don't need to provide a reason. For authorship verification we accept any reasonable proof: a comment from your verified GitHub account on the source repository, an email from a verified domain, anything similar.

ccpluginizer doesn't redistribute your code. The catalog contains a JSON pointer and path mappings, nothing else. Once an entry is removed, Claude Code stops installing the plugin through ccpluginizer for your repo. Users who already have it keep what's on their machine until they uninstall, but they get no further updates from us.
