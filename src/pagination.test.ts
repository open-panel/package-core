import { describe, expect, it } from "vitest";
import { DriverRegistry, MockDevice, MockDriver } from "@open-panel/device-sdk";
import {
  openDatabase,
  ProfileRepository,
  addPage,
  createFolder,
  pagesInLayer,
  upsertButton,
} from "@open-panel/profile-engine";
import {
  ActionEngine,
  ActionRegistry,
  backFolderAction,
  nextPageAction,
  openFolderAction,
  pageIndicatorAction,
  previousPageAction,
  switchProfileAction,
} from "@open-panel/action-engine";
import { PAGE_INDICATOR_ACTION, type ButtonEvent } from "@open-panel/shared";
import { Logger } from "./logger.js";
import { ProfileRuntime } from "./profile-runtime.js";

/** The page/profile navigation actions, end to end through the runtime. */
function setup() {
  const db = openDatabase(":memory:");
  const profiles = new ProfileRepository(db);
  const registry = new DriverRegistry({ pollIntervalMs: 1_000_000 });
  const logger = new Logger({ write: () => {} });

  const actionRegistry = new ActionRegistry();
  for (const definition of [
    nextPageAction,
    previousPageAction,
    pageIndicatorAction,
    switchProfileAction,
    openFolderAction,
    backFolderAction,
  ]) {
    actionRegistry.register(definition);
  }

  let runtime: ProfileRuntime;
  const actions: ActionEngine = new ActionEngine(actionRegistry, {
    navigateRelativePage: (to, meta) => runtime.navigateRelativePage(to, meta),
    switchProfile: (profileId) => runtime.switchProfile(profileId),
    enterFolder: (meta) => runtime.enterFolder(meta),
    exitFolder: (meta) => runtime.exitFolder(meta),
  });
  runtime = new ProfileRuntime(registry, profiles, actions, logger);

  return { profiles, registry, runtime };
}

