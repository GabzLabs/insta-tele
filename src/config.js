import fs from "node:fs";
import path from "node:path";

loadDotEnv(path.resolve(process.cwd(), ".env"));

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const value = line.trim();

    if (!value || value.startsWith("#")) {
      continue;
    }

    const separator = value.indexOf("=");

    if (separator < 1) {
      continue;
    }

    const key = value.slice(0, separator).trim();
    let content = value.slice(separator + 1).trim();

    const hasDoubleQuotes =
      content.startsWith('"') && content.endsWith('"');

    const hasSingleQuotes =
      content.startsWith("'") && content.endsWith("'");

    if (hasDoubleQuotes || hasSingleQuotes) {
      content = content.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = content;
    }
  }
}

function required(name, minLength = 1) {
  const value = process.env[name]?.trim();

  if (!value || value.length < minLength) {
    throw new Error(
      `Variável obrigatória ausente ou inválida: ${name}`
    );
  }

  return value;
}

function integer(name, fallback, min, max) {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;

  if (
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`Variável numérica inválida: ${name}`);
  }

  return value;
}

function boolean(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();

  if (!raw) {
    return fallback;
  }

  if (["true", "1", "yes", "sim"].includes(raw)) {
    return true;
  }

  if (["false", "0", "no", "nao", "não"].includes(raw)) {
    return false;
  }

  throw new Error(`Variável booleana inválida: ${name}`);
}

const publicBaseUrl = required("PUBLIC_BASE_URL", 8)
  .replace(/\/$/, "");

new URL(publicBaseUrl);

const certificatePath = path.resolve(
  required("EFI_CERTIFICATE_PATH", 3)
);

export const config = Object.freeze({
  botToken: required("BOT_TOKEN", 20),

  privateChannelId: required("PRIVATE_CHANNEL_ID", 2),

  adminTelegramId:
    process.env.ADMIN_TELEGRAM_ID?.trim() ?? "",

  efiClientId: required("EFI_CLIENT_ID", 8),

  efiClientSecret: required("EFI_CLIENT_SECRET", 8),

  efiPixKey: required("EFI_PIX_KEY", 3),

  efiCertificatePath: certificatePath,

  efiSandbox: boolean("EFI_SANDBOX", false),

  efiConfigureWebhookOnStart: boolean(
    "EFI_CONFIGURE_WEBHOOK_ON_START",
    true
  ),

  efiSkipMtlsWebhook: boolean(
    "EFI_SKIP_MTLS_WEBHOOK",
    true
  ),

  publicBaseUrl,

  webhookSecret: required("WEBHOOK_SECRET", 24),

  packTitle:
    process.env.PACK_TITLE?.trim() ||
    "Pack Premium — 50 vídeos",

  packDescription:
    process.env.PACK_DESCRIPTION?.trim() ||
    "Acesso ao canal privado com 50 vídeos licenciados",

  packPriceCents: integer(
    "PACK_PRICE_CENTS",
    500,
    1,
    100_000_000
  ),

  pixExpirationSeconds: integer(
    "PIX_EXPIRATION_SECONDS",
    900,
    60,
    86_400
  ),

  inviteExpirationHours: integer(
    "INVITE_EXPIRATION_HOURS",
    24,
    1,
    168
  ),

  port: integer("PORT", 3000, 1, 65535),

  dataFile:
    process.env.DATA_FILE?.trim() ||
    "./data/store.json",

  logLevel:
    process.env.LOG_LEVEL?.trim() ||
    "info"
});