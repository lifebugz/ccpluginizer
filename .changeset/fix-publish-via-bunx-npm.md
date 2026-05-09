---
"@ccpluginizer/ccpluginizer": patch
---

Use `bunx npm@latest publish` instead of upgrading the system npm. The previous workflow ran `npm install -g npm@latest` to get the npm 11.5.1+ required for OIDC trusted publishing, but that triggered a known npm self-upgrade race condition (`Cannot find module 'promise-retry'`) that failed CI. `bunx npm@latest` fetches a fresh npm CLI on demand without modifying the runner's global Node install.
