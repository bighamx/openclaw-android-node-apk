---
summary: "Matrix-js support status, setup, and configuration examples"
read_when:
  - Setting up Matrix-js in OpenClaw
  - Configuring Matrix E2EE and verification
title: "Matrix-js"
---

# Matrix-js (plugin)

Matrix-js is the current Matrix channel plugin for OpenClaw.
It uses the official `matrix-js-sdk` and supports DMs, rooms, threads, media, reactions, polls, location, and E2EE.

For new setups, use Matrix-js.
If you need legacy compatibility with `@vector-im/matrix-bot-sdk`, use [Matrix (legacy)](/channels/matrix).

## Plugin required

Matrix-js is a plugin and is not bundled with core OpenClaw.

Install from npm:

```bash
openclaw plugins install @openclaw/matrix-js
```

Install from a local checkout:

```bash
openclaw plugins install ./extensions/matrix-js
```

See [Plugins](/tools/plugin) for plugin behavior and install rules.

## Setup

1. Install the plugin.
2. Create a Matrix account on your homeserver.
3. Configure `channels["matrix-js"]` with either:
   - `homeserver` + `accessToken`, or
   - `homeserver` + `userId` + `password`.
4. Restart the gateway.
5. Start a DM with the bot or invite it to a room.

Minimal token-based setup:

```json5
{
  channels: {
    "matrix-js": {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_xxx",
      dm: { policy: "pairing" },
    },
  },
}
```

Password-based setup (token is cached after login):

```json5
{
  channels: {
    "matrix-js": {
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      password: "replace-me",
      deviceName: "OpenClaw Gateway",
    },
  },
}
```

Environment variable equivalents (used when the config key is not set):

- `MATRIX_HOMESERVER`
- `MATRIX_ACCESS_TOKEN`
- `MATRIX_USER_ID`
- `MATRIX_PASSWORD`
- `MATRIX_DEVICE_ID`
- `MATRIX_DEVICE_NAME`
- `MATRIX_REGISTER`

## Configuration example

This is a practical baseline config with DM pairing, room allowlist, and E2EE enabled:

```json5
{
  channels: {
    "matrix-js": {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_xxx",
      encryption: true,

      dm: {
        policy: "pairing",
      },

      groupPolicy: "allowlist",
      groupAllowFrom: ["@admin:example.org"],
      groups: {
        "!roomid:example.org": {
          requireMention: true,
        },
      },

      autoJoin: "allowlist",
      autoJoinAllowlist: ["!roomid:example.org"],
      threadReplies: "inbound",
      replyToMode: "off",
    },
  },
}
```

## E2EE setup

Enable encryption:

```json5
{
  channels: {
    "matrix-js": {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_xxx",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

Check verification status:

```bash
openclaw matrix-js verify status
```

Verbose status (full diagnostics):

```bash
openclaw matrix-js verify status --verbose
```

Bootstrap cross-signing and verification state:

```bash
openclaw matrix-js verify bootstrap
```

Verbose bootstrap diagnostics:

```bash
openclaw matrix-js verify bootstrap --verbose
```

Verify this device with a recovery key:

```bash
openclaw matrix-js verify device "<your-recovery-key>"
```

Verbose device verification details:

```bash
openclaw matrix-js verify device "<your-recovery-key>" --verbose
```

Check room-key backup health:

```bash
openclaw matrix-js verify backup status
```

Verbose backup health diagnostics:

```bash
openclaw matrix-js verify backup status --verbose
```

Restore room keys from server backup:

```bash
openclaw matrix-js verify backup restore
```

Verbose restore diagnostics:

```bash
openclaw matrix-js verify backup restore --verbose
```

All `verify` commands are concise by default (including quiet internal SDK logging) and show detailed diagnostics only with `--verbose`.
Use `--json` for full machine-readable output when scripting.

## Automatic verification routing

Matrix-js automatically routes verification lifecycle updates to the agent as normal inbound messages.
That includes:

- verification request notices
- verification start and completion notices
- SAS details (emoji and decimal) when available

This means an agent can guide users through verification directly in chat without ad hoc harness scripts.

## DM and room policy example

```json5
{
  channels: {
    "matrix-js": {
      dm: {
        policy: "allowlist",
        allowFrom: ["@admin:example.org"],
      },
      groupPolicy: "allowlist",
      groupAllowFrom: ["@admin:example.org"],
      groups: {
        "!roomid:example.org": {
          requireMention: true,
        },
      },
    },
  },
}
```

See [Groups](/channels/groups) for mention-gating and allowlist behavior.

## Multi-account example

```json5
{
  channels: {
    "matrix-js": {
      enabled: true,
      dm: { policy: "pairing" },
      accounts: {
        assistant: {
          homeserver: "https://matrix.example.org",
          accessToken: "syt_assistant_xxx",
          encryption: true,
        },
        alerts: {
          homeserver: "https://matrix.example.org",
          accessToken: "syt_alerts_xxx",
          dm: {
            policy: "allowlist",
            allowFrom: ["@ops:example.org"],
          },
        },
      },
    },
  },
}
```

## Configuration reference

- `enabled`: enable or disable the channel.
- `homeserver`: homeserver URL, for example `https://matrix.example.org`.
- `userId`: full Matrix user ID, for example `@bot:example.org`.
- `accessToken`: access token for token-based auth.
- `password`: password for password-based login.
- `register`: auto-register if login fails and homeserver allows registration.
- `deviceId`: explicit Matrix device ID.
- `deviceName`: device display name for password login.
- `initialSyncLimit`: startup sync event limit.
- `encryption`: enable E2EE.
- `allowlistOnly`: force allowlist-only behavior for DMs and rooms.
- `groupPolicy`: `open`, `allowlist`, or `disabled`.
- `groupAllowFrom`: allowlist of user IDs for room traffic.
- `replyToMode`: `off`, `first`, or `all`.
- `threadReplies`: `off`, `inbound`, or `always`.
- `textChunkLimit`: outbound message chunk size.
- `chunkMode`: `length` or `newline`.
- `responsePrefix`: optional message prefix for outbound replies.
- `mediaMaxMb`: outbound media size cap in MB.
- `autoJoin`: invite auto-join policy (`always`, `allowlist`, `off`).
- `autoJoinAllowlist`: rooms/aliases allowed when `autoJoin` is `allowlist`.
- `dm`: DM policy block (`enabled`, `policy`, `allowFrom`).
- `groups`: per-room policy map.
- `rooms`: legacy alias for `groups`.
- `actions`: per-action tool gating (`messages`, `reactions`, `pins`, `memberInfo`, `channelInfo`, `verification`).