/** Three pages, with one navigation action wired to position 0 of every page. */
function threePageProfile(profiles: ProfileRepository, actionType: string) {
  let profile = profiles.create({ name: "Dev" });
  for (const name of ["1", "2", "3"]) profile = addPage(profile, name);
  for (const page of profile.pages) {
    profile = upsertButton(profile, page.id, {
      position: 0,
      action: { type: actionType, config: {} },
    });
  }
  profiles.update(profile);
  profiles.setActiveProfile(profile.id);
  return profiles.getActiveProfile()!;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function attach(registry: DriverRegistry) {
  const mock = new MockDevice("d1");
  registry.register(new MockDriver([mock]));
  await registry.start();
  return mock;
}

describe("relative page navigation", () => {
  it("steps forward and wraps around after the last page", async () => {
    const { profiles, registry, runtime } = setup();
    const profile = threePageProfile(profiles, "page.next");
    const mock = await attach(registry);

    expect(runtime.getCurrentPageId(mock.id)).toBe(profile.pages[0]!.id);

    mock.simulatePress(0);
    await settle();
    expect(runtime.getCurrentPageId(mock.id)).toBe(profile.pages[1]!.id);

    mock.simulatePress(0);
    await settle();
    expect(runtime.getCurrentPageId(mock.id)).toBe(profile.pages[2]!.id);

    mock.simulatePress(0);
    await settle();
    expect(runtime.getCurrentPageId(mock.id)).toBe(profile.pages[0]!.id);

    await registry.stop();
  });

  it("steps backward and wraps around before the first page", async () => {
    const { profiles, registry, runtime } = setup();
    const profile = threePageProfile(profiles, "page.previous");
    const mock = await attach(registry);

    mock.simulatePress(0);
    await settle();
    expect(runtime.getCurrentPageId(mock.id)).toBe(profile.pages[2]!.id);

    mock.simulatePress(0);
    await settle();
    expect(runtime.getCurrentPageId(mock.id)).toBe(profile.pages[1]!.id);

    await registry.stop();
  });

  // No action exposes these any more — picking a specific page is "Go to Page"
  // — but the runtime still offers the moves, so they stay covered.
  it("jumps to the last page and back to the first", async () => {
    const { profiles, registry, runtime } = setup();
    const profile = threePageProfile(profiles, "page.next");
    const mock = await attach(registry);

    await runtime.navigateRelativePage("last", { deviceId: mock.id });
    expect(runtime.getCurrentPageId(mock.id)).toBe(profile.pages[2]!.id);

    await runtime.navigateRelativePage("first", { deviceId: mock.id });
    expect(runtime.getCurrentPageId(mock.id)).toBe(profile.pages[0]!.id);

    await registry.stop();
  });
});

describe("page indicator", () => {
  it("labels the key with the page the device is on, and updates on navigation", async () => {
    const { profiles, registry, runtime } = setup();
    let profile = profiles.create({ name: "Dev" });
    for (const name of ["1", "2", "3"]) profile = addPage(profile, name);
    for (const page of profile.pages) {
      profile = upsertButton(profile, page.id, {
        position: 4,
        appearance: { label: "ignored" },
        action: { type: PAGE_INDICATOR_ACTION, config: {} },
      });
    }
    profiles.update(profile);
    profiles.setActiveProfile(profile.id);

    const mock = await attach(registry);
    expect(mock.buttonLabels.get(4)).toBe("1/3");

    await runtime.navigateRelativePage("next", { deviceId: mock.id });
    expect(mock.buttonLabels.get(4)).toBe("2/3");

    await runtime.navigateRelativePage("last", { deviceId: mock.id });
    expect(mock.buttonLabels.get(4)).toBe("3/3");

    await registry.stop();
  });

  it("does nothing when pressed", async () => {
    const { profiles, registry, runtime } = setup();
    const profile = threePageProfile(profiles, PAGE_INDICATOR_ACTION);
    const mock = await attach(registry);

    mock.simulatePress(0);
    await settle();

    expect(runtime.getCurrentPageId(mock.id)).toBe(profile.pages[0]!.id);
    await registry.stop();
  });
});

describe("switch profile", () => {
  it("activates the target profile, lands on its first page and announces it", async () => {
    const { profiles, registry, runtime } = setup();

    let streaming = profiles.create({ name: "Streaming" });
    streaming = addPage(streaming, "1");
    profiles.update(streaming);

    let dev = profiles.create({ name: "Dev" });
    dev = addPage(dev, "1");
    dev = addPage(dev, "2");
    dev = upsertButton(dev, dev.pages[0]!.id, {
      position: 1,
      action: { type: "profile.switch", config: { profileId: streaming.id } },
    });
    profiles.update(dev);
    profiles.setActiveProfile(dev.id);

    const announced: string[] = [];
    runtime.onProfileActivated((profile) => announced.push(profile.name));

    const mock = await attach(registry);
    mock.simulatePress(1);
    await settle();

    expect(profiles.getActiveProfile()?.id).toBe(streaming.id);
    expect(runtime.getCurrentPageId(mock.id)).toBe(streaming.pages[0]!.id);
    expect(announced).toEqual(["Streaming"]);

    await registry.stop();
  });
});

describe("button press events", () => {
  it("announces every press, including one on an unconfigured position", async () => {
    const { profiles, registry, runtime } = setup();
    const profile = threePageProfile(profiles, "page.next");

    const events: ButtonEvent[] = [];
    runtime.onButtonPressed((event) => events.push(event));

    const mock = await attach(registry);
    mock.simulatePress(9);
    await settle();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      deviceId: mock.id,
      position: 9,
      profileId: profile.id,
      pageId: profile.pages[0]!.id,
    });
    expect(events[0]!.buttonId).toBeUndefined();

    await registry.stop();
  });
});

