import type { DeviceConnectionManager, DriverRegistry } from "@open-panel/device-sdk";
import type { ActionEngine, RelativePage } from "@open-panel/action-engine";
import { PAGE_INDICATOR_ACTION, type ButtonEvent, type Profile } from "@open-panel/shared";
import {
  findButton,
  findPageContainingButton,
  pagesInLayer,
  type ProfileRepository,
} from "@open-panel/profile-engine";
import { createActionIconImage } from "./action-icon-image.js";
import { createCalibrationPatternImage } from "./calibration-pattern.js";
import { createPageIndicatorImage } from "./page-indicator-image.js";
import type { Logger } from "./logger.js";

/**
 * The glue between devices, profiles and actions (specs.md #7 "Profile
 * runtime"). This is the ONLY place that knows a button press should trigger
 * an action lookup, and that "change page" means re-rendering a device — it
 * has no HID/UI knowledge itself, only the DeckDevice/DeviceInfo abstraction.
 */
export class ProfileRuntime {
  private readonly currentPageByDevice = new Map<string, string>();

  /**
   * Devices currently in calibration mode (entered/exited via the desktop
   * calibration UI, see apps/daemon device-calibration.ts). While a device
   * is in this set: every position shows the same generated reference
   * pattern instead of the active profile's icons (so the user has a fixed,
   * known-good image to judge alignment against instead of whatever's
   * currently configured, or nothing at all), and physical button presses
   * are ignored instead of firing actions — nudging a button's calibration
   * shouldn't also, say, open a URL or run a shell command. Intentionally
   * in-memory only: a daemon restart always comes back in normal mode.
   */
  private readonly calibratingDeviceIds = new Set<string>();

  /**
   * Which way each "Hotkey Switch" key is currently flipped, by button id.
   * In-memory on purpose: nothing can tell us what the application on the
   * other end did while the daemon was down, so every switch comes back "off"
   * rather than claiming a state it cannot verify.
   */
  private readonly switchedOnButtonIds = new Set<string>();

  private readonly buttonPressedListeners = new Set<(event: ButtonEvent) => void>();
  private readonly profileActivatedListeners = new Set<(profile: Profile) => void>();

  constructor(
    private readonly registry: DriverRegistry,
    private readonly profiles: ProfileRepository,
    private readonly actions: ActionEngine,
    private readonly logger: Logger,
  ) {
    this.registry.onDeviceConnected((info) => {
      this.currentPageByDevice.delete(info.id);
      void this.renderDevice(info.id);
    });
    this.registry.onDeviceEvent((event) => {
      // Logged unconditionally (specs.md #9 Observable/debuggable) so a
      // physical button press is visible via `openpanel logs` even before
      // any action is configured on it — this is the fastest way to verify
      // a new device's input parsing without instrumenting anything extra.
      this.logger.info("device.event", {
        type: event.type,
        deviceId: event.deviceId,
        position: event.position,
      });
      if (event.type === "button.press") void this.handlePress(event.deviceId, event.position);
    });
  }

  /** Passed to ActionEngine as `navigateToPage` so the "change-page" built-in can drive this. */
  navigateToPage = async (pageId: string, meta: { deviceId?: string }): Promise<void> => {
    const profile = this.profiles.getActiveProfile();
    if (!profile) throw new Error("No active profile");
    if (!profile.pages.some((p) => p.id === pageId)) {
      throw new Error(`Page not found in active profile: ${pageId}`);
    }

    const deviceIds = meta.deviceId
      ? [meta.deviceId]
      : this.registry.listDevices().map((d) => d.id);
    for (const deviceId of deviceIds) {
      this.currentPageByDevice.set(deviceId, pageId);
      await this.renderDevice(deviceId);
    }
  };

