const puppeteer = require("puppeteer");
const fs        = require("fs");
const path      = require("path");
const logger    = require("../utils/logger");

const COOKIES_FILE = path.join(__dirname, "../../cookies.json");

async function refreshCookies(config) {
  const username = process.env.GREPO_EMAIL    || config.account.username;
  const password = process.env.GREPO_PASSWORD || config.account.password;
  const world    = config.account.world;
  const lang     = world.match(/^([a-z]+)/)?.[1] ?? "nl";
  const portal   = `https://${lang}-play.grepolis.com`;
  const index    = `https://${lang}0.grepolis.com/start/index`;

  if (!username || !password) throw new Error("GREPO_EMAIL en GREPO_PASSWORD vereist.");

  logger.info("[Puppeteer] Inloggen...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    // Roteer User-Agent om patroondetectie te vermijden
    const userAgents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ];
    const ua = userAgents[Math.floor(Math.random() * userAgents.length)];
    await page.setUserAgent(ua);

    // Onderschep login-redirect
    let loginRedirectUrl = null;
    page.on("request", req => {
      const url = req.url();
      if (url.includes(`${world}.grepolis.com`) && url.includes("login=1")) {
        loginRedirectUrl = url;
      }
    });

    // Stap 1: Portaal laden en inloggen
    await page.goto(portal, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector("#page_login_always-visible_input_player-identifier", { timeout: 15000 });
    await page.click("#page_login_always-visible_input_player-identifier", { clickCount: 3 });
    await page.type("#page_login_always-visible_input_player-identifier", username, { delay: 50 });
    await page.click("#page_login_always-visible_input_password");
    await page.type("#page_login_always-visible_input_password", password, { delay: 50 });

    const loginBtn = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, a.button"))
        .find(b => ["inloggen","login"].includes(b.textContent?.trim().toLowerCase()));
      if (btn) { btn.click(); return true; }
      return false;
    });

    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    // Stap 2: Wereldkeuze via nl0 form
    await page.goto(index, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    await page.evaluate((world) => {
      const form = document.querySelector('form[action*="login_to_game_world"]');
      if (!form) return;
      let input = form.querySelector('input[name="world"]');
      if (!input) {
        input = document.createElement("input");
        input.type = "hidden"; input.name = "world";
        form.appendChild(input);
      }
      input.value = world;
      form.submit();
    }, world);

    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 4000));

    // Stap 3: Navigeer naar login-redirect indien onderschept
    if (loginRedirectUrl && !page.url().includes(`${world}.grepolis.com/game/${world}`)) {
      await page.goto(loginRedirectUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(r => setTimeout(r, 4000));
    }

    const size = (await page.content()).length;
    logger.info(`[Puppeteer] Eindpagina: ${size} bytes`);

    if (size < 50000) throw new Error(`Pagina te klein (${size} bytes) — login mislukt.`);

    // Stap 4: Cookies ophalen en opslaan
    const cookies = await page.cookies(
      `https://${world}.grepolis.com`,
      portal,
      `https://${lang}0.grepolis.com`
    );

    const data = cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path, secure: c.secure, httpOnly: c.httpOnly,
      expirationDate: c.expires > 0 ? c.expires : undefined,
    }));

    fs.writeFileSync(COOKIES_FILE, JSON.stringify(data, null, 2));
    logger.info(`[Puppeteer] ✓ ${data.length} cookies opgeslagen`);
    return data;

  } finally {
    await browser.close();
  }
}

module.exports = { refreshCookies };
