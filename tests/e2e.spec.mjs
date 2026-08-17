import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const routes = ["create", "websites", "documents", "models", "work", "connect"];

test.beforeEach(async ({ page }) => {
  await page.goto("/#create");
  await expect(page.getByRole("heading", { name: /Create a shot/ })).toBeVisible();
});

test("primary navigation exposes every workspace without console errors", async ({ page }) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  for (const route of routes) {
    await page.goto(`/#${route}`);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator(`.top-nav a[href="#${route}"]`)).toHaveClass(/active/);
  }
  expect(errors).toEqual([]);
});

test("video → image → video resets model controls, quote, and prompt draft", async ({ page }) => {
  const trigger = page.getByRole("button", { name: /Change model, current/ });
  if (!/Video/.test(await trigger.getAttribute("aria-label"))) {
    await trigger.click();
    await page.getByRole("button", { name: "Switch output to Video" }).click();
  }
  await expect(trigger).toHaveAttribute("aria-label", /Video/);
  await page.getByPlaceholder("Describe what you want to make...").fill("A simple controlled video test of a red mug in morning light.");
  await page.getByRole("button", { name: "Refine prompt" }).click();
  await expect(page.locator(".rewrite")).toBeVisible();

  await trigger.click();
  await page.getByRole("button", { name: "Switch output to Image" }).click();
  await expect(trigger).toHaveAttribute("aria-label", /Image/);
  await expect(page.locator(".rewrite")).toHaveCount(0);
  const imageControls = await page.locator(".bar-chips .chip button").allTextContents();
  expect(imageControls.join(" ")).not.toMatch(/720p|8s|fps/i);

  await trigger.click();
  await page.getByRole("button", { name: "Switch output to Video" }).click();
  await expect(trigger).toHaveAttribute("aria-label", /Video/);
  const videoControls = await page.locator(".bar-chips .chip button").allTextContents();
  expect(videoControls.length).toBeGreaterThanOrEqual(2);
});

test("model picker opens within the viewport and reflects the active output", async ({ page }, testInfo) => {
  if (testInfo.project.name === "desktop") {
    await page.setViewportSize({ width: 1440, height: 574 });
  }
  const trigger = page.getByRole("button", { name: /Change model, current/ });
  const activeOutput = /Video/.test(await trigger.getAttribute("aria-label")) ? "Video" : "Image";
  await trigger.click();
  const popover = page.locator(".model-picker-popover");
  await expect(popover).toBeVisible();
  await expect(page.getByRole("button", { name: `Switch output to ${activeOutput}` })).toHaveAttribute("aria-pressed", "true");
  const geometry = await page.evaluate(() => {
    const header = document.querySelector(".top").getBoundingClientRect();
    const picker = document.querySelector(".model-picker-popover").getBoundingClientRect();
    return { headerBottom: header.bottom, top: picker.top, bottom: picker.bottom, viewport: window.innerHeight };
  });
  expect(geometry.top).toBeGreaterThanOrEqual(geometry.headerBottom + 8);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewport - 8);
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
});

test("an attachment follows compatible models and is removed before an incompatible switch", async ({ page }) => {
  await page.route("**/api/upload", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        url: "https://example.test/reference.png",
        remote_url: "https://example.test/reference.png",
        local_url: "/media/reference.png",
        upload_id: "test-reference",
        media_type: "image",
        content_type: "image/png",
      }),
    });
  });
  await page.getByRole("button", { name: "Add input media" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a", "hex"),
  });
  await expect(page.getByRole("button", { name: "Remove reference.png" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Change model, current/ })).toHaveAttribute("aria-label", /i2v|edit|reference/i);

  await page.getByRole("button", { name: /Change model, current/ }).click();
  await page.getByRole("option", { name: /Seedance 2\.5 i2v Bytedance.*Video/i }).click();
  await expect(page.getByRole("button", { name: /Change model, current/ })).toHaveAttribute("aria-label", /Seedance 2\.5 i2v/);
  await expect(page.getByRole("button", { name: "Remove reference.png" })).toBeVisible();

  await page.getByRole("button", { name: /Change model, current/ }).click();
  await page.getByRole("option", { name: /LTX 2\.5 fast Lightricks.*Video/i }).first().click();
  await expect(page.getByRole("button", { name: "Remove reference.png" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText(/Removed 1 incompatible reference/i);
});

test("provider failures become actionable UI and never leave a phantom running job", async ({ page }) => {
  await page.route("**/api/optimize", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ optimized: true, prompt: "A concise controlled test prompt." }),
  }));
  await page.route("**/api/generate", (route) => route.fulfill({
    status: 502,
    contentType: "application/json",
    body: JSON.stringify({ error: "Provider timed out before generation completed." }),
  }));
  await page.getByPlaceholder("Describe what you want to make...").fill("A controlled failure test.");
  await page.getByRole("button", { name: "Refine prompt" }).click();
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByRole("alert")).toContainText("Provider timed out before generation completed.");
  await expect(page.getByRole("button", { name: "Generate" })).toBeEnabled();
  await expect(page.getByText(/Submitting to|Queued|Generating/i)).toHaveCount(0);
});