  /**
   * Passed to ActionEngine as `navigateRelativePage` for the next/previous/
   * first/last built-ins. next/previous wrap: on a two-page profile a single
   * "next" key can reach both pages, and a key that silently does nothing at
   * the end of the deck reads as broken hardware.
   */
  navigateRelativePage = async (to: RelativePage, meta: { deviceId?: string }): Promise<void> => {
    const profile = this.profiles.getActiveProfile();
    if (!profile) throw new Error("No active profile");
    if (profile.pages.length === 0) throw new Error("The active profile has no pages");

    const deviceIds = meta.deviceId
      ? [meta.deviceId]
      : this.registry.listDevices().map((d) => d.id);
    for (const deviceId of deviceIds) {
      const current = this.getCurrentPageId(deviceId);
      // Navigation is layer-local: inside a folder, next/previous cycle that
      // folder's pages, never the profile's whole flat list.
      const layer = pagesInLayer(
        profile,
        profile.pages.find((page) => page.id === current)?.parentButtonId,
      );
      if (layer.length === 0) continue;
      const index = Math.max(
        0,
        layer.findIndex((page) => page.id === current),
      );
      const total = layer.length;
      const target =
        to === "first"
          ? 0
          : to === "last"
            ? total - 1
            : to === "next"
              ? (index + 1) % total
              : (index - 1 + total) % total;

      this.currentPageByDevice.set(deviceId, layer[target]!.id);
      await this.renderDevice(deviceId);
    }
  };

  /**
   * Passed to ActionEngine as `enterFolder`: the pressed button's own id names
   * the layer to move into, so a folder key needs no configuration and folders
   * nest to any depth for free.
   */
  enterFolder = async (meta: { deviceId?: string; buttonId?: string }): Promise<void> => {
    const profile = this.profiles.getActiveProfile();
    if (!profile) throw new Error("No active profile");
    if (!meta.buttonId) throw new Error("A folder can only be opened by pressing its key");

    const layer = pagesInLayer(profile, meta.buttonId);
    const first = layer[0];
    if (!first) throw new Error("This folder has no pages");

    const deviceIds = meta.deviceId
      ? [meta.deviceId]
      : this.registry.listDevices().map((d) => d.id);
    for (const deviceId of deviceIds) {
      this.currentPageByDevice.set(deviceId, first.id);
      await this.renderDevice(deviceId);
    }
  };

  /** Passed to ActionEngine as `exitFolder`: back to the page holding this layer's folder button. */
  exitFolder = async (meta: { deviceId?: string }): Promise<void> => {
    const profile = this.profiles.getActiveProfile();
    if (!profile) throw new Error("No active profile");

    const deviceIds = meta.deviceId
      ? [meta.deviceId]
      : this.registry.listDevices().map((d) => d.id);
    for (const deviceId of deviceIds) {
      const currentId = this.getCurrentPageId(deviceId);
      const parentButtonId = profile.pages.find((page) => page.id === currentId)?.parentButtonId;
      // Already at the root: nothing above to go back to.
      if (!parentButtonId) continue;

      const target = findPageContainingButton(profile, parentButtonId);
      if (!target) continue;
      this.currentPageByDevice.set(deviceId, target.id);
      await this.renderDevice(deviceId);
    }
  };

  /**
   * Passed to ActionEngine as `toggleSwitch`: flips the pressed key and reports
   * where it landed, so "hotkey.switch" can pick which shortcut to send. The
   * key is redrawn here rather than by the action, for the same reason page
   * navigation lives in the runtime — the action has no idea it is on a screen.
   */
  toggleSwitch = async (meta: { deviceId?: string; buttonId?: string }): Promise<boolean> => {
    if (!meta.buttonId) throw new Error("A hotkey switch can only be flipped by pressing its key");

    const switchedOn = !this.switchedOnButtonIds.has(meta.buttonId);
    if (switchedOn) this.switchedOnButtonIds.add(meta.buttonId);
    else this.switchedOnButtonIds.delete(meta.buttonId);

    // Every device, not just the pressing one: the same page can be open on
    // two decks, and a switch that only redraws one of them starts lying.
    for (const device of this.registry.listDevices()) await this.renderDevice(device.id);
    return switchedOn;
  };

  /** Passed to ActionEngine as `switchProfile` so the "profile.switch" built-in can drive this. */
  switchProfile = async (profileId: string): Promise<void> => {
    const target = this.profiles.list().find((profile) => profile.id === profileId);
    if (!target) throw new Error(`Profile not found: ${profileId}`);

    this.profiles.setActiveProfile(profileId);
    // Remembered pages are per device and keyed by page id; getCurrentPageId
    // already falls back when one does not belong to the new profile, but
    // clearing them makes a profile switch always land on page 1.
    this.currentPageByDevice.clear();
    await this.renderAll();

    for (const listener of this.profileActivatedListeners) listener(target);
  };

