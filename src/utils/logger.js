const winston = require("winston");

// Geef altijd de Belgische tijd weer (UTC+1 winter, UTC+2 zomer)
const nlTimestamp = () => {
  return new Date().toLocaleString("nl-BE", {
    timeZone: "Europe/Brussels",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
};

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.printf(({ level, message }) => {
      return `[${nlTimestamp()}] [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "bot.log", maxsize: 5_000_000, maxFiles: 2 }),
  ],
});

module.exports = logger;
