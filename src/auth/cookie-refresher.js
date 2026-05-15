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

    // Vang de login-redirect op (nl133?login=1 — essentieel voor game session)
    let loginRedirectUrl = null;
    page.on("request", req => {
      if (req.resourceType() !== "document") return;
      const url = req.url();
      if (url.includes(`${world}.grepolis.com`) && url.includes("login=1")) {
        loginRedirectUrl = url;
        logger.info(`[Puppeteer] Login-redirect gevangen: ${url}`);
      }
    });

    // Stap 1: Portaal laden en inloggen (originele werkende selectors)
    await page.goto(portal, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector("input[type='email'], input[name='login'], input[type='text']", { timeout: 15000 });

    const emailField = await page.$("input[type='email']")
                    ?? await page.$("input[name='login']")
                    ?? await page.$("input[type='text']");
    await emailField.click({ clickCount: 3 });
    await emailField.type(username, { delay: 60 });

    const passField = await page.$("input[type='password']");
    await passField.click();
    await passField.type(password, { delay: 60 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
      passField.press("Enter"),
    ]);
    await new Promise(r => setTimeout(r, 3000));

    // Stap 2: Als loginRedirectUrl gevangen → gebruik die (optimaal pad)
    if (loginRedirectUrl) {
      logger.info(`[Puppeteer] Navigeren via login-redirect...`);
      await page.goto(loginRedirectUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
    } else {
      // Stap 2b: Navigeer direct naar game (fallback)
      const gameUrl = `https://${world}.grepolis.com/game/${world}`;
      logger.info(`[Puppeteer] Geen redirect gevangen — direct navigeren: ${gameUrl}`);
      await page.goto(gameUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await new Promise(r => setTimeout(r, 4000));

      // Als pagina te klein: zoek wereld-link of gooi veilige fout
      const midSize = (await page.content()).length;
      logger.info(`[Puppeteer] Pagina: ${midSize} bytes | URL: ${page.url()}`);
      if (midSize < 50000) {
        if (page.url().includes("select_new_world") || page.url().includes("choose_direction")) {
          throw new Error(`Actieve gebruikerssessie gedetecteerd. Log eerst uit op grepolis.com.`);
        }
        const worldLink = await page.$(`a[href*="${world}"]`);
        if (worldLink) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
            worldLink.click(),
          ]);
          await new Promise(r => setTimeout(r, 4000));
        }
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
