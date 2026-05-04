const logger = require("./logger");

class StatsWriter {
  constructor(config) {
    this.world     = config.account.world ?? "unknown";
    this.gasUrl    = process.env.GAS_URL;
    this.gasSecret = process.env.GAS_SECRET;
    this.sessionId = null;
  }

  // ── GAS API call ──────────────────────────────────────────
  async _post(action, payload) {
    if (!this.gasUrl || !this.gasSecret) return null;
    try {
      const url  = new URL(this.gasUrl);
      url.searchParams.set("secret", this.gasSecret);
      url.searchParams.set("action", action);
      const res  = await fetch(url.toString(), {
        method:   "POST",
        headers:  { "Content-Type": "application/json" },
        body:     JSON.stringify(payload),
        redirect: "follow",
      });
      const text = await res.text();
      try { return JSON.parse(text); } catch (_) { return null; }
    } catch (err) {
      logger.warn(`[Stats] POST fout (${action}): ${err.message}`);
      return null;
    }
  }

  async _get(action, params = {}) {
    if (!this.gasUrl || !this.gasSecret) return null;
    try {
      const url = new URL(this.gasUrl);
      url.searchParams.set("secret", this.gasSecret);
      url.searchParams.set("action", action);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const res  = await fetch(url.toString(), { redirect: "follow" });
      const text = await res.text();
      try { return JSON.parse(text); } catch (_) { return null; }
    } catch (err) {
      logger.warn(`[Stats] GET fout (${action}): ${err.message}`);
      return null;
    }
  }

  // ── Status lezen (pre-check) ──────────────────────────────
  async readStatus() {
    const r = await this._get("getStatus");
    if (!r) return null;
    return r;
  }

  // ── Laatste ophaling ophalen ──────────────────────────────
  async getLastHarvest() {
    const r = await this._get("getLastHarvest", { world: this.world });
    if (!r?.timestamp) return null;
    return new Date(r.timestamp);
  }

  // ── Status updaten ────────────────────────────────────────
  async updateStatus(fields) {
    await this._post("updateStatus", { world: this.world, ...fields });
  }

  // ── Pauze check ───────────────────────────────────────────
  async isPaused() {
    const status = await this.readStatus();
    if (!status) return false; // fail-open
    if (status.bot_status !== "paused") return false;
    if (!status.paused_until || status.paused_until === "manual") return true;
    return new Date(status.paused_until) > new Date();
  }

  // ── Sessie opslaan ────────────────────────────────────────
  async saveSession(session) {
    const r = await this._post("saveSession", session);
    if (r?.ok) logger.info(`[Stats] Sessie opgeslagen ✓`);
    else        logger.warn(`[Stats] Sessie opslaan mislukt`);
  }

  // ── Ronde opslaan ─────────────────────────────────────────
  async saveRound(round) {
    await this._post("saveRound", round);
  }

  // ── TownSnapshot opslaan ──────────────────────────────────
  async saveTownSnapshots(snapshots) {
    await this._post("saveTownSnapshots", { snapshots });
  }
}

module.exports = StatsWriter;
