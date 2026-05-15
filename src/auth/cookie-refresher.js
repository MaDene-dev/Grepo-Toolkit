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

    const formFound = await page.evaluate((world) => {
      const form = document.querySelector('form[action*="login_to_game_world"]');
      if (!form) return false;
      let input = form.querySelector('input[name="world"]');
      if (!input) {
        input = document.createElement("input");
        input.type = "hidden"; input.name = "world";
        form.appendChild(input);
      }
      input.value = world;
      form.submit();
      return true;
    }, world);

    if (!formFound) {
      logger.warn("[Puppeteer] Wereldkeuze-form niet gevonden op nl0 pagina — directe navigatie");
    } else {
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 4000));
    }

    // Stap 3: Navigeer naar login-redirect indien onderschept
    if (loginRedirectUrl && !page.url().includes(`${world}.grepolis.com`)) {
      logger.info("[Puppeteer] Redirect URL gevonden — navigeer daarheen");
      await page.goto(loginRedirectUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(r => setTimeout(r, 4000));
    }

    // Stap 4: Directe navigatie als fallback (beide vorige paden mislukten)
    if (!page.url().includes(`${world}.grepolis.com`)) {
      logger.warn("[Puppeteer] Nog niet op game-domein — directe navigatie naar game world");
      const gameUrl = `https://${world}.grepolis.com/game/index`;
      await page.goto(gameUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(r => setTimeout(r, 4000));
    }

    // Stap 5: Herdetecteer login via loginRedirectUrl als we op game-domein zijn maar niet in game
    if (page.url().includes(`${world}.grepolis.com`) &&
        !page.url().includes("/game/") && loginRedirectUrl) {
      await page.goto(loginRedirectUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(r => setTimeout(r, 4000));
    }

    logger.info(`[Puppeteer] Eindpagina: ${(await page.content()).length} bytes | URL: ${page.url()}`);

    const finalContent = await page.content();
    const size = finalContent.length;
    if (size < 50000) throw new Error(`Pagina te klein (${size} bytes) — mogelijk CAPTCHA of verificatiepagina.`);

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

    // Minder dan 12 cookies = waarschijnlijk geen volledige game-sessie
    if (data.length < 12) {
      throw new Error(`Te weinig cookies (${data.length}) — mogelijk CAPTCHA of verificatie vereist. Log manueel in op grepolis.com.`);
    }

    fs.writeFileSync(COOKIES_FILE, JSON.stringify(data, null, 2));
    logger.info(`[Puppeteer] ✓ ${data.length} cookies opgeslagen`);

    // Update GREPO_COOKIES GitHub Secret zodat volgende run geen Puppeteer nodig heeft
    if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
      try {
        await _updateGitHubSecret(JSON.stringify(data));
        logger.info("[Puppeteer] ✓ GREPO_COOKIES secret bijgewerkt");
      } catch (e) {
        logger.warn(`[Puppeteer] Secret bijwerken mislukt: ${e.message}`);
      }
    }

    return data;

  } finally {
    await browser.close();
  }
}

module.exports = { refreshCookies };

async function _updateGitHubSecret(cookieJson) {
  const https  = require("https");
  const crypto = require("crypto");
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const token  = process.env.GITHUB_TOKEN;

  // Stap 1: haal public key op
  const pubKeyData = await _ghRequest("GET",
    `/repos/${owner}/${repo}/actions/secrets/public-key`, null, token);

  // Stap 2: encrypt met libsodium-wrappers
  const sodium = require("libsodium-wrappers");
  await sodium.ready;
  const key       = sodium.from_base64(pubKeyData.key, sodium.base64_variants.ORIGINAL);
  const msg       = sodium.from_string(cookieJson);
  const encrypted = sodium.crypto_box_seal(msg, key);
  const b64       = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);

  // Stap 3: update secret
  await _ghRequest("PUT",
    `/repos/${owner}/${repo}/actions/secrets/GREPO_COOKIES`,
    { encrypted_value: b64, key_id: pubKeyData.key_id }, token);
}

function _ghRequest(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.github.com",
      path, method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": "grepo-toolkit",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
      },
    };
    const req = require("https").request(opts, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`GitHub API ${res.statusCode}: ${data}`));
        resolve(data ? JSON.parse(data) : {});
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
