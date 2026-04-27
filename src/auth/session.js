const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const logger = require("../utils/logger");

class Session {
  constructor(config) {
    this.config = config;
    this.jar = new CookieJar();
    this.client = wrapper(axios.create({ jar: this.jar, withCredentials: true }));
    this.csrfToken = null;
    this.playerId = null;
    this.world = config.account.world;
    this.baseUrl = `https://${this.world}.grepolis.com`;
  }

  // Performs a GET on the main game page to grab CSRF token and player info
  async _fetchGamePage() {
    const url = `${this.baseUrl}/game/${this.world}`;
    const res = await this.client.get(url, {
      headers: { "User-Agent": this._ua() },
    });

    // CSRF token is embedded in the page JS as csrf_token: "..."
    const csrfMatch = res.data.match(/csrf_token['":\s]+['"]([a-f0-9]+)['"]/);
    if (csrfMatch) this.csrfToken = csrfMatch[1];

    // Player ID
    const pidMatch = res.data.match(/player_id['":\s]+(\d+)/);
    if (pidMatch) this.playerId = parseInt(pidMatch[1]);

    if (!this.csrfToken) throw new Error("Kon CSRF token niet vinden op de gamepagina.");
    if (!this.playerId) throw new Error("Kon player_id niet vinden op de gamepagina.");

    logger.info(`Sessie OK — player_id: ${this.playerId}, world: ${this.world}`);
  }

  async login() {
    logger.info("Inloggen bij Grepolis...");

    // Step 1: Laad de startpagina om initiele cookies te krijgen
    await this.client.get("https://grepolis.com/start", {
      headers: { "User-Agent": this._ua() },
    });

    // Step 2: POST login-formulier
    const params = new URLSearchParams({
      login: this.config.account.username,
      password: this.config.account.password,
      uni: this.world,
    });

    const loginRes = await this.client.post("https://grepolis.com/start", params.toString(), {
      headers: {
        "User-Agent": this._ua(),
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://grepolis.com/start",
      },
      maxRedirects: 5,
    });

    // Controleer of we correct zijn doorgestuurd naar de game
    if (!loginRes.request.res.responseUrl?.includes(this.world)) {
      throw new Error("Login mislukt — controleer je gebruikersnaam, wachtwoord en world in config.json.");
    }

    logger.info("Login geslaagd.");
    await this._fetchGamePage();
  }

  // Stuurt een AJAX-request naar de Grepolis frontend bridge
  async ajax(action, townId, extraData = {}) {
    if (!this.csrfToken) throw new Error("Geen actieve sessie. Eerst inloggen.");

    const payload = {
      town_id: townId,
      action_name: action,
      ...extraData,
      h: this.csrfToken,
    };

    const res = await this.client.post(
      `${this.baseUrl}/game/${this.world}/frontend_bridge.php`,
      new URLSearchParams(payload).toString(),
      {
        headers: {
          "User-Agent": this._ua(),
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${this.baseUrl}/game/${this.world}`,
        },
      }
    );

    return res.data;
  }

  _ua() {
    return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  }
}

module.exports = Session;
