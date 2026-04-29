const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar, Cookie } = require("tough-cookie");
const fs   = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const COOKIES_FILE  = path.join(__dirname, "../../cookies.json");
const REMEMBER_FILE = path.join(__dirname, "../../remember-token.json");

class Session {
  constructor(config) {
    this.config   = config;
    this.jar      = new CookieJar();
    this.client   = wrapper(axios.create({
      jar: this.jar, withCredentials: true,
      maxRedirects: 10, validateStatus: s => s < 500,
    }));
    this.csrfToken = null;
    this.playerId  = config.account.player_id || null;
    this.world     = config.account.world;
    this.baseUrl   = `https://${this.world}.grepolis.com`;
    this.lastHtml  = null;

    const lang = this.world.match(/^([a-z]+)/)?.[1] ?? "nl";
    this.portalUrl = `https://${lang}-play.grepolis.com`;
  }

  async login() {
    logger.info("Sessie opzetten...");

    // Stap 1: Probeer via remember-me token (snelst, geen cookies nodig)
    const rememberToken = this._loadRememberToken();
    if (rememberToken) {
      logger.info("Remember-me token gevonden, probeer automatisch in te loggen...");
      const ok = await this._loginWithRememberToken(rememberToken);
      if (ok) return;
      logger.warn("Remember-me login mislukt, val terug op cookies...");
    }

    // Stap 2: Probeer via cookies.json
    if (fs.existsSync(COOKIES_FILE)) {
      await this._loadCookies();
      const ok = await this._verifyAndExtract();
      if (ok) {
        this._saveRememberToken();
        return;
      }
      logger.warn("Cookies verlopen of ongeldig.");
    }

    // Stap 3: Automatisch inloggen via Puppeteer
    if (process.env.GREPO_EMAIL && process.env.GREPO_PASSWORD) {
      logger.info("Puppeteer automatisch inloggen starten...");
      try {
        const { refreshCookies } = require("./cookie-refresher");
        await refreshCookies(this.config);
        await this._loadCookies();
        const ok = await this._verifyAndExtract();
        if (ok) {
          this._saveRememberToken();
          logger.info("Automatische login via Puppeteer geslaagd!");
          return;
        }
      } catch (err) {
        logger.warn(`Puppeteer login mislukt: ${err.message}`);
      }
    }

    throw new Error(
      "Kan niet inloggen via cookies, token of Puppeteer. " +
      "Exporteer cookies handmatig via Cookie-Editor en update de GREPO_COOKIES secret."
    );
  }

  // Login via nl-interop-rememberme token
  async _loginWithRememberToken(token) {
    try {
      this.jar    = new CookieJar();
      this.client = wrapper(axios.create({
        jar: this.jar, withCredentials: true,
        maxRedirects: 10, validateStatus: s => s < 500,
      }));

      // Zet de remember-me cookie
      const domain = "grepolis.com";
      await this.jar.setCookie(new Cookie({
        key: "nl-interop-rememberme", value: token,
        domain, path: "/", secure: true, httpOnly: true,
      }), `https://${domain}`);

      // Laad de portaal-pagina — de remember-me cookie triggert auto-login
      const portalRes = await this.client.get(`${this.portalUrl}/`, {
        headers: this._headers(this.portalUrl),
      });

      // Navigeer naar de game — dit zet de sid cookie
      const gameRes = await this.client.get(
        `${this.baseUrl}/game/${this.world}`,
        { headers: this._headers(this.portalUrl) }
      );

      logger.info(`Game pagina: ${gameRes.status} | ${gameRes.data.length} bytes`);

      // Debug: welke cookies hebben we na remember-me poging?
      const gc = await this.jar.getCookies(this.baseUrl);
      const pc = await this.jar.getCookies(this.portalUrl);
      logger.info(`Game cookies: ${gc.map(c => c.key).join(", ") || "geen"}`);
      logger.info(`Portal cookies: ${pc.map(c => c.key).join(", ") || "geen"}`);

      // Pagina moet >50KB zijn om echt ingelogd te zijn
      if (gameRes.data.length < 50000) {
        logger.warn(`Game pagina te klein (${gameRes.data.length} bytes) — remember-me mislukt`);
        return false;
      }

      this.lastHtml = gameRes.data;
      this._extractCsrf(gameRes.data);

      if (this.csrfToken) {
        logger.info("✓ Remember-me login geslaagd!");
        this._saveRememberToken();
        return true;
      }
      return false;
    } catch (err) {
      logger.warn(`Remember-me login fout: ${err.message}`);
      return false;
    }
  }

