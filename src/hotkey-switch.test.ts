import { describe, expect, it } from "vitest";
import { DriverRegistry, MockDevice, MockDriver } from "@open-panel/device-sdk";
import { addPage, openDatabase, ProfileRepository, upsertButton } from "@open-panel/profile-engine";
import { ActionEngine, ActionRegistry, type ActionDefinition } from "@open-panel/action-engine";
import { HOTKEY_SWITCH_ACTION } from "@open-panel/shared";
import { Logger } from "./logger.js";
import { ProfileRuntime } from "./profile-runtime.js";

/**
 * The per-button on/off state behind "Hotkey Switch", end to end through the
 * runtime. A stand-in for the real action is registered rather than the built-in
 * one: `hotkeySwitchAction` ends in `sendHotkey`, which shells out to the OS's
 * automation tooling, and a unit test has no business pressing real keys. What
 * is under test is the half that has state — the runtime's.
 */
function setup() {
  const db = openDatabase(":memory:");
  const profiles = new ProfileRepository(db);
  const registry = new DriverRegistry({ pollIntervalMs: 1_000_000 });
  const logger = new Logger({ write: () => {} });

  /** Records which side of the switch each press landed on. */
  const sent: boolean[] = [];
  const spy: ActionDefinition<Record<string, unknown>> = {
    type: HOTKEY_SWITCH_ACTION,
    name: "Hotkey Switch",
    async execute(ctx) {
      sent.push(await ctx.toggleSwitch!());
    },
  };

  const actionRegistry = new ActionRegistry();
  actionRegistry.register(spy);

  let runtime: ProfileRuntime;
  const actions: ActionEngine = new ActionEngine(actionRegistry, {
    toggleSwitch: (meta) => runtime.toggleSwitch(meta),
  });
  runtime = new ProfileRuntime(registry, profiles, actions, logger);

  let profile = addPage(profiles.create({ name: "Dev" }), "1");
  profile = upsertButton(profile, profile.pages[0]!.id, {
    position: 0,
    action: { type: HOTKEY_SWITCH_ACTION, config: { on: ["F13"], off: ["F14"] } },
  });
  profiles.update(profile);
  profiles.setActiveProfile(profile.id);

  return { registry, runtime, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function attach(registry: DriverRegistry) {
  const mock = new MockDevice("d1");
  registry.register(new MockDriver([mock]));
  await registry.start();
  return mock;
}

describe("hotkey switch", () => {
  it("alternates between the two sides on every press", async () => {
    const { registry, sent } = setup();
    const mock = await attach(registry);

    for (let press = 0; press < 4; press += 1) {
      mock.simulatePress(0);
      await settle();
    }

    expect(sent).toEqual([true, false, true, false]);
    await registry.stop();
  });

  it("redraws the key so it shows which way it is flipped", async () => {
    const { registry, sent } = setup();
    const mock = await attach(registry);
    const off = mock.buttonImages.get(0)!.toString("utf-8");

    mock.simulatePress(0);
    await settle();
    const on = mock.buttonImages.get(0)!.toString("utf-8");

    expect(sent).toEqual([true]);
    expect(on).not.toBe(off);

    mock.simulatePress(0);
    await settle();
    expect(mock.buttonImages.get(0)!.toString("utf-8")).toBe(off);

    await registry.stop();
  });

  it("refuses to flip when nothing identifies the key that was pressed", async () => {
    const { registry, runtime } = setup();
    await expect(runtime.toggleSwitch({ deviceId: "d1" })).rejects.toThrow(/pressing its key/);
    await registry.stop();
  });
});
