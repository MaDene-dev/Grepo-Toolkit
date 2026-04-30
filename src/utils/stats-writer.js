const logger = require("../utils/logger");

class StatsWriter {
  constructor(config) {
    this.world         = config.account.world ?? "unknown";
    this._sessionStart = new Date().toISOString();
    this.gasUrl        = process.env.GAS_URL;
    this.gasSecret     = process.env.GAS_SECRET;
  }

  async recordSession(stats, history) {
    if (!this.gasUrl || !this.gasSecret) {
      logger.warn("[Stats] GAS_URL of GAS_SECRET niet ingesteld — dashboard wordt niet bijgewerkt");
      return;
    }
    logger.info("[Stats] Versturen naar dashboard...");

    const lastRound  = history.length > 0 ? history[history.length - 1] : null;
    const durations  = history.map(r => parseFloat(r.duration)).filter(d => !isNaN(d));
    const avgDuration = durations.length > 0
      ? (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1)
      : 0;

    const payload = {
      world:         this.world,
      runs:          stats.runs,
      wood:          stats.totalWood,
      stone:         stats.totalStone,
      silver:        stats.totalIron,
      farms:         stats.totalFarms,
      failed:        stats.failedRuns,
      avg_duration:  avgDuration,
      started:       this._sessionStart,
      ended:         new Date().toISOString(),
      storage_wood:  lastRound?.storageWood  ?? 0,
      storage_stone: lastRound?.storageStone ?? 0,
      storage_iron:  lastRound?.storageIron  ?? 0,
      storage_max:   lastRound?.storageMax   ?? 0,
      rounds: history.slice(-20).map(r => ({
        time:         r.time,
        label:        r.label,
        farms:        r.farms,
        wood:         r.wood,
        stone:        r.stone,
        silver:       r.silver ?? r.iron ?? 0,
        storageWood:  r.storageWood  ?? 0,
        storageStone: r.storageStone ?? 0,
        storageIron:  r.storageIron  ?? 0,
        storageMax:   r.storageMax   ?? 0,
      })),
    };

    try {
      // Gebruik global fetch (Node 18+) — handelt GAS redirects correct af
      const body = JSON.stringify(payload);
      const res  = await fetch(this.gasUrl, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bot-Secret": this.gasSecret,
        },
        body,
        redirect: "follow",
      });

      const text = await res.text();
      logger.info(`[Stats] HTTP ${res.status} | ${text.substring(0, 150)}`);
      try {
        const r = JSON.parse(text);
        if (r.ok) logger.info("[Stats] Dashboard bijgewerkt ✓");
        else      logger.warn(`[Stats] GAS fout: ${r.error}`);
      } catch (_) {
        if (res.ok) logger.info("[Stats] Dashboard bijgewerkt ✓");
        else        logger.warn(`[Stats] Onverwachte response: ${res.status}`);
      }
    } catch (err) {
      logger.warn(`[Stats] Fout: ${err.message}`);
    }
  }
}

module.exports = StatsWriter;