  _loadRememberToken() {
    // Prioriteit: environment variable → bestand
    if (process.env.GREPO_REMEMBER_TOKEN) {
      return process.env.GREPO_REMEMBER_TOKEN;
    }
    if (fs.existsSync(REMEMBER_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(REMEMBER_FILE, "utf8"));
        return data.token ?? null;
      } catch (_) {}
    }
    return null;
  }

  _saveRememberToken() {
    // Haal de remember-me token uit de huidige cookie jar
    this.jar.getCookiesSync("https://grepolis.com").forEach(c => {
      if (c.key === "nl-interop-rememberme") {
        try {
          fs.writeFileSync(REMEMBER_FILE, JSON.stringify({ token: c.value, saved: new Date().toISOString() }));
          logger.info("Remember-me token opgeslagen.");
        } catch (_) {}
      }
    });
  }

  async _loadCookies() {
    this.jar    = new CookieJar();
    this.client = wrapper(axios.create({
      jar: this.jar, withCredentials: true,
      maxRedirects: 10, validateStatus: s => s < 500,
    }));

    const raw = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"));
    logger.info(`${raw.length} cookies geladen uit cookies.json`);

    // Log vervaldatum van kritieke cookies
    const now = Date.now() / 1000;
    for (const c of raw) {
      if (["sid", "nl-interop-rememberme"].includes(c.name)) {
        if (c.expirationDate) {
          const daysLeft = Math.round((c.expirationDate - now) / 86400);
          logger.info(`Cookie '${c.name}': verloopt over ${daysLeft} dagen`);
        } else if (c.session) {
          logger.warn(`Cookie '${c.name}': SESSION cookie — verloopt bij afsluiten browser!`);
        }
      }
    }

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

  async _verifyAndExtract() {
    logger.info("Gamepagina laden...");
    const res = await this.client.get(`${this.baseUrl}/game/${this.world}`, {
      headers: this._headers(this.portalUrl),
    });
    logger.info(`Status: ${res.status} | Grootte: ${res.data.length} bytes`);
    this.lastHtml = res.data;
    this._extractCsrf(res.data);
    if (this.csrfToken) {
      logger.info(`✓ Sessie OK | player_id: ${this.playerId} | csrf: ${this.csrfToken.substring(0, 8)}...`);
      return true;
    }
    return false;
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
      if (m) { this.csrfToken = m[1]; logger.info("CSRF gevonden."); return; }
    }
    if (!this.playerId) {
      const pid = html.match(/"player_id"\s*:\s*(\d+)/);
      if (pid) this.playerId = parseInt(pid[1]);
    }
  }

  // Controleer of een response aangeeft dat de sessie verlopen is
  _isSessionExpired(res) {
    const data = res.data;
    const url  = res.request?.res?.responseUrl ?? "";
    if (url.includes("login=1") || url.includes("nosession")) return true;
    if (typeof data === "string" && data.length < 10000 && data.includes("login")) return true;
    if (data?.error === "not_logged_in" || data?.error === "session_expired") return true;
    // Detecteer ook kleine HTML-responses die geen JSON zijn (= redirect naar login)
    if (typeof data === "string" && data.length < 5000 && data.startsWith("<!")) return true;
    return false;
  }

  // Vernieuw de CSRF token door de gamepagina opnieuw te laden
  async refreshCsrf() {
    logger.info("CSRF token vernieuwen...");
    const res = await this.client.get(`${this.baseUrl}/game/${this.world}`, {
      headers: this._headers(this.baseUrl),
    });
    this.lastHtml = res.data;
    this._extractCsrf(res.data);
    if (this.csrfToken) {
      logger.info(`CSRF vernieuwd: ${this.csrfToken.substring(0, 8)}...`);
      return true;
    }
    return false;
  }

  async gameGet(endpoint, townId, action, jsonPayload = null) {
    const params = new URLSearchParams({ town_id: townId, action, h: this.csrfToken, _: Date.now() });
    if (jsonPayload) params.set("json", jsonPayload);
    const res = await this.client.get(`${this.baseUrl}/game/${endpoint}?${params}`, {
      headers: { ...this._headers(this.baseUrl), "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" },
    });
    if (this._isSessionExpired(res)) throw new Error("SESSION_EXPIRED");
    return res.data?.json ?? res.data;
  }

  async gamePost(endpoint, townId, action, jsonPayload = null) {
    const params   = new URLSearchParams({ town_id: townId, action, h: this.csrfToken });
    const formData = new URLSearchParams();
    if (jsonPayload) formData.set("json", jsonPayload);
    const res = await this.client.post(`${this.baseUrl}/game/${endpoint}?${params}`, formData.toString(), {
      headers: { ...this._headers(this.baseUrl), "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest", Accept: "application/json, */*" },
    });
    if (this._isSessionExpired(res)) throw new Error("SESSION_EXPIRED");
    return res.data?.json ?? res.data;
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
