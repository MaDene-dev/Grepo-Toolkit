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

    // Haal opslag-info uit de laatste ronde
    const lastRound = history.length > 0 ? history[history.length - 1] : null;

    // Bereken gemiddelde rondetijd
    const durations = history.map(r => parseFloat(r.duration)).filter(d => !isNaN(d));
    const avgDuration = durations.length > 0
      ? (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1)
      : 0;

    const payload = {
      world:        this.world,
      runs:         stats.runs,
      wood:         stats.totalWood,
      stone:        stats.totalStone,
      silver:       stats.totalIron,
      farms:        stats.totalFarms,
      failed:       stats.failedRuns,
      avg_duration: avgDuration,
      started:      this._sessionStart,
      ended:        new Date().toISOString(),
      // Opslag van laatste ronde
      storage_wood:  lastRound?.storageWood  ?? 0,
      storage_stone: lastRound?.storageStone ?? 0,
      storage_iron:  lastRound?.storageIron  ?? 0,
      storage_max:   lastRound?.storageMax   ?? 0,
      rounds: history.slice(-20).map(r => ({
        time:        r.time,
        label:       r.label,
        farms:       r.farms,
        wood:        r.wood,
        stone:       r.stone,
        silver:      r.silver ?? r.iron ?? 0,
        storageWood:  r.storageWood  ?? 0,
        storageStone: r.storageStone ?? 0,
        storageIron:  r.storageIron  ?? 0,
        storageMax:   r.storageMax   ?? 0,
      })),
    };

    try {
      // Gebruik node-fetch stijl via axios-achtige aanpak met redirect support
      const postWithRedirect = (urlStr, body, secret, maxRedirects = 5) => {
        return new Promise((resolve) => {
          const https = require("https");
          const http  = require("http");
          const url   = new URL(urlStr);
          const lib   = url.protocol === "https:" ? https : http;

          const req = lib.request({
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   "POST",
            headers: {
              "Content-Type":   "application/json",
              "X-Bot-Secret":   secret,
              "Content-Length": Buffer.byteLength(body),
            },
          }, res => {
            // Volg redirects
            if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
              const newUrl = res.headers.location.startsWith("http")
                ? res.headers.location
                : new URL(res.headers.location, urlStr).href;
              res.resume();
              resolve(postWithRedirect(newUrl, body, secret, maxRedirects - 1));
              return;
            }
            let data = "";
            res.on("data", d => data += d);
            res.on("end", () => resolve({ status: res.statusCode, body: data }));
          });
          req.on("error", err => resolve({ status: 0, body: err.message }));
          req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
          req.write(body);
          req.end();
        });
      };

      const body   = JSON.stringify(payload);
      const result = await postWithRedirect(this.gasUrl, body, this.gasSecret);
      logger.info(`[Stats] HTTP ${result.status} | ${result.body.substring(0, 150)}`);
      try {
        const r = JSON.parse(result.body);
        if (r.ok) logger.info("[Stats] Dashboard bijgewerkt ✓");
        else      logger.warn(`[Stats] GAS fout: ${r.error}`);
      } catch (_) {
        if (result.status === 200) logger.info("[Stats] Dashboard bijgewerkt ✓");
        else logger.warn(`[Stats] Onverwachte response: ${result.status}`);
      }
    } catch (err) {
      logger.warn(`[Stats] Fout: ${err.message}`);
    }
  }
}

module.exports = StatsWriter;
