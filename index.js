const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
app.use(express.json());

const { executablePath } = require("puppeteer"); // Added for dynamic Chromium path

const PORT = process.env.PORT || 3000;
const webhookUrl = "https://hook.eu2.make.com/u5nslby643au44g3hftd1tesa3hitdsj";
const targetSelector = "div[id^='primis_playerSekindoSPlayer']";

app.get("/", (req, res) => {
  res.send("✅ Puppeteer server is running. Use POST / to trigger automation.");
});

app.post("/", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "Missing URL" });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: executablePath(),
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    await page.waitForTimeout(5000);

    const buttons = await page.$$("button");
    for (const btn of buttons) {
      const text = await btn.evaluate(el => el.innerText.toLowerCase());
      if (text.includes("accept") || text.includes("agree") || text.includes("allow")) {
        await btn.click();
        break;
      }
    }

    const waitForPlayerReady = async () => {
      let scrollY = 0;
      const maxScroll = 5000;
      while (scrollY < maxScroll) {
        const ready = await page.evaluate((selector) => {
          const el = document.querySelector(selector);
          if (!el) return false;
          const style = getComputedStyle(el);
          const z = parseInt(style.zIndex);
          return style.position === "fixed" && !isNaN(z) && z > 10;
        }, targetSelector);

        if (ready) return true;

        await page.evaluate(() => window.scrollBy(0, 300));
        scrollY += 300;
        await page.waitForTimeout(1000);
      }
      return false;
    };

    await waitForPlayerReady();

    const result = await page.evaluate(async (selector, webhookUrl) => {
      function getStyle(el) {
        const style = window.getComputedStyle(el);
        return {
          tag: el.tagName,
          id: el.id,
          className: el.className,
          position: style.position,
          zIndex: style.zIndex,
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          overflow: style.overflow,
          transform: style.transform,
          filter: style.filter,
          perspective: style.perspective,
          contain: style.contain,
          willChange: style.willChange,
          boundingBox: el.getBoundingClientRect()
        };
      }

      function parseZ(z) {
        return isNaN(parseInt(z)) ? 0 : parseInt(z);
      }

      function findStackingContextConflicts(el, targetZ) {
        const issues = [];
        let current = el.parentElement;
        let depth = 1;

        while (current && current !== document.body) {
          const style = window.getComputedStyle(current);
          const z = parseZ(style.zIndex);
          let descriptor = current.id
            ? `id: "${current.id}"`
            : current.className
              ? `class: "${current.className.trim().replace(/"/g, "")}"`
              : `depth: ${depth}`;

          const hasImplicitStacking = [
            style.transform,
            style.filter,
            style.perspective,
            style.contain,
            style.willChange
          ].some(v => v && v !== "none" && v !== "auto");

          if ((style.position === "relative" || style.position === "absolute" || style.position === "sticky") && style.zIndex !== "auto") {
            if (z < targetZ) {
              issues.push({
                parentInfo: getStyle(current),
                reason: `Ancestor has lower z-index (${z}) than target (${targetZ})`,
                suggestion: `Raise z-index or adjust stacking of ${current.tagName.toLowerCase()} (${descriptor})`
              });
            }
          } else if (hasImplicitStacking) {
            issues.push({
              parentInfo: getStyle(current),
              reason: `Ancestor creates stacking context via transform/filter/perspective`,
              suggestion: `Avoid using transform/filter/perspective on ${current.tagName.toLowerCase()} (${descriptor})`
            });
          }

          if (style.overflow !== "visible") {
            const parentBox = current.getBoundingClientRect();
            const playerBox = el.getBoundingClientRect();
            if (
              parentBox.top > playerBox.bottom ||
              parentBox.bottom < playerBox.top ||
              parentBox.left > playerBox.right ||
              parentBox.right < playerBox.left
            ) {
              issues.push({
                parentInfo: getStyle(current),
                reason: `Ancestor clips content with overflow: ${style.overflow}`,
                suggestion: `Adjust dimensions or overflow style of ${current.tagName.toLowerCase()} (${descriptor})`
              });
            }
          }

          current = current.parentElement;
          depth++;
        }

        return issues;
      }

      function findOverlappingElements(target) {
        const overlaps = [];
        const targetBox = target.getBoundingClientRect();
        const targetZ = parseZ(window.getComputedStyle(target).zIndex);

        document.querySelectorAll("*").forEach(el => {
          if (el === target || target.contains(el) || el.contains(target)) return;
          const style = window.getComputedStyle(el);
          const z = parseZ(style.zIndex);
          if (!["absolute", "fixed"].includes(style.position)) return;
          if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) return;

          const box = el.getBoundingClientRect();
          const overlapping = !(box.right < targetBox.left ||
            box.left > targetBox.right ||
            box.bottom < targetBox.top ||
            box.top > targetBox.bottom);

          if (overlapping && z >= targetZ) {
            overlaps.push({
              obstructingElement: getStyle(el),
              reason: `Element overlaps player and has z-index (${z}) >= player (${targetZ})`,
              suggestion: `Lower z-index or adjust position of ${el.tagName.toLowerCase()}#${el.id || ""}.${el.className || ""}`
            });
          }
        });

        return overlaps;
      }

      const result = {
        url: window.location.href,
        timestamp: new Date().toISOString(),
        environment: {
          width: window.innerWidth,
          height: window.innerHeight,
          userAgent: navigator.userAgent
        }
      };

      const target = document.querySelector(selector);

      if (!target) {
        result.playerFound = false;
        result.message = "Target selector did not match any element.";
      } else {
        const playerZ = parseZ(window.getComputedStyle(target).zIndex);
        result.playerFound = true;
        result.playerZIndex = playerZ;
        result.playerInfo = getStyle(target);
        result.stackingConflicts = findStackingContextConflicts(target, playerZ);
        result.overlappingElements = findOverlappingElements(target);
      }

      await fetch(`${webhookUrl}?data=${encodeURIComponent(JSON.stringify(result))}`);
      return result;
    }, targetSelector, webhookUrl);

    res.json({ success: true, data: result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.toString() });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
