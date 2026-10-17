---
title: "Configure memory profiles"
description: Choose a memory scope and map it to Pi Hindsight configuration.
---

**Recommended default: Coding** — one shared coding bank, repos separated by tags.

Add **Life** only if you want a separate personal bank. Use **Isolated** only when a repo must never share the coding bank.

## Choose a profile

| Profile                  | Recall reads               | Automatic retain | Best for                         |
| ------------------------ | -------------------------- | ---------------- | -------------------------------- |
| **Coding** (recommended) | Coding bank                | Coding bank      | Normal day-to-day coding         |
| **Coding + Life**        | Coding + Life banks        | Coding bank only | Coding plus personal prefs/goals |
| **Isolated project**     | That repo’s hard-wall bank | That bank        | Client / sensitive repos         |
| **Life only**            | Life bank                  | Off              | Non-repo personal memory         |
| **Recall only**          | Configured banks           | Off              | Cautious / read-mostly use       |

Automatic retain never writes the Life / User bank. Use `hindsight_retain_user` (or a command) for explicit life writes.

## Configure through `/hindsight`

1. Run `/hindsight`.
2. Open guided setup if prompted, or press `g`.
3. Confirm the Hindsight server.
4. Choose **Coding** unless you know you need another profile.
5. Confirm bank ids (shared coding bank is stored in user/global config and prefilled next time).
6. Optional: starter mental models and historical import.

## Configure by file

Minimal project config:

```json
{
  "hindsight": {
    "baseUrl": "http://localhost:8888"
  }
}
```

Shared coding bank (prefer user/global config so every repo inherits it):

```json
{
  "banks": [
    {
      "id": "coding",
      "alias": "project",
      "derive": "manual",
      "bankId": "pi-coding"
    }
  ],
  "setupComplete": true
}
```

## Verify

In `/hindsight` confirm:

- profile is **Coding** (or the intentional alternative)
- coding bank id is set for domain-tagged mode
- Life bank appears only when you enabled it
- automatic retain matches the profile
- retain queue path is visible

## Give an omp subagent its own memory banks

Use this setup when one omp workflow launches named agents such as `researcher`, `engineer`, and
`reviewer`. Each name can use separate banks for recall, decision routing, explicit tools, and any
automatic retain that the bank configuration enables.

The main session continues to read `hindsight.json`. Omp subagents load a matching profile from
`hindsight-subagent.json`. Pi sessions do not use this file.

### Keep shared defaults in `hindsight.json`

Set up the Hindsight server and common defaults in the usual files:

| Scope      | Omp config file                                                 |
| ---------- | --------------------------------------------------------------- |
| User-wide  | `~/.omp/agent/hindsight.json` or `~/.omp/agent/hindsight.jsonc` |
| Repository | `<repo>/.omp/hindsight.json` or `<repo>/.omp/hindsight.jsonc`   |

For example, define the shared server and a read-only research bank in the project file:

```jsonc
{
  "setupComplete": true,
  "hindsight": { "baseUrl": "http://localhost:8888" },
  "banks": [
    { "id": "coding", "alias": "project", "bankId": "pi-project-main" },
    { "id": "research", "bankId": "pi-research", "access": "read" },
    { "id": "life", "alias": "user", "bankId": "pi-user", "access": "read" },
  ],
}
```

### Add profiles in `hindsight-subagent.json`

Put the file beside `hindsight.json` for repository-specific profiles. Put it in
`~/.omp/agent/` for profiles used across repositories. Use the omp agent definition name as the
profile key. Define named profiles for distinct workflow roles:

```jsonc
{
  "profiles": {
    "researcher": {
      "banks": [
        { "id": "coding", "access": "read" },
        { "id": "research", "access": "read-write" },
        { "id": "life", "enabled": false },
      ],
      "banksFallback": ["research"],
    },
    "engineer": {
      "banks": [
        { "id": "coding", "access": "read-write" },
        { "id": "research", "access": "read" },
        { "id": "life", "enabled": false },
      ],
      "banksFallback": ["coding"],
    },
    "reviewer": {
      "banks": [
        { "id": "coding", "access": "read" },
        { "id": "research", "access": "read" },
        { "id": "life", "enabled": false },
      ],
      "retain": { "enabled": false },
    },
  },
}
```

This example gives each profile its own bank routing. It does not configure a workflow or create
Hindsight banks. Create each `bankId` on the Hindsight server before you use the profile.

### Apply profile overrides in order

The resolver merges these four layers from lowest to highest priority:

1. User `hindsight.json`.
2. User `hindsight-subagent.json` at `profiles.<name>`.
3. Repository `.omp/hindsight.json`.
4. Repository `.omp/hindsight-subagent.json` at `profiles.<name>`.

A profile only overrides the values it states. Bank entries merge by `id` or `alias`, so an entry
can change `access` or `bankId` without restating its description, mission, or recall settings.
Unmatched profile names inherit the normal `hindsight.json` config.

Omp inherits extension hooks into task agents. Each task agent then resolves its own matching
profile. A workflow that sends two logical roles under the same agent name gives both roles the same
profile. Add separate named agent definitions when the roles need different banks.

`hindsight_config_get` reports the effective resolved values. Run a real workflow and inspect
`hindsight:retrieval` events to confirm the bank IDs used by each named profile.

Profile routing config controls automatic recall and decision candidates. The `access`, `enabled`,
and retain fields determine which banks those paths can use. Explicit memory tools accept a bank ID
and currently do not enforce a profile-specific allowlist; do not use profile config as a hard
security boundary for explicit `hindsight_*` calls.

Details: [Memory profiles](/pi-hindsight/start/memory-profiles/), [Memory banks](/pi-hindsight/concepts/memory-banks/), [Configuration](/pi-hindsight/reference/configuration/).
