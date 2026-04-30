const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar, Cookie } = require("tough-cookie");
const fs   = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const COOKIES_FILE = path.join(__dirname, "../../cookies.json");

class Session {
  constructor(config) {
    this.config    = config;
    this.jar       = new CookieJar();
    this.client    = this._makeClient();
    this.csrfToken = null;
    this.playerId  = config.account.player_id || null;
    this.world     = config.account.world;
    this.baseUrl   = `https://${this.world}.grepolis.com`;
    this.lastHtml  = null;
  }

  _makeClient() {
    return wrapper(axios.create({
      jar: this.jar, withCredentials: true,
      maxRedirects: 10, validateStatus: s => s < 500,
    }));
  }

  async login() {
    logger.info("[Sessie] Inloggen...");

    // Stap 1: Probeer bestaande cookies (snel, geen browser nodig)
    if (fs.existsSync(COOKIES_FILE)) {
      await this._loadCookies();
      if (await this._verify()) return;
      logger.warn("[Sessie] Cookies ongeldig — Puppeteer inloggen...");
    }

    // Stap 2: Puppeteer (altijd betrouwbaar)
    await this._puppeteerLogin();
    await this._loadCookies();
    if (await this._verify()) return;

    throw new Error("Login mislukt via cookies én Puppeteer.");
  }

  async _puppeteerLogin() {
    const { refreshCookies } = require("./cookie-refresher");
    await refreshCookies(this.config);
  }

  async _loadCookies() {
    this.jar    = new CookieJar();
    this.client = this._makeClient();
    const raw   = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"));
    for (const c of raw) {
      const domain = (c.domain ?? `${this.world}.grepolis.com`).replace(/^\./, "");
      try {
        await this.jar.setCookie(new Cookie({
          key: c.name, value: c.value, domain,
          path: c.path ?? "/", secure: c.secure ?? true,
          httpOnly: c.httpOnly ?? false,
          expires: c.expirationDate ? new Date(c.expirationDate * 1000) : "Infinity",
        }), `https://${domain}`);
      } catch (_) {}
    }
  }

  async _verify() {
    const res = await this.client.get(`${this.baseUrl}/game/${this.world}`, {
      headers: this._headers(),
    });
    // Echte gamepagina is altijd >200KB
    if (res.data.length < 200000) return false;
    this.lastHtml = res.data;
    this._extractCsrf(res.data);
    if (this.csrfToken) {
      logger.info(`[Sessie] ✓ Ingelogd | csrf: ${this.csrfToken.substring(0, 8)}...`);
      return true;
    }
    return false;
  }

  _extractCsrf(html) {
    const patterns = [
      /"csrfToken"\s*:\s*"([^"]{8,})"/,
      /"csrf_token"\s*:\s*"([^"]{8,})"/,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) { this.csrfToken = m[1]; return; }
    }
    if (!this.playerId) {
      const pid = html.match(/"player_id"\s*:\s*(\d+)/);
      if (pid) this.playerId = parseInt(pid[1]);
    }
  }

  _isSessionExpired(res) {
    const data = res.data;
    if (typeof data === "string" && data.length < 5000 && data.startsWith("<!")) return true;
    if (data?.error === "not_logged_in") return true;
    return false;
  }

  async gameGet(endpoint, townId, action, jsonPayload = null) {
    const params = new URLSearchParams({ town_id: townId, action, h: this.csrfToken, _: Date.now() });
    if (jsonPayload) params.set("json", jsonPayload);
    const res = await this.client.get(`${this.baseUrl}/game/${endpoint}?${params}`, {
      headers: { ...this._headers(), "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" },
    });
    if (this._isSessionExpired(res)) throw new Error("SESSION_EXPIRED");
    return res.data?.json ?? res.data;
  }

  async gamePost(endpoint, townId, action, jsonPayload = null) {
    const params   = new URLSearchParams({ town_id: townId, action, h: this.csrfToken });
    const formData = new URLSearchParams();
    if (jsonPayload) formData.set("json", jsonPayload);
    const res = await this.client.post(`${this.baseUrl}/game/${endpoint}?${params}`, formData.toString(), {
      headers: { ...this._headers(), "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" },
    });
    if (this._isSessionExpired(res)) throw new Error("SESSION_EXPIRED");
    return res.data?.json ?? res.data;
  }

  _getRandomUserAgent() {
    const agents = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    ];
    if (!this._userAgent) {
      this._userAgent = agents[Math.floor(Math.random() * agents.length)];
    }
    return this._userAgent;
  }

  _headers() {
    return {
      "User-Agent": this._getRandomUserAgent(),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.7",
      "Referer": `${this.baseUrl}/game/${this.world}`,
    };
  }
}

module.exports = Session;
