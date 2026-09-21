# AI Carry 2.1.4 → 2.1.5

2.1.5 closes the default installation gap for the desktop client.

## What changes

- A fresh install reads `desktop/client-release.json`, obtains the already verified client bundle for the current platform, and creates one desktop **AI Carry（客户端）** entry automatically.
- The web dashboard remains in the installation folder as `dashboard.html`; the client includes a **网页版** action that opens that same dashboard when the user needs a fallback.
- An existing older client is kept beside the new one. The installer does not overwrite a non-empty old directory or create a second web shortcut.
- A client or shortcut failure is reported locally and does not undo a completed web installation or instance upgrade.

## What stays the same

User-owned memory, capabilities, SOPs, experiences, Skills, workspaces, private files, local bindings, and unknown fields remain instance-owned. This upgrade does not re-instantiate an instance or move its data.

The public direct memory-engine upgrade route remains withdrawn as described in 2.1.4. Ordinary file-first memory, learning, SOP, capability, and evolution use is unchanged.

## Safe continuation

The normal upgrade still uses the fixed official Release preview and the same transactional file switch. After the switch, the Agent reports file installation and session continuation separately, then performs one relevant non-destructive behavior. A second run against the same source is idempotent.