  /** Fired for every physical press the runtime handles, so IPC clients can mirror the device live. */
  onButtonPressed(listener: (event: ButtonEvent) => void): () => void {
    this.buttonPressedListeners.add(listener);
    return () => this.buttonPressedListeners.delete(listener);
  }

  /** Fired when an action (not the desktop) made another profile active. */
  onProfileActivated(listener: (profile: Profile) => void): () => void {
    this.profileActivatedListeners.add(listener);
    return () => this.profileActivatedListeners.delete(listener);
  }

  getCurrentPageId(deviceId: string): string | undefined {
    const profile = this.profiles.getActiveProfile();
    if (!profile) return undefined;
    // A remembered page only applies to the profile it was set under — after
    // switching (or deleting/recreating) the active profile, a stale id here
    // would either point nowhere or, worse, silently resolve into the wrong
    // profile's page of the same id, so fall back to that profile's first page.
    const remembered = this.currentPageByDevice.get(deviceId);
    if (remembered && profile.pages.some((p) => p.id === remembered)) return remembered;
    // Falls back to the first ROOT page: pages[0] could be a page that only
    // exists behind a folder key, which is not a place a device should boot into.
    return pagesInLayer(profile)[0]?.id;
  }

  /** Re-renders every connected device against the (possibly just-changed) active profile. */
  async renderAll(): Promise<void> {
    for (const device of this.registry.listDevices()) {
      await this.renderDevice(device.id);
    }
  }

  isCalibrating(deviceId: string): boolean {
    return this.calibratingDeviceIds.has(deviceId);
  }

  /** Freezes the device on a generated reference pattern and stops it from executing actions — see the field doc above. */
  async enterCalibrationMode(deviceId: string): Promise<void> {
    this.calibratingDeviceIds.add(deviceId);
    await this.renderDevice(deviceId);
  }

  /** Restores normal profile rendering and button presses. */
  async exitCalibrationMode(deviceId: string): Promise<void> {
    this.calibratingDeviceIds.delete(deviceId);
    await this.renderDevice(deviceId);
  }

  private async handlePress(deviceId: string, position: number): Promise<void> {
    if (this.calibratingDeviceIds.has(deviceId)) return;

    const profile = this.profiles.getActiveProfile();
    const pageId = this.getCurrentPageId(deviceId);
    const button = profile && pageId ? findButton(profile, pageId, position) : undefined;

    // Announced for every press, including one on an unconfigured position:
    // the desktop mirrors presses onto its deck, and seeing a key light up
    // with no action on it is exactly how you confirm the wiring end to end.
    const event: ButtonEvent = {
      deviceId,
      profileId: profile?.id,
      pageId,
      buttonId: button?.id,
      position,
      timestamp: Date.now(),
    };
    for (const listener of this.buttonPressedListeners) listener(event);

    if (!profile || !pageId || !button?.action) return;

    await this.actions.execute(button.action, { deviceId, buttonId: button.id });
  }

