import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const dataDirectory = path.dirname(config.dataFile);
fs.mkdirSync(dataDirectory, { recursive: true });

const initialState = () => ({
  version: 1,
  nextEventId: 1,
  users: {},
  orders: {},
  paymentEvents: {}
});

function readState() {
  if (!fs.existsSync(config.dataFile)) {
    const fresh = initialState();
    persistState(fresh);
    return fresh;
  }

  try {
    const raw = fs.readFileSync(config.dataFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...initialState(),
      ...parsed,
      users: parsed.users ?? {},
      orders: parsed.orders ?? {},
      paymentEvents: parsed.paymentEvents ?? {}
    };
  } catch (error) {
    throw new Error(`Não foi possível ler ${config.dataFile}: ${error.message}`);
  }
}

function persistState(nextState) {
  const tempPath = `${config.dataFile}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(nextState, null, 2), "utf8");
  fs.renameSync(tempPath, config.dataFile);
}

let state = readState();
const now = () => new Date().toISOString();

function mutate(mutator) {
  mutator(state);
  persistState(state);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function upsertUser({ telegramId, username, firstName, ageConfirmed = 0 }) {
  const id = String(telegramId);
  const timestamp = now();
  mutate((draft) => {
    const current = draft.users[id];
    draft.users[id] = {
      telegram_id: id,
      username: username ?? current?.username ?? null,
      first_name: firstName ?? current?.first_name ?? null,
      age_confirmed: current?.age_confirmed ?? ageConfirmed,
      created_at: current?.created_at ?? timestamp,
      updated_at: timestamp
    };
  });
}

export function confirmAge(telegramId) {
  const id = String(telegramId);
  mutate((draft) => {
    if (!draft.users[id]) return;
    draft.users[id].age_confirmed = 1;
    draft.users[id].updated_at = now();
  });
}

export function getUser(telegramId) {
  return clone(state.users[String(telegramId)] ?? null);
}

export function createOrder({ orderNsu, telegramId, amountCents, title }) {
  const timestamp = now();
  mutate((draft) => {
    if (draft.orders[orderNsu]) throw new Error("Pedido duplicado.");
    draft.orders[orderNsu] = {
      order_nsu: orderNsu,
      telegram_id: String(telegramId),
      amount_cents: amountCents,
      title,
      status: "PENDING",
      checkout_url: null,
      transaction_nsu: null,
      invoice_slug: null,
      receipt_url: null,
      capture_method: null,
      invite_link: null,
      invite_expires_at: null,
      invite_notified_at: null,
      paid_at: null,
      joined_at: null,
      created_at: timestamp,
      updated_at: timestamp
    };
  });
  return getOrder(orderNsu);
}

export function setCheckoutUrl(orderNsu, checkoutUrl) {
  mutate((draft) => {
    const order = draft.orders[orderNsu];
    if (!order) throw new Error("Pedido não encontrado.");
    order.checkout_url = checkoutUrl;
    order.updated_at = now();
  });
}

export function setOrderFailed(orderNsu) {
  mutate((draft) => {
    const order = draft.orders[orderNsu];
    if (!order) return;
    order.status = "FAILED";
    order.updated_at = now();
  });
}

export function getOrder(orderNsu) {
  return clone(state.orders[orderNsu] ?? null);
}

export function getLatestPendingOrder(telegramId) {
  return clone(
    Object.values(state.orders)
      .filter(
        (order) =>
          order.telegram_id === String(telegramId) &&
          order.status === "PENDING" &&
          order.checkout_url
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  );
}

export function getActiveOrder(telegramId) {
  return clone(
    Object.values(state.orders)
      .filter(
        (order) =>
          order.telegram_id === String(telegramId) &&
          ["PAID", "DELIVERED"].includes(order.status)
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  );
}

export function markOrderPaid({
  orderNsu,
  transactionNsu,
  invoiceSlug,
  receiptUrl,
  captureMethod
}) {
  const duplicateTransaction = Object.values(state.orders).find(
    (order) =>
      order.transaction_nsu === transactionNsu && order.order_nsu !== orderNsu
  );
  if (duplicateTransaction) throw new Error("Transação já vinculada a outro pedido.");

  mutate((draft) => {
    const order = draft.orders[orderNsu];
    if (!order) throw new Error("Pedido não encontrado.");
    const timestamp = now();
    if (order.status !== "DELIVERED") order.status = "PAID";
    order.transaction_nsu = transactionNsu;
    order.invoice_slug = invoiceSlug;
    order.receipt_url = receiptUrl ?? null;
    order.capture_method = captureMethod;
    order.paid_at = order.paid_at ?? timestamp;
    order.updated_at = timestamp;
  });
  return getOrder(orderNsu);
}

export function setInvite(orderNsu, inviteLink, inviteExpiresAt) {
  const duplicateInvite = Object.values(state.orders).find(
    (order) => order.invite_link === inviteLink && order.order_nsu !== orderNsu
  );
  if (duplicateInvite) throw new Error("Convite já vinculado a outro pedido.");

  mutate((draft) => {
    const order = draft.orders[orderNsu];
    if (!order) throw new Error("Pedido não encontrado.");
    order.invite_link = inviteLink;
    order.invite_expires_at = inviteExpiresAt;
    order.invite_notified_at = null;
    order.updated_at = now();
  });
  return getOrder(orderNsu);
}

export function markInviteNotified(orderNsu) {
  mutate((draft) => {
    const order = draft.orders[orderNsu];
    if (!order) return;
    const timestamp = now();
    order.invite_notified_at = timestamp;
    order.updated_at = timestamp;
  });
}

export function getOrderByInvite(inviteLink) {
  return clone(
    Object.values(state.orders).find((order) => order.invite_link === inviteLink) ?? null
  );
}

export function markDelivered(orderNsu) {
  mutate((draft) => {
    const order = draft.orders[orderNsu];
    if (!order) return;
    const timestamp = now();
    order.status = "DELIVERED";
    order.joined_at = timestamp;
    order.updated_at = timestamp;
  });
}

export function enqueuePaymentEvent(payload) {
  const transactionNsu = String(payload.transaction_nsu ?? "");
  const orderNsu = String(payload.order_nsu ?? "");
  const current = state.paymentEvents[transactionNsu];

  if (current) return { inserted: false, event: clone(current) };

  let created;
  mutate((draft) => {
    created = {
      id: draft.nextEventId++,
      transaction_nsu: transactionNsu,
      order_nsu: orderNsu,
      payload: JSON.stringify(payload),
      status: "PENDING",
      attempts: 0,
      last_error: null,
      created_at: now(),
      processed_at: null
    };
    draft.paymentEvents[transactionNsu] = created;
  });

  return { inserted: true, event: clone(created) };
}

export function listPendingEvents(limit = 10) {
  return clone(
    Object.values(state.paymentEvents)
      .filter(
        (event) =>
          ["PENDING", "RETRY", "PROCESSING"].includes(event.status) && event.attempts < 12
      )
      .sort((a, b) => a.id - b.id)
      .slice(0, limit)
  );
}

function mutateEventById(id, mutator) {
  mutate((draft) => {
    const event = Object.values(draft.paymentEvents).find((item) => item.id === id);
    if (event) mutator(event);
  });
}

export function markEventProcessing(id) {
  mutateEventById(id, (event) => {
    event.status = "PROCESSING";
    event.attempts += 1;
  });
}

export function markEventDone(id) {
  mutateEventById(id, (event) => {
    event.status = "DONE";
    event.processed_at = now();
    event.last_error = null;
  });
}

export function markEventRetry(id, error) {
  mutateEventById(id, (event) => {
    event.status = "RETRY";
    event.last_error = String(error).slice(0, 1000);
  });
}

export function listPaidOrdersWithoutNotification(limit = 20) {
  return clone(
    Object.values(state.orders)
      .filter((order) => order.status === "PAID" && !order.invite_notified_at)
      .sort((a, b) => (a.paid_at ?? "").localeCompare(b.paid_at ?? ""))
      .slice(0, limit)
  );
}

export function getStats() {
  const orders = Object.values(state.orders);
  const paidOrders = orders.filter((order) => ["PAID", "DELIVERED"].includes(order.status));
  return {
    users: Object.keys(state.users).length,
    orders: orders.length,
    pending: orders.filter((order) => order.status === "PENDING").length,
    paid: paidOrders.length,
    delivered: orders.filter((order) => order.status === "DELIVERED").length,
    revenue_cents: paidOrders.reduce((total, order) => total + Number(order.amount_cents), 0)
  };
}

export function databaseHealthCheck() {
  return Boolean(state && state.users && state.orders && state.paymentEvents);
}
