import { config } from "./config.js";

const LINKS_URL = "https://api.checkout.infinitepay.io/links";
const PAYMENT_CHECK_URL = "https://api.checkout.infinitepay.io/payment_check";

async function postJson(url, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await response.text();
    let data;

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const error = new Error(`InfinitePay respondeu HTTP ${response.status}`);
      error.details = data;
      throw error;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function createCheckoutLink({ orderNsu }) {
  const payload = {
    handle: config.infinitePayHandle,
    order_nsu: orderNsu,
    redirect_url: `${config.publicBaseUrl}/payment-success`,
    webhook_url: `${config.publicBaseUrl}/webhooks/infinitepay/${config.webhookSecret}`,
    items: [
      {
        quantity: 1,
        price: config.packPriceCents,
        description: config.packDescription
      }
    ]
  };

  const data = await postJson(LINKS_URL, payload);

  if (!data?.url || typeof data.url !== "string") {
    throw new Error("InfinitePay não retornou a URL do checkout.");
  }

  return data.url;
}

export async function checkPayment({ orderNsu, transactionNsu, invoiceSlug }) {
  return postJson(PAYMENT_CHECK_URL, {
    handle: config.infinitePayHandle,
    order_nsu: orderNsu,
    transaction_nsu: transactionNsu,
    slug: invoiceSlug
  });
}
