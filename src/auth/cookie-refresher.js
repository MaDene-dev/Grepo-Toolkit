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

    // Onderschep ELKE navigatie naar het speldomein (niet enkel login=1)
    let loginRedirectUrl = null;
    page.on("request", req => {
      const url = req.url();
      if (url.includes(`${world}.grepolis.com`) && url.includes("/game/")) {
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

    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, a.button"))
        .find(b => ["inloggen","login"].includes(b.textContent?.trim().toLowerCase()));
      if (btn) btn.click();
    });
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 3000));

    // Stap 2: Spelwereld betreden — loop omdat Grepolis soms een bevestigingspagina toont
    // (bv. select_new_world wanneer er al een actieve sessie is)
    await page.goto(index, { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    for (let attempt = 1; attempt <= 3; attempt++) {
      const currentUrl = page.url();
      if (currentUrl.includes(`${world}.grepolis.com`) && currentUrl.includes("/game/")) break;

      logger.info(`[Puppeteer] Wereld-inlog poging ${attempt}: ${currentUrl}`);

      // Probeer form op huidige pagina:
      // Volgorde: login_to_game_world → select_new_world → eerste beschikbare form
      const formSubmitted = await page.evaluate((w) => {
        const form =
          document.querySelector("form[action*=\"login_to_game_world\"]") ||
          document.querySelector("form[action*=\"select_new_world\"]") ||
          document.querySelector("form");
        if (!form) return false;
        let inp = form.querySelector("input[name=\"world\"]");
        if (!inp) {
          inp = document.createElement("input");
          inp.type = "hidden"; inp.name = "world";
          form.appendChild(inp);
        }
        inp.value = w;
        form.submit();
        return true;
      }, world);

      if (formSubmitted) {
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // Geen form: gebruik captured URL of directe navigatie
      if (loginRedirectUrl) {
        logger.info(`[Puppeteer] Geen form — gebruik redirect URL: ${loginRedirectUrl}`);
        await page.goto(loginRedirectUrl, { waitUntil: "networkidle2", timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
      } else {
        logger.warn("[Puppeteer] Geen form en geen redirect URL — directe navigatie");
        await page.goto(`https://${world}.grepolis.com/game/index`, { waitUntil: "networkidle2", timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    const finalContent = await page.content();
    const size = finalContent.length;
    logger.info(`[Puppeteer] Eindpagina: ${size} bytes | URL: ${page.url()}`);
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
