const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar, Cookie } = require("tough-cookie");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const COOKIES_FILE = path.join(__dirname, "../../cookies.json");

class Session {
  constructor(config) {
    this.config = config;
    this.jar = new CookieJar();
    this.client = wrapper(
      axios.create({
        jar: this.jar,
        withCredentials: true,
        maxRedirects: 10,
        validateStatus: (s) => s < 500,
      })
    );
    this.csrfToken = null;
    this.playerId = config.account.player_id || null;
    this.world = config.account.world;
    this.baseUrl = `https://${this.world}.grepolis.com`;
  }

  async login() {
    logger.info("Sessie opzetten via cookies...");

    if (!fs.existsSync(COOKIES_FILE)) {
      throw new Error("cookies.json niet gevonden! Zie README voor instructies.");
    }

    const raw = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"));
    logger.info(`${raw.length} cookies geladen uit cookies.json`);

    for (const c of raw) {
      const domain = (c.domain ?? `${this.world}.grepolis.com`).replace(/^\./, "");
      try {
        const cookie = new Cookie({
          key:      c.name,
          value:    c.value,
          domain:   domain,
          path:     c.path ?? "/",
          secure:   c.secure ?? true,
          httpOnly: c.httpOnly ?? false,
          expires:  c.expirationDate ? new Date(c.expirationDate * 1000) : "Infinity",
        });
        await this.jar.setCookie(cookie, `https://${domain}`);
      } catch (_) {}
    }

    // Laad de gamepagina — we zijn al ingelogd via cookies
    logger.info("Gamepagina laden...");
    const res = await this.client.get(`${this.baseUrl}/game/${this.world}`, {
      headers: this._headers(),
    });

    logger.info(`Status: ${res.status} | Grootte: ${res.data.length} bytes`);

    // Log een groot stuk zodat we exact zien hoe de token erin staat
    const chunk = res.data.substring(0, 4000);
    logger.info("=== BEGIN PAGINA ===\n" + chunk + "\n=== EINDE ===");

    // Zoek CSRF op alle bekende manieren
    this._extractAll(res.data);

    if (!this.csrfToken) {
      throw new Error("Geen CSRF-token gevonden. Bekijk de logs hierboven voor de paginainhoud.");
    }

    logger.info(`✓ Sessie OK | player_id: ${this.playerId} | csrf: ${this.csrfToken.substring(0,8)}...`);
  }

  _extractAll(html) {
    // Grepolis stopt speldata in een Game={...} object — token heet 'csrf_token' of 'csrfToken'
    const patterns = [
      // Game object patronen
      /['"](csrf_token|csrfToken)['"]\s*:\s*['"]([a-zA-Z0-9_\-]{8,})['"]/, // index 2
      /csrf_token\s*=\s*['"]([a-zA-Z0-9_\-]{8,})['"]/,                     // index 1
      /csrfToken\s*[:=]\s*['"]([a-zA-Z0-9_\-]{8,})['"]/,                   // index 1
      // "h" is de naam van de CSRF param in Grepolis API calls
      /['"](h)['"]\s*:\s*['"]([a-zA-Z0-9_\-]{8,})['"]/,                    // index 2
      // Meta tag
      /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/,     // index 1
    ];

    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) {
        // Sommige patronen hebben de waarde op index 1, andere op index 2
        const val = m[2] ?? m[1];
        if (val && val.length >= 8) {
          this.csrfToken = val;
          logger.info(`CSRF gevonden: patroon "${pat.source.substring(0,40)}..."`);
          return;
        }
      }
    }

    // player_id ophalen als fallback
    if (!this.playerId) {
      const pid = html.match(/['"](player_id)['"]\s*:\s*(\d+)/);
      if (pid) this.playerId = parseInt(pid[2]);
    }
  }

  async ajax(action, townId, extraData = {}) {
    if (!this.csrfToken) throw new Error("Geen actieve sessie.");
    const payload = new URLSearchParams({
      town_id: townId, action_name: action, ...extraData, h: this.csrfToken,
    });
    const res = await this.client.post(
      `${this.baseUrl}/game/${this.world}/frontend_bridge.php`,
      payload.toString(),
      { headers: { ...this._headers(), "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" } }
    );
    return res.data;
  }

  _headers() {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.7",
      "Referer": `${this.baseUrl}/game/${this.world}`,
    };
  }
}

module.exports = Session;