test("results autoplay muted and only explicit control enables one video", async ({ page }) => {
  await page.goto("/#work");
  const videos = page.locator(".work-video");
  if (await videos.count()) {
    await expect.poll(() => videos.evaluateAll((items) => items.every((video) => video.muted && video.defaultMuted))).toBe(true);
    const toggles = page.locator(".work-sound-toggle");
    await toggles.first().click();
    await expect.poll(() => videos.evaluateAll((items) => items.filter((video) => !video.muted).length)).toBe(1);
    await toggles.first().click();
    await expect.poll(() => videos.evaluateAll((items) => items.every((video) => video.muted))).toBe(true);
  }
});

test("a result can be deleted only after explicit confirmation", async ({ page }) => {
  await page.route("**/api/results/*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, summary: { month: 0, all_time: 0, total_generations: 0 } }),
  }));
  await page.goto("/#work");
  const cards = page.locator(".work");
  const initialCount = await cards.count();
  test.skip(initialCount === 0, "No archived result is available in this local fixture");
  const first = cards.first();
  await first.getByRole("button", { name: /^Delete / }).click();
  await expect(first.getByText("Delete this result?")).toBeVisible();
  await expect(first.getByText(/fal-hosted copy may remain/i)).toBeVisible();
  await first.getByRole("button", { name: "Keep it" }).click();
  await expect(first.getByText("Delete this result?")).toHaveCount(0);
  await first.getByRole("button", { name: /^Delete / }).click();
  await first.getByRole("button", { name: "Delete result" }).click();
  await expect(cards).toHaveCount(initialCount - 1);
});

test("website, document, and result archives expose previews and actions", async ({ page }) => {
  await page.goto("/#websites");
  await expect(page.getByText("Local website reference")).toBeVisible();
  await page.goto("/#documents");
  await expect(page.getByText("Local document reference")).toBeVisible();
  await page.goto("/#work");
  await expect(page.locator("main")).toBeVisible();
});

test("actionable offline state is shown when the catalog cannot load", async ({ page }) => {
  await page.route("**/api/models", (route) => route.abort());
  await page.reload();
  await expect(page.getByText("Connecting to the model catalog")).toBeVisible();
});

test("keyboard focus is visible and no serious accessibility violations exist", async ({ page }, testInfo) => {
  const route = testInfo.project.name === "mobile" ? "create" : "work";
  await page.goto(`/#${route}`);
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus-visible")).toBeVisible();
  const results = await new AxeBuilder({ page }).exclude("iframe").analyze();
  const serious = results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact));
  expect(serious, serious.map((item) => `${item.id}: ${item.help}`).join("\n")).toEqual([]);
});

test("every workspace has no serious accessibility violations", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  for (const route of routes) {
    await page.goto(`/#${route}`);
    await page.waitForTimeout(350);
    const results = await new AxeBuilder({ page }).exclude("iframe").analyze();
    const serious = results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact));
    expect(serious, `${route}: ${serious.map((item) => `${item.id}: ${item.help}`).join("\n")}`).toEqual([]);
  }
});

test("creator visual contract stays stable", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".creator")).toHaveScreenshot(`creator-${testInfo.project.name}.png`, {
    animations: "disabled",
    mask: [page.locator(".creator-head"), page.locator(".model-picker-trigger img")],
  });
});

test("tablet and ultrawide layouts remain contained", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  for (const viewport of [{ width: 768, height: 1024 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/#create");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${viewport.width}px layout overflows`).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: /Change model, current/ })).toBeVisible();
  }
});

test("mobile layouts have no horizontal overflow and key controls remain reachable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  for (const route of routes) {
    await page.goto(`/#${route}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${route} overflows horizontally`).toBeLessThanOrEqual(1);
  }
  await page.goto("/#create");
  await expect(page.getByPlaceholder("Describe what you want to make...")).toBeVisible();
  await expect(page.getByRole("button", { name: /Change model, current/ })).toBeVisible();
});
