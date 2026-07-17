import fs from "node:fs";
import path from "node:path";

loadDotEnv(path.resolve(process.cwd(), ".env"));

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function required(name, minLength = 1) {
  const value = process.env[name]?.trim();
  if (!value || value.length < minLength) {
    throw new Error(`Variável obrigatória ausente ou inválida: ${name}`);
  }
  return value;
}

function integer(name, fallback, min, max) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Variável numérica inválida: ${name}`);
  }
  return value;
}

const publicBaseUrl = required("PUBLIC_BASE_URL", 8).replace(/\/$/, "");
try {
  new URL(publicBaseUrl);
} catch {
  throw new Error("PUBLIC_BASE_URL precisa ser uma URL válida.");
}

export const config = Object.freeze({
  botToken: required("BOT_TOKEN", 20),
  privateChannelId: required("PRIVATE_CHANNEL_ID", 2),
  adminTelegramId: process.env.ADMIN_TELEGRAM_ID?.trim() ?? "",
  infinitePayHandle: required("INFINITEPAY_HANDLE", 2).replace(/^\$/, ""),
  publicBaseUrl,
  webhookSecret: required("WEBHOOK_SECRET", 24),
  packTitle: process.env.PACK_TITLE?.trim() || "Pack Premium — 50 vídeos",
  packDescription:
    process.env.PACK_DESCRIPTION?.trim() ||
    "Acesso ao canal privado com 50 vídeos licenciados",
  packPriceCents: integer("PACK_PRICE_CENTS", 500, 1, 100_000_000),
  inviteExpirationHours: integer("INVITE_EXPIRATION_HOURS", 24, 1, 168),
  allowedCaptureMethods: (process.env.ALLOWED_CAPTURE_METHODS || "pix,credit_card")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  port: integer("PORT", 3000, 1, 65535),
  dataFile: process.env.DATA_FILE?.trim() || "./data/store.json",
  logLevel: process.env.LOG_LEVEL?.trim() || "info"
});
