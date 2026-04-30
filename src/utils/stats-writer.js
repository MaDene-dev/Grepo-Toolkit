const logger = require("../utils/logger");

class StatsWriter {
  constructor(config) {
    this.world      = config.account.world ?? "unknown";
    this._sessionStart = new Date().toISOString();
    this.gasUrl     = process.env.GAS_URL;
    this.gasSecret  = process.env.GAS_SECRET;
  }

  async recordSession(stats, history) {
    if (!this.gasUrl || !this.gasSecret) return;

    const payload = {
      world:   this.world,
      runs:    stats.runs,
      wood:    stats.totalWood,
      stone:   stats.totalStone,
      silver:  stats.totalIron,
      farms:   stats.totalFarms,
      failed:  stats.failedRuns,
      started: this._sessionStart,
      ended:   new Date().toISOString(),
      rounds:  history.slice(-20).map(r => ({
        time:       r.time,
        label:      r.label,
        farms:      r.farms,
        wood:       r.wood,
        stone:      r.stone,
        silver:     r.silver ?? r.iron ?? 0,
        storageMax: r.storageMax ?? 0,
      })),
    };

    try {
      const https = require("https");
      const url   = new URL(this.gasUrl);
      const body  = JSON.stringify(payload);

      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: url.hostname,
          path:     url.pathname + url.search,
          method:   "POST",
          headers:  {
            "Content-Type":   "application/json",
            "X-Bot-Secret":   this.gasSecret,
            "Content-Length": Buffer.byteLength(body),
          },
        }, res => {
          let data = "";
          res.on("data", d => data += d);
          res.on("end", () => {
            try {
              const r = JSON.parse(data);
              if (r.ok) logger.info("[Stats] Dashboard bijgewerkt ✓");
              else      logger.warn(`[Stats] GAS fout: ${r.error}`);
            } catch (_) {}
            resolve();
          });
        });
        req.on("error", err => { logger.warn(`[Stats] POST mislukt: ${err.message}`); resolve(); });
        req.setTimeout(10000, () => { req.destroy(); resolve(); });
        req.write(body);
        req.end();
      });
    } catch (err) {
      logger.warn(`[Stats] Fout: ${err.message}`);
    }
  }
}

module.exports = StatsWriter;
