const Session     = require("./auth/session");
const GrepolisAPI = require("./api/grepolis");
const Autofarm    = require("./modules/autofarm");
const Mailer      = require("./utils/mailer");
const logger      = require("./utils/logger");
const config      = require("../config.json");

// Credentials via environment variables (Railway of GitHub Secrets)
if (process.env.GREPO_EMAIL)    config.account.username = process.env.GREPO_EMAIL;
if (process.env.GREPO_PASSWORD) config.account.password = process.env.GREPO_PASSWORD;
if (process.env.SMTP_TO)        config.email.to         = process.env.SMTP_TO;

// GitHub Actions: sluit af na 45 minuten zodat de job netjes eindigt
const IS_GITHUB_ACTIONS = !!process.env.GITHUB_ACTIONS;
if (IS_GITHUB_ACTIONS) {
  logger.info("[Boot] GitHub Actions modus: auto-stop na 45 minuten.");
  setTimeout(() => {
    logger.info("[Boot] 45 minuten verstreken, bot sluit netjes af.");
    process.exit(0);
  }, 45 * 60 * 1000);
}

const RETRY_DELAY_MS = 5 * 60 * 1000;
let autofarm = null;

async function boot() {
  logger.info("=== Grepolis Bot gestart ===");
  logger.info(`World: ${config.account.world}`);

  const mailer  = new Mailer(config);
  const session = new Session(config);

  try {
    await session.login();
  } catch (err) {
    logger.error(`Login mislukt: ${err.message}`);
    setTimeout(boot, RETRY_DELAY_MS);
    return;
  }

  const api = new GrepolisAPI(session);
  autofarm  = new Autofarm(api, config, mailer);
  autofarm.start();

  // Sessie elke 6 uur vernieuwen (alleen relevant bij Railway/VPS)
  if (!IS_GITHUB_ACTIONS) {
    setInterval(async () => {
      logger.info("Sessie vernieuwen...");
      try {
        if (autofarm) autofarm.stop();
        await session.login();
        if (autofarm) autofarm.start();
      } catch (err) {
        logger.error(`Sessie vernieuwen mislukt: ${err.message}`);
        setTimeout(boot, RETRY_DELAY_MS);
      }
    }, 6 * 60 * 60 * 1000);
  }
}

process.on("uncaughtException",   (err) => { logger.error(`Fout: ${err.message}`); if (autofarm) autofarm.stop(); setTimeout(boot, RETRY_DELAY_MS); });
process.on("unhandledRejection",  (r)   => { logger.error(`Rejection: ${r}`); });

boot();
