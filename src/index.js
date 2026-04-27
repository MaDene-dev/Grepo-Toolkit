const Session = require("./auth/session");
const GrepolisAPI = require("./api/grepolis");
const Autofarm = require("./modules/autofarm");
const logger = require("./utils/logger");
const config = require("../config.json");

// Hoe lang wachten na een fout voor we opnieuw proberen (ms)
const RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minuten

let autofarm = null;

async function boot() {
  logger.info("=== Grepolis Bot gestart ===");
  logger.info(`World: ${config.account.world} | Modus: ${config.autofarm.mode}`);

  const session = new Session(config);

  try {
    await session.login();
  } catch (err) {
    logger.error(`Login mislukt: ${err.message}`);
    logger.info(`Opnieuw proberen over ${RETRY_DELAY_MS / 60000} minuten...`);
    setTimeout(boot, RETRY_DELAY_MS);
    return;
  }

  const api = new GrepolisAPI(session);

  // Start autofarm
  autofarm = new Autofarm(api, config);
  autofarm.start();

  // Elke 6 uur de sessie vernieuwen (Grepolis gooit sessies eruit na inactiviteit)
  setInterval(async () => {
    logger.info("Sessie vernieuwen...");
    try {
      if (autofarm) autofarm.stop();
      await session.login();
      if (autofarm) autofarm.start();
    } catch (err) {
      logger.error(`Sessie vernieuwen mislukt: ${err.message}`);
      logger.info(`Herstart over ${RETRY_DELAY_MS / 60000} minuten...`);
      setTimeout(boot, RETRY_DELAY_MS);
    }
  }, 6 * 60 * 60 * 1000);
}

// Globale foutopvang zodat de bot niet crasht
process.on("uncaughtException", (err) => {
  logger.error(`Onverwachte fout: ${err.message}`);
  logger.info(`Herstart over ${RETRY_DELAY_MS / 60000} minuten...`);
  if (autofarm) autofarm.stop();
  setTimeout(boot, RETRY_DELAY_MS);
});

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled promise rejection: ${reason}`);
});

boot();