  private async renderDevice(deviceId: string): Promise<void> {
    const manager = this.registry.getDevice(deviceId);
    if (!manager) return;

    if (this.calibratingDeviceIds.has(deviceId)) {
      await this.renderCalibrationPattern(deviceId, manager);
      return;
    }

    const profile = this.profiles.getActiveProfile();
    const pageId = this.getCurrentPageId(deviceId);
    const page = profile && pageId ? profile.pages.find((p) => p.id === pageId) : undefined;

    // No active profile/page (e.g. the active profile was just deleted) —
    // blank every position instead of leaving whatever the device was
    // showing before stuck on it (specs.md Rule 6 applies to leftover
    // physical-device state too, not just leftover UI state).
    if (!profile || !page) {
      await this.blankDevice(deviceId, manager);
      return;
    }

    const buttonsByPosition = new Map(page.buttons.map((b) => [b.position, b]));
    const buttonCount = manager.info.capabilities.buttons;
    // A page-indicator key shows where the device is within its own layer, so
    // both numbers are derived here on every render rather than stored.
    const layer = pagesInLayer(profile, page.parentButtonId);
    const pageNumber = layer.findIndex((candidate) => candidate.id === page.id) + 1;
    const pageCount = layer.length;

    // Walk every physical position, not just configured buttons — a
    // removed button (or one that never had an icon) must blank its
    // position rather than keep showing whatever was drawn there before
    // (specs.md Rule 6 applies to leftover UI state too, not just crashes).
    //
    // Positions are prepared CONCURRENTLY (specs.md #28: UI/other devices
    // must not block on this) — for adapters like the FIFINE D6, this only
    // queues + JPEG-encodes each icon, no hardware I/O happens until the
    // single `flush()` below, so there's no ordering requirement here and
    // no reason to encode N icons one at a time.
    const queueStartedAt = Date.now();
    await Promise.all(
      Array.from({ length: buttonCount }, async (_, position) => {
        const button = buttonsByPosition.get(position);
        try {
          const isIndicator = button?.action?.type === PAGE_INDICATOR_ACTION;
          const label = isIndicator ? `${pageNumber}/${pageCount}` : button?.appearance.label;
          if (label) await manager.setButtonLabel(position, label);

          // The indicator is drawn, not labelled: a device whose keys are
          // screens reports supportsButtonLabels: false, so text only reaches
          // it inside an image. A configured icon still wins, so a custom
          // indicator icon is possible.
          if (button?.appearance.icon) {
            await manager.setButtonImage(position, decodeIcon(button.appearance.icon));
          } else if (isIndicator) {
            await manager.setButtonImage(position, createPageIndicatorImage(pageNumber, pageCount));
          } else if (button?.action) {
            // No custom icon, but the key does something — the desktop grid
            // already falls back to the action's type icon instead of a
            // blank tile, so the physical device should show the same thing
            // instead of going dark.
            await manager.setButtonImage(
              position,
              createActionIconImage(button.action.type, button.action.config, {
                switchedOn: this.switchedOnButtonIds.has(button.id),
              }),
            );
          } else {
            await manager.clearButtonImage(position);
          }
        } catch (err) {
          // Rendering a single button must never abort the rest, nor crash the daemon (Rule 6).
          this.logger.warn("button.render_failed", { deviceId, position, error: String(err) });
        }
      }),
    );
    this.logger.info("device.render_queued", { deviceId, tookMs: Date.now() - queueStartedAt });

    // One commit for the whole batch, not one per button — some devices'
    // internal image addressing gets confused by committing after every
    // single write instead of once per render pass (specs.md #9, #28: a
    // render pass should be one coherent update, not N separate ones).
    const flushStartedAt = Date.now();
    try {
      await manager.flush();
      this.logger.info("device.render_flushed", { deviceId, tookMs: Date.now() - flushStartedAt });
    } catch (err) {
      this.logger.warn("device.flush_failed", { deviceId, error: String(err) });
    }
  }

  /** Pushes the same generated reference pattern to every position — see `calibratingDeviceIds`' doc comment. */
  private async renderCalibrationPattern(
    deviceId: string,
    manager: DeviceConnectionManager,
  ): Promise<void> {
    const buttonCount = manager.info.capabilities.buttons;
    await Promise.all(
      Array.from({ length: buttonCount }, async (_, position) => {
        try {
          await manager.setButtonImage(position, createCalibrationPatternImage(position));
        } catch (err) {
          this.logger.warn("button.render_failed", { deviceId, position, error: String(err) });
        }
      }),
    );
    try {
      await manager.flush();
    } catch (err) {
      this.logger.warn("device.flush_failed", { deviceId, error: String(err) });
    }
  }

  private async blankDevice(deviceId: string, manager: DeviceConnectionManager): Promise<void> {
    const buttonCount = manager.info.capabilities.buttons;
    await Promise.all(
      Array.from({ length: buttonCount }, async (_, position) => {
        try {
          await manager.clearButtonImage(position);
          await manager.setButtonLabel(position, "");
        } catch (err) {
          this.logger.warn("button.render_failed", { deviceId, position, error: String(err) });
        }
      }),
    );
    try {
      await manager.flush();
    } catch (err) {
      this.logger.warn("device.flush_failed", { deviceId, error: String(err) });
    }
  }
}

/** Button icons are stored as a data URI or bare base64 string (specs.md #13). */
function decodeIcon(icon: string): Buffer {
  const commaIndex = icon.indexOf(",");
  const base64 = icon.startsWith("data:") && commaIndex !== -1 ? icon.slice(commaIndex + 1) : icon;
  return Buffer.from(base64, "base64");
}
