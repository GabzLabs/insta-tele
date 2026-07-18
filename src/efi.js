import fs from "node:fs";
import EfiPay from "sdk-node-apis-efi";
import { config } from "./config.js";

if (!fs.existsSync(config.efiCertificatePath)) {
  throw new Error(
    `Certificado Efí não encontrado: ${config.efiCertificatePath}`
  );
}

const efipay = new EfiPay({
  sandbox: config.efiSandbox,

  client_id: config.efiClientId,
  client_secret: config.efiClientSecret,

  certificate: config.efiCertificatePath,

  validateMtls: !config.efiSkipMtlsWebhook
});

export async function createPixCharge() {
  const body = {
    calendario: {
      expiracao: config.pixExpirationSeconds
    },

    valor: {
      original: centsToAmount(
        config.packPriceCents
      )
    },

    chave: config.efiPixKey,

    solicitacaoPagador:
      "Acesso a conteúdo digital licenciado",

    infoAdicionais: [
      {
        nome: "Produto",
        valor: config.packTitle.slice(0, 50)
      }
    ]
  };

  const charge =
    await efipay.pixCreateImmediateCharge(body);

  if (!charge?.txid) {
    throw new Error(
      "A Efí não retornou o txid da cobrança."
    );
  }

  if (!charge?.loc?.id) {
    throw new Error(
      "A Efí não retornou o location.id da cobrança."
    );
  }

  const qrCode =
    await efipay.pixGenerateQRCode({
      id: charge.loc.id
    });

  const pixCopyPaste =
    qrCode?.qrcode ??
    charge?.pixCopiaECola;

  if (!pixCopyPaste) {
    throw new Error(
      "A Efí não retornou o Pix Copia e Cola."
    );
  }

  return {
    txid: charge.txid,

    locationId: charge.loc.id,

    pixCopyPaste,

    qrDataUrl:
      qrCode?.imagemQrcode ?? null,

    visualizationUrl:
      qrCode?.linkVisualizacao ?? null,

    status: charge.status,

    expiresAt: new Date(
      Date.now() +
      config.pixExpirationSeconds * 1000
    ).toISOString()
  };
}

export async function detailPixCharge(txid) {
  return efipay.pixDetailCharge({
    txid
  });
}

export async function configurePixWebhook() {
  const webhookUrl =
    `${config.publicBaseUrl}` +
    `/webhooks/efi/${config.webhookSecret}`;

  const body = {
    webhookUrl
  };

  const headers =
    config.efiSkipMtlsWebhook
      ? {
          "x-skip-mtls-checking": "true"
        }
      : undefined;

  const result = await efipay.pixConfigWebhook(
    {
      chave: config.efiPixKey
    },
    body,
    headers
  );

  return {
    result,
    webhookUrl
  };
}

export function isChargePaid(
  charge,
  expectedCents
) {
  if (charge?.status !== "CONCLUIDA") {
    return false;
  }

  const originalCents = amountToCents(
    charge?.valor?.original
  );

  const receivedCents =
    Array.isArray(charge?.pix)
      ? charge.pix.reduce(
          (total, pix) => {
            return (
              total +
              amountToCents(pix.valor)
            );
          },
          0
        )
      : originalCents;

  return (
    originalCents === expectedCents &&
    receivedCents >= expectedCents
  );
}

export function getPaymentData(charge) {
  const pix =
    Array.isArray(charge?.pix)
      ? charge.pix[0]
      : null;

  return {
    endToEndId:
      pix?.endToEndId ?? null,

    paidAt:
      pix?.horario ??
      new Date().toISOString()
  };
}

function centsToAmount(cents) {
  return (
    Number(cents) / 100
  ).toFixed(2);
}

function amountToCents(value) {
  const number = Number(
    String(value ?? "0")
      .replace(",", ".")
  );

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.round(number * 100);
}