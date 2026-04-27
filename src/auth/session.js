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
      throw new Error(
        "cookies.json niet gevonden! Exporteer je cookies via de Cookie-Editor extensie " +
        "en plaats het bestand naast config.json. Zie README voor instructies."
      );
    }

    // Laad cookies uit het bestand
    const raw = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"));
    logger.info(`${raw.length} cookies geladen uit cookies.json`);

    for (const c of raw) {
      // Cookie-Editor exporteert naar dit formaat, we zetten het om naar tough-cookie
      const domain = c.domain?.startsWith(".") ? c.domain : `.${c.domain ?? this.world + ".grepolis.com"}`;
      try {
        const cookie = new Cookie({
          key:      c.name,
          value:    c.value,
          domain:   domain.replace(/^\./, ""),
          path:     c.path ?? "/",
          secure:   c.secure ?? true,
          httpOnly: c.httpOnly ?? false,
          expires:  c.expirationDate ? new Date(c.expirationDate * 1000) : "Infinity",
        });
        await this.jar.setCookie(cookie, `https://${domain.replace(/^\./, "")}`);
      } catch (_) {}
    }

    // Verifieer de sessie door de gamepagina te laden
    logger.info("Sessie verifiëren...");
    const res = await this.client.get(`${this.baseUrl}/game/${this.world}`, {
      headers: this._headers(),
    });

    logger.info(`Game pagina status: ${res.status}, grootte: ${res.data.length} bytes`);

    // Haal CSRF-token op — zit in de CDATA van de game pagina of in een cookie
    this._extractCsrf(res.data);

    // Probeer ook uit cookies
    if (!this.csrfToken) {
      const cookies = await this.jar.getCookies(this.baseUrl);
      logger.info(`Game cookies: ${cookies.map(c => c.key).join(", ")}`);
      const csrfCookie = cookies.find(c =>
        c.key.toLowerCase().includes("csrf") ||
        c.key.toLowerCase().includes("token") ||
        c.key.toLowerCase().includes("authenticity")
      );
      if (csrfCookie) {
        this.csrfToken = csrfCookie.value;
        logger.info(`CSRF uit cookie: ${csrfCookie.key}`);
      }
    }

    // Probeer via een lichte AJAX-call de game data op te halen
    if (!this.csrfToken) {
      await this._fetchCsrfViaAjax();
    }

    if (!this.csrfToken) {
      // Log de eerste 2000 tekens voor diagnose
      logger.error("Pagina-inhoud (eerste 2000 tekens):\n" + res.data.substring(0, 2000));
      throw new Error(
        "Kon geen CSRF-token vinden. Mogelijk zijn je cookies verlopen — exporteer ze opnieuw."
      );
    }

    logger.info(`✓ Sessie OK | player_id: ${this.playerId} | csrf: gevonden`);
  }

  _extractCsrf(html) {
    const patterns = [
      /["']csrf_token["']\s*[:=]\s*["']([a-zA-Z0-9_\-]{10,})["']/,
      /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/,
      /csrf_token\s*=\s*"([a-zA-Z0-9_\-]{10,})"/,
      /"h"\s*:\s*"([a-zA-Z0-9_\-]{10,})"/,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) { this.csrfToken = m[1]; logger.info(`CSRF gevonden via regex`); return; }
    }

    // Zoek ook player_id als we die nog niet hebben
    if (!this.playerId) {
      const pidMatch = html.match(/["']?player_id["']?\s*[:=]\s*(\d+)/);
      if (pidMatch) this.playerId = parseInt(pidMatch[1]);
    }
  }

  async _fetchCsrfViaAjax() {
    // Grepolis game data wordt opgehaald via deze endpoint
    const endpoints = [
      `/game/${this.world}/index+Ajax+bootstrapData.json`,
      `/game/${this.world}/index+Us+GrepolisData.json`,
      `/game/${this.world}/index+Us+Game.json`,
    ];
    for (const ep of endpoints) {
      try {
        const res = await this.client.get(`${this.baseUrl}${ep}`, {
          headers: { ...this._headers(), "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
        });
        if (res.status === 200) {
          const raw = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
          logger.info(`${ep} → ${raw.substring(0, 150)}`);
          this._extractCsrf(raw);
          if (this.csrfToken) return;
        }
      } catch (err) {
        logger.warn(`${ep}: ${err.message}`);
      }
    }
  }

  async ajax(action, townId, extraData = {}) {
    if (!this.csrfToken) throw new Error("Geen actieve sessie.");
    const payload = new URLSearchParams({ town_id: townId, action_name: action, ...extraData, h: this.csrfToken });
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
