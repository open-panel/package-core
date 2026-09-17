# @open-panel/core

Daemon-internal glue for [OpenPanel](https://github.com/open-panel/openPanel):
a structured `Logger` with secret redaction, and `ProfileRuntime` — the one
place that connects "button N was pressed" to "look up the active
profile/page and run its action," and "render a page" to "push labels/images
to a device."

> **Scope note.** This package is the daemon's own glue code, not a general
> extension point — most third-party consumers want
> [`@open-panel/plugin-sdk`](https://www.npmjs.com/package/@open-panel/plugin-sdk),
> [`@open-panel/device-sdk`](https://www.npmjs.com/package/@open-panel/device-sdk)
> or [`@open-panel/action-engine`](https://www.npmjs.com/package/@open-panel/action-engine)
> instead. It's published for completeness and for anyone embedding the same
> daemon-side wiring in their own host, but its API tracks the daemon's needs
> first.

## Install

```bash
npm install @open-panel/core
```

## What's in here

- **`Logger`** — structured logging with a bounded in-memory ring buffer
  (`recent(limit)`), a pluggable `sink` (e.g. to forward entries over IPC),
  and automatic, recursive redaction of any metadata key that looks like a
  password/token/secret/API key (`redact()`, exported standalone too).
- **`ProfileRuntime`** — wires a `DriverRegistry` (`@open-panel/device-sdk`)
  to a `ProfileRepository` (`@open-panel/profile-engine`) and an
  `ActionEngine` (`@open-panel/action-engine`): button events resolve to
  actions, page changes resolve to device renders, and it tracks per-device
  calibration mode and hotkey-switch on/off state.
- **Image generators** — `createActionIconImage`, `createPageIndicatorImage`,
  `createCalibrationPatternImage`, used by `ProfileRuntime` to render what a
  device's screen should show without pulling an image library into
  `@open-panel/device-sdk` itself.

## Usage

```ts
import { Logger } from "@open-panel/core";

const logger = new Logger({ sink: (entry) => broadcastOverIpc(entry) });
logger.info("daemon.started", { port: 47912 });
```

```ts
import { ProfileRuntime } from "@open-panel/core";

const runtime = new ProfileRuntime(driverRegistry, profileRepository, actionEngine, logger);
runtime.onProfileActivated((profile) => console.log("active profile", profile.name));
```

## Related packages

- [`@open-panel/shared`](https://www.npmjs.com/package/@open-panel/shared)
- [`@open-panel/device-sdk`](https://www.npmjs.com/package/@open-panel/device-sdk)
- [`@open-panel/profile-engine`](https://www.npmjs.com/package/@open-panel/profile-engine)
- [`@open-panel/action-engine`](https://www.npmjs.com/package/@open-panel/action-engine)

## License

MIT © [OpenPanel contributors](https://github.com/open-panel/package-core/blob/main/LICENSE)
