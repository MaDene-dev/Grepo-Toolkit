const fs   = require("fs");
const path = require("path");

const STATS_FILE = path.join(__dirname, "../../docs/data.json");

class StatsWriter {
  constructor(config) {
    this.world         = config.account.world;
    this.towns         = config.account.towns ?? [];
    this.data          = this._load();
    this._sessionStart = new Date().toISOString();
  }

  _load() {
    try {
      if (fs.existsSync(STATS_FILE)) {
        return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
      }
    } catch (_) {}
    return { world: this.world, sessions: [], last_updated: null };
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
      this.data.last_updated = new Date().toISOString();
      fs.writeFileSync(STATS_FILE, JSON.stringify(this.data, null, 2));
    } catch (_) {}
  }

  recordSession(stats, history) {
    const now = new Date().toISOString();
    const session = {
      started_at: this._sessionStart || now,
      ended_at:   now,
      runs:       stats.runs,
      wood:       stats.totalWood,
      stone:      stats.totalStone,
      silver:     stats.totalIron,
      farms:      stats.totalFarms,
      failed:     stats.failedRuns,
      rounds:     history.slice(-20),
    };
    if (!this._sessionStart) this._sessionStart = now;

    this.data.sessions.unshift(session);
    // Bewaar max 30 sessies
    if (this.data.sessions.length > 30) {
      this.data.sessions = this.data.sessions.slice(0, 30);
    }

    this._save();
  }

  updateStatus(status) {
    this.data.status       = status;
    this.data.last_updated = new Date().toISOString();
    this._save();
  }
}

module.exports = StatsWriter;
