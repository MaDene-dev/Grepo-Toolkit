const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const logger = require("../utils/logger");

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
    this.playerId = null;
    this.world = config.account.world;
    this.baseUrl = `https://${this.world}.grepolis.com`;

    const langPrefix = this.world.match(/^([a-z]+)/)?.[1] ?? "en";
    this.portal = config.account.portal || `https://${langPrefix}-play.grepolis.com`;
    logger.info(`Login-portaal: ${this.portal}`);
  }

  async login() {
    logger.info("Inloggen bij Grepolis...");

    // Stap 1: Startpagina laden
    const startPage = await this.client.get(`${this.portal}/`, {
      headers: this._headers(`${this.portal}/`),
    });

    const tokenMatch = startPage.data.match(/authenticity_token[^>]+value="([^"]+)"/);
    const authToken = tokenMatch ? tokenMatch[1] : "";
    logger.info(`Authenticity token: ${authToken ? "gevonden" : "niet gevonden"}`);

    // Stap 2: Inloggen
    const formData = new URLSearchParams({
      "user[login]":      this.config.account.username,
      "user[password]":   this.config.account.password,
      "user[uni_url]":    this.world,
      authenticity_token: authToken,
      commit: "Aanmelden",
    });

    await this.client.post(`${this.portal}/login`, formData.toString(), {
      headers: {
        ...this._headers(`${this.portal}/`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    // Stap 3: Game-sessiedata ophalen via de JSON bootstrap API
    // Grepolis laadt speldata via deze endpoint na de SPA-init
    const bootstrapRes = await this.client.get(
      `${this.baseUrl}/game/${this.world}`,
      { headers: { ...this._headers(`${this.portal}/`), Accept: "application/json, text/javascript, */*" } }
    );

    // Probeer CDATA / inline script blok te vinden (Game = {...})
    const cdataMatch = bootstrapRes.data.match(/\/\*\s*<!\[CDATA\[[\s\S]*?\/\*\s*\]\]>/);
    const scriptContent = cdataMatch ? cdataMatch[0] : bootstrapRes.data;

    // Zoek player_id op meerdere manieren
    const pidPatterns = [
      /["']?player_id["']?\s*[:=]\s*(\d+)/,
      /"player_id"\s*:\s*(\d+)/,
      /player_id=(\d+)/,
    ];
    for (const pat of pidPatterns) {
      const m = scriptContent.match(pat) || bootstrapRes.data.match(pat);
      if (m) { this.playerId = parseInt(m[1]); break; }
    }

    // Zoek csrf_token op meerdere manieren
    const csrfPatterns = [
      /["']?csrf_token["']?\s*[:=]\s*["']([a-f0-9]{20,})["']/,
      /"csrf_token"\s*:\s*"([a-f0-9]{20,})"/,
    ];
    for (const pat of csrfPatterns) {
      const m = scriptContent.match(pat) || bootstrapRes.data.match(pat);
      if (m) { this.csrfToken = m[1]; break; }
    }

    // Als CSRF nog steeds niet gevonden: probeer meta-tag
    if (!this.csrfToken) {
      const metaMatch = bootstrapRes.data.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/);
      if (metaMatch) this.csrfToken = metaMatch[1];
    }

    // Als player_id nog niet gevonden: haal het uit de URL die we van Grepolis kregen
    if (!this.playerId && this.config.account.player_id) {
      this.playerId = this.config.account.player_id;
      logger.info(`player_id uit config gebruikt: ${this.playerId}`);
    }

    // Als CSRF token nog steeds ontbreekt, probeer via directe API-call
    if (!this.csrfToken) {
      logger.info("CSRF niet in HTML gevonden, probeer API bootstrap...");
      await this._fetchCsrfViaApi();
    }

    logger.info(`player_id: ${this.playerId ?? "niet gevonden"}`);
    logger.info(`csrf_token: ${this.csrfToken ? "gevonden" : "niet gevonden"}`);

    if (!this.csrfToken) {
      logger.error("Eerste 1500 tekens response:\n" + bootstrapRes.data.substring(0, 1500));
      throw new Error("Geen CSRF-token gevonden. Zie logs voor details.");
    }

    logger.info(`Sessie OK — world: ${this.world}`);
  }

  // Probeer CSRF via een bekende lichtgewicht API endpoint
  async _fetchCsrfViaApi() {
    const endpoints = [
      `/game/${this.world}/index+Ajax+bootstrapData.json`,
      `/game/${this.world}/index+Us+Game.json`,
    ];
    for (const ep of endpoints) {
      try {
        const res = await this.client.get(`${this.baseUrl}${ep}`, {
          headers: { ...this._headers(`${this.baseUrl}/game/${this.world}`), "X-Requested-With": "XMLHttpRequest" },
        });
        const csrfMatch = JSON.stringify(res.data).match(/"csrf_token"\s*:\s*"([a-f0-9]{20,})"/);
        if (csrfMatch) { this.csrfToken = csrfMatch[1]; logger.info(`CSRF gevonden via ${ep}`); return; }
        const pidMatch = JSON.stringify(res.data).match(/"player_id"\s*:\s*(\d+)/);
        if (pidMatch && !this.playerId) this.playerId = parseInt(pidMatch[1]);
      } catch (_) {}
    }
  }

  async ajax(action, townId, extraData = {}) {
    if (!this.csrfToken) throw new Error("Geen actieve sessie.");

    const payload = new URLSearchParams({
      town_id:     townId,
      action_name: action,
      ...extraData,
      h: this.csrfToken,
    });

    const res = await this.client.post(
      `${this.baseUrl}/game/${this.world}/frontend_bridge.php`,
      payload.toString(),
      {
        headers: {
          ...this._headers(`${this.baseUrl}/game/${this.world}`),
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
        },
      }
    );

    return res.data;
  }

  _headers(referer) {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.7",
      "Referer": referer,
    };
  }
}

module.exports = Session;
