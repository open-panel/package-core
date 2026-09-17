import { describe, expect, it } from "vitest";
import { DriverRegistry, MockDevice, MockDriver } from "@open-panel/device-sdk";
import { openDatabase, ProfileRepository, addPage, upsertButton } from "@open-panel/profile-engine";
import { ActionEngine, ActionRegistry, changePageAction } from "@open-panel/action-engine";
import { Logger } from "./logger.js";
import { ProfileRuntime } from "./profile-runtime.js";

function setup() {
  const db = openDatabase(":memory:");
  const profiles = new ProfileRepository(db);
  const registry = new DriverRegistry({ pollIntervalMs: 1_000_000 });
  const logger = new Logger({ write: () => {} });

  const registryActions = new ActionRegistry();
  const executed: string[] = [];
  registryActions.register({
    type: "test.mark",
    name: "Mark",
    async execute() {
      executed.push("ran");
    },
  });
  registryActions.register(changePageAction);

  let runtime: ProfileRuntime;
  const actions: ActionEngine = new ActionEngine(registryActions, {
    navigateToPage: (pageId, meta) => runtime.navigateToPage(pageId, meta),
  });

  runtime = new ProfileRuntime(registry, profiles, actions, logger);
  return { db, profiles, registry, actions, runtime, executed };
}

describe("ProfileRuntime", () => {
  it("executes the action bound to the pressed button on the active page", async () => {
    const { profiles, registry, executed } = setup();
    let profile = profiles.create({ name: "Dev" });
    profile = addPage(profile, "Main");
    profile = upsertButton(profile, profile.pages[0]!.id, {
      position: 0,
      action: { type: "test.mark", config: {} },
    });
    profiles.update(profile);
    profiles.setActiveProfile(profile.id);

    const mock = new MockDevice("d1");
    registry.register(new MockDriver([mock]));
    await registry.start();

    mock.simulatePress(0);
    await new Promise((r) => setTimeout(r, 0));

    expect(executed).toEqual(["ran"]);
    await registry.stop();
  });

  it("ignores presses on positions with no configured button/action", async () => {
    const { profiles, registry, executed } = setup();
    let profile = profiles.create({ name: "Dev" });
    profile = addPage(profile, "Main");
    profiles.update(profile);
    profiles.setActiveProfile(profile.id);

    const mock = new MockDevice("d1");
    registry.register(new MockDriver([mock]));
    await registry.start();

    mock.simulatePress(7);
    await new Promise((r) => setTimeout(r, 0));

    expect(executed).toEqual([]);
    await registry.stop();
  });

  it("supports change-page, switching which page's buttons trigger on later presses", async () => {
    const { profiles, registry, runtime, executed } = setup();
    let profile = profiles.create({ name: "Dev" });
    profile = addPage(profile, "Main");
    profile = addPage(profile, "Second");
    const [mainPage, secondPage] = profile.pages;
    profile = upsertButton(profile, mainPage!.id, {
      position: 0,
      action: { type: "change-page", config: { pageId: secondPage!.id } },
    });
    profile = upsertButton(profile, secondPage!.id, {
      position: 0,
      action: { type: "test.mark", config: {} },
    });
    profiles.update(profile);
    profiles.setActiveProfile(profile.id);

    const mock = new MockDevice("d1");
    registry.register(new MockDriver([mock]));
    await registry.start();

    mock.simulatePress(0); // triggers change-page on Main
    await new Promise((r) => setTimeout(r, 0));
    expect(runtime.getCurrentPageId(mock.id)).toBe(secondPage!.id);

    mock.simulatePress(0); // now hits Second's button
    await new Promise((r) => setTimeout(r, 0));
    expect(executed).toEqual(["ran"]);

    await registry.stop();
  });

  it("renders button labels/images to the device when it connects", async () => {
    const { profiles, registry } = setup();
    let profile = profiles.create({ name: "Dev" });
    profile = addPage(profile, "Main");
    profile = upsertButton(profile, profile.pages[0]!.id, {
      position: 2,
      appearance: { label: "Build" },
    });
    profiles.update(profile);
    profiles.setActiveProfile(profile.id);

    const mock = new MockDevice("d1");
    registry.register(new MockDriver([mock]));
    await registry.start();
    await new Promise((r) => setTimeout(r, 0));

    expect(mock.buttonLabels.get(2)).toBe("Build");
    await registry.stop();
  });

  it("draws the action's type icon on a key that has no custom icon, instead of leaving it blank", async () => {
    const { profiles, registry } = setup();
    let profile = profiles.create({ name: "Dev" });
    profile = addPage(profile, "Main");
    profile = upsertButton(profile, profile.pages[0]!.id, {
      position: 0,
      action: { type: "test.mark", config: {} },
    });
    profiles.update(profile);
    profiles.setActiveProfile(profile.id);

    const mock = new MockDevice("d1");
    registry.register(new MockDriver([mock]));
    await registry.start();
    await new Promise((r) => setTimeout(r, 0));

    expect(mock.buttonImages.has(0)).toBe(true);
    // An unconfigured position never gets an image at all.
    expect(mock.buttonImages.has(1)).toBe(false);
    await registry.stop();
  });

  it("blanks the device when the active profile is deleted", async () => {
    const { profiles, registry, runtime } = setup();
    let profile = profiles.create({ name: "Dev" });
    profile = addPage(profile, "Main");
    profile = upsertButton(profile, profile.pages[0]!.id, {
      position: 2,
      appearance: { label: "Build" },
    });
    profiles.update(profile);
    profiles.setActiveProfile(profile.id);

    const mock = new MockDevice("d1");
    registry.register(new MockDriver([mock]));
    await registry.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(mock.buttonLabels.get(2)).toBe("Build");

    profiles.delete(profile.id);
    await runtime.renderAll();

    expect(mock.buttonLabels.get(2)).toBe("");
    await registry.stop();
  });

  it("shows a reference pattern on every position and ignores presses while calibrating", async () => {
    const { profiles, registry, runtime, executed } = setup();
    let profile = profiles.create({ name: "Dev" });
    profile = addPage(profile, "Main");
    profile = upsertButton(profile, profile.pages[0]!.id, {
      position: 0,
      action: { type: "test.mark", config: {} },
    });
    profiles.update(profile);
    profiles.setActiveProfile(profile.id);

    const mock = new MockDevice("d1");
    registry.register(new MockDriver([mock]));
    await registry.start();
    await new Promise((r) => setTimeout(r, 0));

    await runtime.enterCalibrationMode(mock.id);
    expect(runtime.isCalibrating(mock.id)).toBe(true);
    // Every position gets an image, including ones with no configured button.
    expect(mock.buttonImages.has(0)).toBe(true);
    expect(mock.buttonImages.has(1)).toBe(true);

    mock.simulatePress(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(executed).toEqual([]);

    await runtime.exitCalibrationMode(mock.id);
    expect(runtime.isCalibrating(mock.id)).toBe(false);

    mock.simulatePress(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(executed).toEqual(["ran"]);

    await registry.stop();
  });
});
