const logger = require("./logger");

class StatsWriter {
  constructor(config) {
    this.world     = config.account.world ?? "unknown";
    this.gasUrl    = process.env.GAS_URL;
    this.gasSecret = process.env.GAS_SECRET;
    this.sessionId = null;
  }

  async _post(action, payload) {
    if (!this.gasUrl || !this.gasSecret) return null;
    try {
      const url = new URL(this.gasUrl);
      url.searchParams.set("secret", this.gasSecret);
      url.searchParams.set("action", action);
      const res = await fetch(url.toString(), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), redirect: "follow",
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
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
      const res  = await fetch(url.toString(), { redirect: "follow" });
      const text = await res.text();
      try { return JSON.parse(text); } catch (_) { return null; }
    } catch (err) {
      logger.warn(`[Stats] GET fout (${action}): ${err.message}`);
      return null;
    }
  }

  // ── Status ────────────────────────────────────────────────
  async readStatus() {
    return await this._get("getStatus");
  }

  async updateStatus(fields) {
    await this._post("updateStatus", { world: this.world, ...fields });
  }

  // ── Pauze check ───────────────────────────────────────────
  async isPaused() {
    const status = await this.readStatus();
    if (!status) return false;
    if (status.bot_status !== "paused") return false;
    if (!status.paused_until || status.paused_until === "manual") return true;
    return new Date(status.paused_until) > new Date();
  }

  // ── Laatste ophaling ──────────────────────────────────────
  async getLastHarvest() {
    const r = await this._get("getLastHarvest", { world: this.world });
    if (!r?.timestamp) return null;
    return new Date(r.timestamp);
  }

  // ── Harvest Queue ─────────────────────────────────────────
  async getActiveQueueTask() {
    const r = await this._get("getActiveQueueTask");
    return r ?? null;
  }

  async activateQueueTask(queueId) {
    return await this._post("activateQueueTask", { queue_id: queueId });
  }

  async updateQueueTask(queueId, fields) {
    return await this._post("updateQueueTask", { queue_id: queueId, ...fields });
  }

  async completeQueueTask(queueId, totals) {
    return await this._post("completeQueueTask", { queue_id: queueId, ...totals });
  }

  // ── Sessie opslaan ────────────────────────────────────────
  async saveSession(session) {
    const r = await this._post("saveSession", session);
    if (r?.ok) logger.info("[Stats] Sessie opgeslagen ✓");
  }

  // ── Ronde opslaan ─────────────────────────────────────────
  async saveRound(round) {
    await this._post("saveRound", round);
  }

  // ── Gebouwen opslaan (één keer per sessie) ──────────────────
  async saveBuildings(buildingData) {
    if (!buildingData || Object.keys(buildingData).length === 0) return;
    await this._post("saveBuildings", { world: this.world, buildings: buildingData });
  }

  // ── Grotten opslaan ─────────────────────────────────────────
  async saveTroops(recruitData) {
    if (!recruitData) return;
    await this._post("saveTroops", { world: this.world, ...recruitData });
  }

  async saveGods(godData) {
    if (!godData || Object.keys(godData).length === 0) return;
    await this._post("saveGods", { world: this.world, gods: godData });
  }

  async saveHides(hideData) {
    if (!hideData || Object.keys(hideData).length === 0) return;
    await this._post("saveHides", { world: this.world, hides: hideData });
  }

  // ── Eilanden sync naar config.json ──────────────────────────
  async syncEilanden(towns, currentEilanden) {
    // Groepeer steden per eiland
    const byIsland = {};
    for (const t of towns) {
      const key = `${t.island_x}_${t.island_y}`;
      if (!byIsland[key]) byIsland[key] = [];
      byIsland[key].push(t);
    }
    // Detecteer nieuwe eilanden (niet in huidige config)
    const nieuw = {};
    for (const [key, eilandTowns] of Object.entries(byIsland)) {
      if (!currentEilanden[key]) {
        nieuw[key] = {
          naam:             `Eiland ${key}`,
          primaire_stad_id: eilandTowns[0].id,
        };
      }
    }
    if (Object.keys(nieuw).length === 0) return; // niets te doen
    logger.info(`[Stats] Nieuwe eilanden gevonden: ${Object.keys(nieuw).join(", ")} → config bijwerken`);
    await this._post("syncEilanden", { nieuw });
  }

  // ── Towns opslaan (na elke getTowns()) ──────────────────────
  async saveTowns(towns) {
    if (!towns?.length) return;
    await this._post("saveTowns", { world: this.world, towns });
  }

  // ── TownSnapshot opslaan ──────────────────────────────────
  async saveTownSnapshots(snapshots) {
    if (!snapshots?.length) return;
    await this._post("saveTownSnapshots", { snapshots });
  }
  // ── Trade log opslaan ─────────────────────────────────────
  async saveTradeLog(logData) {
    await this._post("saveTradeLog", { world: this.world, ...logData });
  }

}

module.exports = StatsWriter;
