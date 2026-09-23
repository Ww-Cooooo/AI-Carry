# AI Carry 2.1.5 → 2.1.6

2.1.6 delivers the current desktop client and adds an independent-copy option for same-computer Agent switching.

## What changes

- The migration page defaults to an independent copy. The original assistant folder is left unchanged and the two copies do not synchronize automatically.
- The copy keeps the existing `instance_id`, records a separate local `copy_id`, and writes `HOST-SWITCH-START.md` so the new host can review its own bindings before use.
- Git metadata, dependency folders, known runtime caches, and obvious credential or login files are not copied. Skipped files are reported instead of being silently treated as migrated.
- A shared-folder route remains available only when the user explicitly chooses it. It is for turn-based use: there is no concurrent-write protection, so the Agent re-reads affected source files before writing.

## What stays the same

User-owned memory, capabilities, SOPs, experiences, Skills, workspaces, private files, local bindings, and unknown fields remain instance-owned. The original folder is not rewritten, and this upgrade does not re-instantiate an assistant.

The public direct memory-engine upgrade route remains withdrawn. Ordinary file-first memory, learning, SOP, capability, and evolution use is unchanged. The 2.1.6 desktop package provides one default desktop entry and an installation-folder web fallback.

## Safe continuation

The normal upgrade still uses a fixed official Release preview and a transactional file switch in the same assistant directory. It does not create a second assistant directory. If the user later chooses “换一个 Agent → 独立副本”, that separate action asks for a new destination, reports what it copied or skipped, and refuses to overwrite an existing directory.
