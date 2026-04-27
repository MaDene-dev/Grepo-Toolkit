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
  }

  async login() {
    logger.info("Inloggen bij Grepolis...");

    // Stap 1: Laad de startpagina om sessie-cookies op te pakken
    const startPage = await this.client.get("https://www.grepolis.com/start", {
      headers: this._headers("https://www.grepolis.com/"),
    });

    // Haal de authenticity_token op uit het login-formulier
    const tokenMatch = startPage.data.match(/authenticity_token[^>]+value="([^"]+)"/);
    const authToken = tokenMatch ? tokenMatch[1] : "";

    // Stap 2: POST het login-formulier
    const formData = new URLSearchParams({
      "user[login]":      this.config.account.username,
      "user[password]":   this.config.account.password,
      "user[uni_url]":    this.world,
      authenticity_token: authToken,
      commit: "Aanmelden",
    });

    const loginRes = await this.client.post(
      "https://www.grepolis.com/login",
      formData.toString(),
      {
        headers: {
          ...this._headers("https://www.grepolis.com/start"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    // Stap 3: Controleer of login gelukt is door gamepagina te laden
    const finalUrl = loginRes.request?.res?.responseUrl || "";
    logger.info(`Redirect naar: ${finalUrl}`);

    const gameRes = await this.client.get(
      `${this.baseUrl}/game/${this.world}`,
      { headers: this._headers("https://www.grepolis.com/") }
    );

    if (gameRes.status !== 200 || !gameRes.data.includes("player_id")) {
      throw new Error(
        "Login mislukt — controleer je e-mailadres, wachtwoord en world-naam (bv. nl132) in config.json."
      );
    }

    this._extractGameData(gameRes.data);
    logger.info(`Sessie OK — player_id: ${this.playerId}, world: ${this.world}`);
  }

  _extractGameData(html) {
    const csrfMatch = html.match(/csrf_token["'\s:]+["']([a-f0-9]{20,})["']/);
    if (csrfMatch) this.csrfToken = csrfMatch[1];

    const pidMatch = html.match(/player_id["'\s:]+(\d+)/);
    if (pidMatch) this.playerId = parseInt(pidMatch[1]);

    if (!this.csrfToken) throw new Error("Geen CSRF-token gevonden na login.");
    if (!this.playerId)  throw new Error("Geen player_id gevonden na login.");
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
