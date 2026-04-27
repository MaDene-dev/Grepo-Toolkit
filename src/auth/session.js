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
    this.playerId = config.account.player_id || null;
    this.world = config.account.world;
    this.baseUrl = `https://${this.world}.grepolis.com`;

    const langPrefix = this.world.match(/^([a-z]+)/)?.[1] ?? "en";
    this.portal = `https://${langPrefix}-play.grepolis.com`;
    logger.info(`Portal: ${this.portal}`);
  }

  async login() {
    logger.info("Inloggen bij Grepolis (SPA/JSON mode)...");

    // Stap 1: Probeer JSON API login (moderne InnoGames ONELPS aanpak)
    const loginEndpoints = [
      { url: `${this.portal}/api/v1/users/sign_in`,  body: { user: { login: this.config.account.username, password: this.config.account.password, uni_url: this.world } } },
      { url: `${this.portal}/api/users/sign_in`,     body: { user: { login: this.config.account.username, password: this.config.account.password, uni_url: this.world } } },
      { url: `${this.portal}/users/sign_in.json`,    body: { user: { login: this.config.account.username, password: this.config.account.password, uni_url: this.world } } },
    ];

    let loggedIn = false;
    for (const ep of loginEndpoints) {
      try {
        logger.info(`Login proberen via: ${ep.url}`);
        const res = await this.client.post(ep.url, ep.body, {
          headers: {
            ...this._headers(this.portal),
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
        });
        logger.info(`Status: ${res.status} | Response: ${JSON.stringify(res.data).substring(0, 200)}`);

        if (res.status === 200 || res.status === 201) {
          // Haal token op uit response als die er in zit
          if (res.data?.auth_token) this.csrfToken = res.data.auth_token;
          if (res.data?.csrf_token) this.csrfToken = res.data.csrf_token;
          if (res.data?.token)      this.csrfToken = res.data.token;
          loggedIn = true;
          logger.info(`Login gelukt via ${ep.url}`);
          break;
        }
      } catch (err) {
        logger.warn(`${ep.url} → ${err.message}`);
      }
    }

    // Stap 2: Navigeer naar de game-wereld om game-cookies te krijgen
    logger.info("Navigeren naar game-wereld...");
    const worldUrls = [
      `${this.portal}/play/${this.world}`,
      `${this.baseUrl}/game/${this.world}`,
    ];
    for (const url of worldUrls) {
      try {
        const res = await this.client.get(url, { headers: this._headers(this.portal) });
        logger.info(`GET ${url} → status ${res.status}, size ${res.data.length}`);
        this._tryExtractCsrf(res.data);
        if (this.csrfToken) break;
      } catch (err) {
        logger.warn(`${url} → ${err.message}`);
      }
    }

    // Stap 3: Log alle cookies zodat we kunnen debuggen
    const cookies = await this.jar.getCookies(this.baseUrl);
    logger.info(`Cookies op ${this.baseUrl}: ${cookies.map(c => c.key).join(", ") || "geen"}`);

    const portalCookies = await this.jar.getCookies(this.portal);
    logger.info(`Cookies op portal: ${portalCookies.map(c => c.key).join(", ") || "geen"}`);

    // Stap 4: Probeer CSRF via directe game API endpoints
    if (!this.csrfToken) {
      await this._tryGameApiEndpoints();
    }

    logger.info(`player_id: ${this.playerId ?? "onbekend"}`);
    logger.info(`csrf_token: ${this.csrfToken ? "gevonden ✓" : "niet gevonden ✗"}`);

    if (!this.csrfToken) {
      throw new Error("Kon geen CSRF-token ophalen. Zie logs hierboven voor details.");
    }

    logger.info("Sessie succesvol opgezet.");
  }

  async _tryGameApiEndpoints() {
    const endpoints = [
      `/game/${this.world}/index+Ajax+bootstrapData.json`,
      `/game/${this.world}/index+Us+Game.json`,
      `/game/${this.world}?format=json`,
    ];
    for (const ep of endpoints) {
      try {
        const res = await this.client.get(`${this.baseUrl}${ep}`, {
          headers: { ...this._headers(`${this.baseUrl}/game/${this.world}`), "X-Requested-With": "XMLHttpRequest", Accept: "application/json" },
        });
        logger.info(`API ${ep} → status ${res.status}`);
        const raw = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
        this._tryExtractCsrf(raw);
        const pidMatch = raw.match(/"player_id"\s*:\s*(\d+)/);
        if (pidMatch && !this.playerId) this.playerId = parseInt(pidMatch[1]);
        if (this.csrfToken) { logger.info(`CSRF gevonden via ${ep}`); return; }
      } catch (err) {
        logger.warn(`${ep} → ${err.message}`);
      }
    }
  }

  _tryExtractCsrf(html) {
    const patterns = [
      /["']csrf_token["']\s*[:=]\s*["']([a-f0-9]{20,})["']/,
      /"csrf_token"\s*:\s*"([a-f0-9]{20,})"/,
      /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/,
      /csrf_token\s*=\s*"([a-f0-9]{20,})"/,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) { this.csrfToken = m[1]; return; }
    }
  }

  async ajax(action, townId, extraData = {}) {
    if (!this.csrfToken) throw new Error("Geen actieve sessie.");
    const payload = new URLSearchParams({ town_id: townId, action_name: action, ...extraData, h: this.csrfToken });
    const res = await this.client.post(
      `${this.baseUrl}/game/${this.world}/frontend_bridge.php`,
      payload.toString(),
      { headers: { ...this._headers(`${this.baseUrl}/game/${this.world}`), "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" } }
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