describe("folders", () => {
  /** Root page 1, a folder on key 3, and a page inside it. */
  function folderProfile(profiles: ProfileRepository) {
    let profile = profiles.create({ name: "Dev" });
    profile = addPage(profile, "1");
    profile = addPage(profile, "2");
    const root = profile.pages[0]!;
    profile = createFolder(profile, root.id, 3);
    profiles.update(profile);
    profiles.setActiveProfile(profile.id);

    const saved = profiles.getActiveProfile()!;
    const folderButton = saved.pages
      .find((page) => page.id === root.id)!
      .buttons.find((button) => button.position === 3)!;
    return { profile: saved, root, folderButton, inner: pagesInLayer(saved, folderButton.id)[0]! };
  }

  it("enters the folder's own pages when its key is pressed", async () => {
    const { profiles, registry, runtime } = setup();
    const { inner } = folderProfile(profiles);
    const mock = await attach(registry);

    mock.simulatePress(3);
    await settle();

    expect(runtime.getCurrentPageId(mock.id)).toBe(inner.id);
    await registry.stop();
  });

  it("comes back out to the page holding the folder key", async () => {
    const { profiles, registry, runtime } = setup();
    const { root } = folderProfile(profiles);
    const mock = await attach(registry);

    mock.simulatePress(3); // into the folder
    await settle();
    mock.simulatePress(0); // the Back key createFolder placed there
    await settle();

    expect(runtime.getCurrentPageId(mock.id)).toBe(root.id);
    await registry.stop();
  });

  it("keeps page navigation inside the folder's layer", async () => {
    const { profiles, registry, runtime } = setup();
    const { folderButton, inner } = folderProfile(profiles);

    // A second page inside the folder, so the layer has two.
    let profile = profiles.getActiveProfile()!;
    profile = addPage(profile, "2", folderButton.id);
    profiles.update(profile);
    const innerPages = pagesInLayer(profiles.getActiveProfile()!, folderButton.id);

    const mock = await attach(registry);
    mock.simulatePress(3);
    await settle();
    expect(runtime.getCurrentPageId(mock.id)).toBe(inner.id);

    await runtime.navigateRelativePage("next", { deviceId: mock.id });
    expect(runtime.getCurrentPageId(mock.id)).toBe(innerPages[1]!.id);

    // Wrapping stays in the layer instead of escaping into the root pages.
    await runtime.navigateRelativePage("next", { deviceId: mock.id });
    expect(runtime.getCurrentPageId(mock.id)).toBe(innerPages[0]!.id);

    await registry.stop();
  });

  it("numbers the page indicator within the layer, not the whole profile", async () => {
    const { profiles, registry, runtime } = setup();
    const { folderButton, inner } = folderProfile(profiles);

    let profile = profiles.getActiveProfile()!;
    // An indicator inside the folder, whose layer has exactly one page so far.
    profile = upsertButton(profile, inner.id, {
      position: 4,
      action: { type: PAGE_INDICATOR_ACTION, config: {} },
    });
    profiles.update(profile);

    const mock = await attach(registry);
    mock.simulatePress(3);
    await settle();
    expect(mock.buttonLabels.get(4)).toBe("1/1");

    profile = addPage(profiles.getActiveProfile()!, "2", folderButton.id);
    profiles.update(profile);
    await runtime.renderAll();
    expect(mock.buttonLabels.get(4)).toBe("1/2");

    await registry.stop();
  });

  it("never boots a device into a page that only exists inside a folder", async () => {
    const { profiles, registry, runtime } = setup();
    const { root } = folderProfile(profiles);
    const mock = await attach(registry);

    expect(runtime.getCurrentPageId(mock.id)).toBe(root.id);
    await registry.stop();
  });

  it("draws the indicator as an image, since the key has no text support", async () => {
    const { profiles, registry } = setup();
    let profile = profiles.create({ name: "Dev" });
    profile = addPage(profile, "1");
    profile = upsertButton(profile, profile.pages[0]!.id, {
      position: 2,
      action: { type: PAGE_INDICATOR_ACTION, config: {} },
    });
    profiles.update(profile);
    profiles.setActiveProfile(profile.id);

    const mock = await attach(registry);

    const drawn = mock.buttonImages.get(2);
    expect(drawn).toBeDefined();
    expect(drawn!.toString("utf-8")).toContain("<svg");
    await registry.stop();
  });
});
