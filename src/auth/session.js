const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar, Cookie } = require("tough-cookie");
const fs   = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const COOKIES_FILE = path.join(__dirname, "../../cookies.json");

class Session {
  constructor(config) {
    this.config   = config;
    this.jar      = new CookieJar();
    this.client   = wrapper(axios.create({ jar: this.jar, withCredentials: true, maxRedirects: 10, validateStatus: s => s < 500 }));
    this.csrfToken = null;
    this.playerId  = config.account.player_id || null;
    this.world     = config.account.world;
    this.baseUrl   = `https://${this.world}.grepolis.com`;
    this.lastHtml  = null;
  }

  async login() {
    logger.info("Sessie opzetten via cookies...");

    // Als geen cookies.json: probeer automatisch in te loggen via Puppeteer
    if (!fs.existsSync(COOKIES_FILE)) {
      logger.info("Geen cookies.json gevonden, probeer automatisch in te loggen...");
      await this._autoLogin();
    }

    await this._loadCookies();

    logger.info("Gamepagina laden...");
    const res = await this.client.get(`${this.baseUrl}/game/${this.world}`, { headers: this._headers() });
    logger.info(`Status: ${res.status} | Grootte: ${res.data.length} bytes`);
    this.lastHtml = res.data;

    this._extractCsrf(res.data);

    // Als CSRF nog steeds niet gevonden: cookies verlopen → probeer opnieuw in te loggen
    if (!this.csrfToken) {
      logger.warn("CSRF niet gevonden, cookies mogelijk verlopen. Probeer opnieuw in te loggen...");
      await this._autoLogin();
      await this._loadCookies();

      const res2 = await this.client.get(`${this.baseUrl}/game/${this.world}`, { headers: this._headers() });
      this.lastHtml = res2.data;
      this._extractCsrf(res2.data);
    }

    if (!this.csrfToken) {
      throw new Error("Geen CSRF-token gevonden. Cookies mogelijk verlopen — exporteer opnieuw.");
    }

    logger.info(`✓ Sessie OK | player_id: ${this.playerId} | csrf: ${this.csrfToken.substring(0, 8)}...`);
  }

  async _autoLogin() {
    try {
      const { refreshCookies } = require("./cookie-refresher");
      await refreshCookies(this.config);
    } catch (err) {
      logger.warn(`[AutoLogin] Automatisch inloggen mislukt: ${err.message}`);
      logger.warn("[AutoLogin] Puppeteer mogelijk niet beschikbaar. Exporteer cookies handmatig.");
      throw new Error("Geen CSRF-token gevonden. Cookies mogelijk verlopen — exporteer opnieuw.");
    }
  }

  async _loadCookies() {
    // Reset jar
    this.jar = new CookieJar();
    this.client = wrapper(axios.create({ jar: this.jar, withCredentials: true, maxRedirects: 10, validateStatus: s => s < 500 }));

    const raw = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"));
    logger.info(`${raw.length} cookies geladen uit cookies.json`);

    for (const c of raw) {
      const domain = (c.domain ?? `${this.world}.grepolis.com`).replace(/^\./, "");
      try {
        const cookie = new Cookie({
          key: c.name, value: c.value, domain, path: c.path ?? "/",
          secure: c.secure ?? true, httpOnly: c.httpOnly ?? false,
          expires: c.expirationDate ? new Date(c.expirationDate * 1000) : "Infinity",
        });
        await this.jar.setCookie(cookie, `https://${domain}`);
      } catch (_) {}
    }
  }

  _extractCsrf(html) {
    const patterns = [
      /"csrfToken"\s*:\s*"([^"]{8,})"/,
      /"csrf_token"\s*:\s*"([^"]{8,})"/,
      /csrf_token\s*=\s*"([^"]{8,})"/,
      /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) { this.csrfToken = m[1]; logger.info(`CSRF gevonden.`); return; }
    }
    if (!this.playerId) {
      const pid = html.match(/"player_id"\s*:\s*(\d+)/);
      if (pid) this.playerId = parseInt(pid[1]);
    }
  }

  async gameGet(endpoint, townId, action, jsonPayload = null) {
    const params = new URLSearchParams({ town_id: townId, action, h: this.csrfToken, _: Date.now() });
    if (jsonPayload) params.set("json", jsonPayload);
    const res = await this.client.get(`${this.baseUrl}/game/${endpoint}?${params}`, {
      headers: { ...this._headers(), "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" },
    });
    return res.data?.json ?? res.data;
  }

  async gamePost(endpoint, townId, action, jsonPayload = null) {
    const params   = new URLSearchParams({ town_id: townId, action, h: this.csrfToken });
    const formData = new URLSearchParams();
    if (jsonPayload) formData.set("json", jsonPayload);
    const res = await this.client.post(`${this.baseUrl}/game/${endpoint}?${params}`, formData.toString(), {
      headers: { ...this._headers(), "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" },
    });
    return res.data?.json ?? res.data;
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
