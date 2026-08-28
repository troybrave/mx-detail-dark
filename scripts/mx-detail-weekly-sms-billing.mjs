#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

process.env.TZ = process.env.MX_DETAIL_BILLING_TZ || "America/New_York";

const WORKFLOW = "mx_detail_sms";
const NOTICE_WAIT_MS = 24 * 60 * 60 * 1000;

const GSM7 = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ" +
    " !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM7_EXT = new Set("^{}\\[~]|€");

function usage() {
  console.error(`Usage:
  node scripts/mx-detail-weekly-sms-billing.mjs cloud [--dry-run | --live] [--start ISO --end ISO]

Live mode also requires MX_DETAIL_BILLING_ENABLED=true.
All credentials are injected by Doppler; account identifiers are repository variables.
`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command, dryRun: true, live: false };
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === "--dry-run") {
      args.dryRun = true;
      args.live = false;
    } else if (item === "--live") {
      args.live = true;
      args.dryRun = false;
    } else if (item === "--start") args.start = rest[++index];
    else if (item === "--end") args.end = rest[++index];
    else throw new Error(`Unknown argument: ${item}`);
  }
  if (command !== "cloud") {
    usage();
    throw new Error("The cloud command is required.");
  }
  if ((args.start && !args.end) || (!args.start && args.end)) {
    throw new Error("Pass both --start and --end.");
  }
  if (args.live && String(process.env.MX_DETAIL_BILLING_ENABLED).toLowerCase() !== "true") {
    throw new Error("Live billing is locked. Set MX_DETAIL_BILLING_ENABLED=true after cloud verification.");
  }
  if (args.live && (args.start || args.end)) {
    throw new Error("Custom periods are dry-run only. Live periods are derived from Stripe state.");
  }
  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function loadConfig() {
  const ratePerSegment = Number(requireEnv("MX_DETAIL_SMS_RATE"));
  if (!Number.isFinite(ratePerSegment) || ratePerSegment <= 0) {
    throw new Error("MX_DETAIL_SMS_RATE must be a positive number.");
  }
  return {
    locationId: requireEnv("MX_DETAIL_GHL_LOCATION_ID"),
    stripeCustomerId: requireEnv("MX_DETAIL_STRIPE_CUSTOMER_ID"),
    bootstrapStart: new Date(requireEnv("MX_DETAIL_BILLING_BOOTSTRAP_START")).toISOString(),
    ratePerSegment,
    currency: "usd",
  };
}

function previousTuesdayMondayWeek(now = new Date()) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const daysSinceTuesday = (end.getDay() + 5) % 7;
  end.setDate(end.getDate() - daysSinceTuesday);
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  return { start: start.toISOString(), end: end.toISOString() };
}

function parsePeriodKey(value) {
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/.exec(value || "");
  if (!match) return null;
  return {
    start: new Date(`${match[1]}T00:00:00`).toISOString(),
    end: new Date(`${match[2]}T00:00:00`).toISOString(),
  };
}

function periodKey(period) {
  return `${period.start.slice(0, 10)}_${period.end.slice(0, 10)}`;
}

function maxIso(...values) {
  const valid = values.filter(Boolean).map((value) => new Date(value).toISOString());
  if (valid.length === 0) return null;
  return valid.sort().at(-1);
}

function smsSegments(text) {
  if (!text) return 0;
  let units = 0;
  for (const char of text) {
    if (GSM7.has(char)) units += 1;
    else if (GSM7_EXT.has(char)) units += 2;
    else {
      const unicodeUnits = [...text].length;
      return unicodeUnits <= 70 ? 1 : Math.ceil(unicodeUnits / 67);
    }
  }
  return units <= 160 ? 1 : Math.ceil(units / 153);
}

function centsForSegments(segments, ratePerSegment) {
  return Math.round(segments * ratePerSegment * 100);
}

function dollars(cents) {
  return (cents / 100).toFixed(2);
}

function noticeBody(segments, amountCents, ratePerSegment, period) {
  const periodLabel = period
    ? `${period.start.slice(5, 10)} to ${period.end.slice(5, 10)}`
    : "this billing period";
  const body =
    `MX Detail: ${segments} SMS segments (${periodLabel}) ` +
    `at $${ratePerSegment.toFixed(5)} each. Total text bill = $${dollars(amountCents)}. Card charged tomorrow.`;
  if (body.length > 180) throw new Error(`Notice SMS is ${body.length} chars; must be 180 or less.`);
  return body;
}

async function httpJson(url, { method = "GET", headers = {}, body, auth, idempotencyKey } = {}) {
  const requestHeaders = { Accept: "application/json", ...headers };
  if (auth) requestHeaders.Authorization = `Basic ${Buffer.from(auth).toString("base64")}`;
  if (idempotencyKey) requestHeaders["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(url, { method, headers: requestHeaders, body });
  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (!response.ok) {
    const message = parsed?.error?.message || parsed?.message || response.statusText;
    throw new Error(`${method} ${new URL(url).pathname} failed ${response.status}: ${message}`);
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(label, operation) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /\b(429|502|503|504)\b|timed out/i.test(message);
      if (!retryable || attempt === 4) break;
      await sleep(750 * attempt);
    }
  }
  throw new Error(`${label} failed after retries: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function stripeRequest(method, pathname, params = {}, idempotencyKey) {
  const key = requireEnv("STRIPE_ENDLESS_WINNING");
  const encoded = new URLSearchParams(params);
  const url = new URL(`https://api.stripe.com${pathname}`);
  if (method === "GET") url.search = encoded.toString();
  return httpJson(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2026-07-29.dahlia",
    },
    idempotencyKey,
    body: method === "GET" ? undefined : encoded,
  });
}

async function listCustomerInvoices(customerId) {
  const invoices = [];
  let startingAfter;
  for (let page = 0; page < 10; page += 1) {
    const params = { customer: customerId, limit: "100" };
    if (startingAfter) params.starting_after = startingAfter;
    const result = await stripeRequest("GET", "/v1/invoices", params);
    invoices.push(...result.data);
    if (!result.has_more || result.data.length === 0) break;
    startingAfter = result.data.at(-1).id;
  }
  return invoices;
}

function isBillingInvoice(invoice) {
  return (
    invoice.metadata?.billing_workflow === WORKFLOW ||
    (invoice.metadata?.client === "MX Detail" && Boolean(invoice.metadata?.period_key))
  );
}

function invoicePeriod(invoice) {
  if (invoice.metadata?.period_start && invoice.metadata?.period_end) {
    return {
      start: new Date(invoice.metadata.period_start).toISOString(),
      end: new Date(invoice.metadata.period_end).toISOString(),
    };
  }
  return parsePeriodKey(invoice.metadata?.period_key);
}

function latestPaidCutoff(invoices) {
  return maxIso(
    ...invoices
      .filter((invoice) => invoice.status === "paid" && isBillingInvoice(invoice))
      .map((invoice) => invoicePeriod(invoice)?.end),
  );
}

function findPendingInvoice(invoices) {
  const pending = invoices
    .filter((invoice) => isBillingInvoice(invoice) && ["draft", "open", "uncollectible"].includes(invoice.status))
    .sort((left, right) => right.created - left.created);
  if (pending.length > 1) {
    throw new Error(`Found ${pending.length} unfinished MX Detail SMS invoices. Manual review required.`);
  }
  return pending[0] || null;
}

async function fetchCustomer(customerId) {
  return stripeRequest("GET", `/v1/customers/${customerId}`);
}

async function fetchGhlSmsUsage(period, config) {
  const token = requireEnv("GHL_MXDETAIL_PIT");
  const all = [];
  let cursor = "";
  let apiTotal = null;
  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({
      locationId: config.locationId,
      channel: "SMS",
      startDate: period.start,
      endDate: period.end,
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);
    const data = await withRetry(`GHL SMS export page ${page + 1}`, () =>
      httpJson(`https://services.leadconnectorhq.com/conversations/messages/export?${params}`, {
        headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28" },
      }),
    );
    apiTotal ??= data.total ?? null;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    all.push(...messages);
    cursor = data.nextCursor || "";
    if (!cursor || messages.length === 0) break;
  }

  const summary = {
    apiTotal,
    fetched: all.length,
    inboundMessages: 0,
    outboundMessages: 0,
    inboundSegments: 0,
    outboundSegments: 0,
    messagesWithAttachments: 0,
  };
  for (const message of all) {
    const direction = String(message.direction || "unknown").toLowerCase();
    const segments = smsSegments(message.body || "");
    if (direction === "inbound") {
      summary.inboundMessages += 1;
      summary.inboundSegments += segments;
    } else if (direction === "outbound") {
      summary.outboundMessages += 1;
      summary.outboundSegments += segments;
    }
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      summary.messagesWithAttachments += 1;
    }
  }
  summary.billableSegments = summary.inboundSegments + summary.outboundSegments;
  summary.billableMessages = summary.inboundMessages + summary.outboundMessages;
  return summary;
}

async function updateInvoiceMetadata(invoiceId, metadata, idempotencyKey) {
  const params = {};
  for (const [key, value] of Object.entries(metadata)) params[`metadata[${key}]`] = String(value);
  return stripeRequest("POST", `/v1/invoices/${invoiceId}`, params, idempotencyKey);
}

async function updateCustomerCutoff(config, cutoff, key) {
  return stripeRequest(
    "POST",
    `/v1/customers/${config.stripeCustomerId}`,
    { "metadata[mx_detail_sms_billed_through]": cutoff },
    key,
  );
}

async function createDraftInvoice(period, usage, amountCents, config) {
  const key = periodKey(period);
  return stripeRequest(
    "POST",
    "/v1/invoices",
    {
      customer: config.stripeCustomerId,
      collection_method: "charge_automatically",
      auto_advance: "false",
      description: `MX Detail SMS usage ${period.start.slice(0, 10)} to ${period.end.slice(0, 10)}`,
      "metadata[billing_workflow]": WORKFLOW,
      "metadata[billing_status]": "created",
      "metadata[client]": "MX Detail",
      "metadata[period_key]": key,
      "metadata[period_start]": period.start,
      "metadata[period_end]": period.end,
      "metadata[billable_segments]": String(usage.billableSegments),
      "metadata[inbound_messages]": String(usage.inboundMessages),
      "metadata[outbound_messages]": String(usage.outboundMessages),
      "metadata[amount_cents]": String(amountCents),
      "metadata[rate_per_segment]": config.ratePerSegment.toFixed(5),
      "metadata[usage_source]": "ghl_messages_export",
    },
    `mx-detail-sms-invoice-${key}`,
  );
}

async function ensureInvoiceItem(invoice, config) {
  const metadata = invoice.metadata;
  const key = metadata.period_key;
  return stripeRequest(
    "POST",
    "/v1/invoiceitems",
    {
      customer: config.stripeCustomerId,
      invoice: invoice.id,
      amount: metadata.amount_cents,
      currency: config.currency,
      description:
        `MX Detail SMS usage: ${metadata.billable_segments} SMS segments ` +
        `at $${Number(metadata.rate_per_segment).toFixed(5)} each`,
      "metadata[billing_workflow]": WORKFLOW,
      "metadata[period_key]": key,
    },
    `mx-detail-sms-invoice-item-${key}`,
  );
}

async function sendNoticeSms(body, period) {
  const accountSid = requireEnv("TWILIO_EW_SID");
  const authToken = requireEnv("TWILIO_EW_AUTH");
  const from = requireEnv("MX_DETAIL_BILLING_FROM_PHONE");
  const to = requireEnv("MX_DETAIL_BILLING_NOTICE_TO");
  const result = await httpJson(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: "POST",
    auth: `${accountSid}:${authToken}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  });
  return { sid: result.sid, status: result.status, periodKey: periodKey(period) };
}

function noticeAgeMs(invoice, now = new Date()) {
  const sentAt = invoice.metadata?.notice_sent_at;
  return sentAt ? now.getTime() - new Date(sentAt).getTime() : null;
}

async function deliverNotice(invoice, config) {
  const period = invoicePeriod(invoice);
  if (!period) throw new Error(`Invoice ${invoice.id} has no valid billing period.`);
  const key = periodKey(period);
  const status = invoice.metadata?.billing_status || "created";
  if (status === "notice_sending") {
    throw new Error(`Invoice ${invoice.id} is stuck at notice_sending. Confirm Twilio delivery manually before resuming.`);
  }
  if (status !== "created") throw new Error(`Cannot send notice from billing status ${status}.`);

  await ensureInvoiceItem(invoice, config);
  await updateInvoiceMetadata(invoice.id, { billing_status: "notice_sending" }, `mx-detail-sms-notice-sending-${key}`);
  const body = noticeBody(
    Number(invoice.metadata.billable_segments),
    Number(invoice.metadata.amount_cents),
    Number(invoice.metadata.rate_per_segment),
    period,
  );
  const notice = await sendNoticeSms(body, period);
  const sentAt = new Date().toISOString();
  await updateInvoiceMetadata(
    invoice.id,
    { billing_status: "notice_sent", notice_sent_at: sentAt, twilio_message_sid: notice.sid },
    `mx-detail-sms-notice-sent-${key}`,
  );
  return { action: "notice_sent", invoiceId: invoice.id, period, sentAt };
}

async function chargeInvoice(invoice, config) {
  const period = invoicePeriod(invoice);
  if (!period) throw new Error(`Invoice ${invoice.id} has no valid billing period.`);
  const key = periodKey(period);
  const age = noticeAgeMs(invoice);
  if (age === null) throw new Error(`Invoice ${invoice.id} has no notice timestamp.`);
  if (age < NOTICE_WAIT_MS) {
    return { action: "waiting_24_hours", invoiceId: invoice.id, hoursRemaining: (NOTICE_WAIT_MS - age) / 36e5 };
  }

  await updateInvoiceMetadata(invoice.id, { billing_status: "charging" }, `mx-detail-sms-charging-${key}`);
  const finalized =
    invoice.status === "draft"
      ? await stripeRequest("POST", `/v1/invoices/${invoice.id}/finalize`, {}, `mx-detail-sms-finalize-${key}`)
      : invoice;
  const paid =
    finalized.status === "paid"
      ? finalized
      : await stripeRequest(
          "POST",
          `/v1/invoices/${invoice.id}/pay`,
          {},
          `mx-detail-sms-pay-${key}-${Number(invoice.attempt_count || 0) + 1}`,
        );
  if (paid.status !== "paid") throw new Error(`Stripe invoice ${invoice.id} is ${paid.status}, not paid.`);
  const paidAt = new Date().toISOString();
  await updateInvoiceMetadata(
    invoice.id,
    { billing_status: "paid", paid_at: paidAt },
    `mx-detail-sms-paid-metadata-${key}`,
  );
  await updateCustomerCutoff(config, period.end, `mx-detail-sms-customer-cutoff-${key}`);
  return { action: "charged", invoiceId: invoice.id, amountPaid: paid.amount_paid, period, paidAt };
}

function cloudDecision({ pendingInvoice, start, end, now = new Date() }) {
  if (pendingInvoice) {
    const status = pendingInvoice.metadata?.billing_status || "created";
    if (status === "notice_sending") return { action: "manual_review" };
    if (status === "created") return { action: "send_notice" };
    if (["notice_sent", "charging"].includes(status)) {
      const age = noticeAgeMs(pendingInvoice, now);
      return age !== null && age >= NOTICE_WAIT_MS ? { action: "charge" } : { action: "wait" };
    }
    return { action: "manual_review" };
  }
  return new Date(start) < new Date(end) ? { action: "measure_usage" } : { action: "nothing_due" };
}

async function writeSummary(result) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [
    "## MX Detail SMS billing",
    "",
    `- Result: **${result.action}**`,
    result.period ? `- Period: ${result.period.start} to ${result.period.end}` : null,
    result.amount ? `- Amount: ${result.amount}` : null,
    result.invoiceId ? `- Stripe invoice: ${result.invoiceId}` : null,
    result.dryRun !== undefined ? `- Dry run: ${result.dryRun}` : null,
    "",
  ].filter(Boolean);
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
}

async function runCloud(args, now = new Date()) {
  const config = loadConfig();
  const [customer, invoices] = await Promise.all([
    fetchCustomer(config.stripeCustomerId),
    listCustomerInvoices(config.stripeCustomerId),
  ]);
  const billingInvoices = invoices.filter(isBillingInvoice);
  const pendingInvoice = findPendingInvoice(billingInvoices);
  const scheduled = previousTuesdayMondayWeek(now);
  const checkpoint = customer.metadata?.mx_detail_sms_billed_through || null;
  const start = args.start
    ? new Date(args.start).toISOString()
    : maxIso(checkpoint, latestPaidCutoff(billingInvoices), config.bootstrapStart);
  const end = args.end ? new Date(args.end).toISOString() : scheduled.end;
  const decision = cloudDecision({ pendingInvoice, start, end, now });

  if (decision.action === "manual_review") {
    throw new Error(`Invoice ${pendingInvoice.id} is in ambiguous state ${pendingInvoice.metadata?.billing_status}.`);
  }
  if (decision.action === "wait") {
    const result = {
      action: "waiting_24_hours",
      invoiceId: pendingInvoice.id,
      hoursRemaining: Math.max(0, (NOTICE_WAIT_MS - noticeAgeMs(pendingInvoice, now)) / 36e5),
      dryRun: args.dryRun,
    };
    await writeSummary(result);
    return result;
  }
  if (decision.action === "charge") {
    if (args.dryRun) {
      const result = { action: "would_charge", invoiceId: pendingInvoice.id, dryRun: true };
      await writeSummary(result);
      return result;
    }
    const result = await chargeInvoice(pendingInvoice, config);
    await writeSummary({ ...result, dryRun: false });
    return result;
  }
  if (decision.action === "send_notice") {
    if (args.dryRun) {
      const result = { action: "would_resume_notice", invoiceId: pendingInvoice.id, dryRun: true };
      await writeSummary(result);
      return result;
    }
    const result = await deliverNotice(pendingInvoice, config);
    await writeSummary({ ...result, dryRun: false });
    return result;
  }
  if (decision.action === "nothing_due") {
    const result = { action: "nothing_due", checkpoint: start, nextCutoff: end, dryRun: args.dryRun };
    await writeSummary(result);
    return result;
  }

  const period = { start, end };
  const usage = await fetchGhlSmsUsage(period, config);
  const amountCents = centsForSegments(usage.billableSegments, config.ratePerSegment);
  if (amountCents === 0) {
    if (!args.dryRun) await updateCustomerCutoff(config, end, `mx-detail-sms-zero-usage-${periodKey(period)}`);
    const result = {
      action: args.dryRun ? "would_checkpoint_zero_usage" : "checkpointed_zero_usage",
      period,
      dryRun: args.dryRun,
    };
    await writeSummary(result);
    return result;
  }

  if (args.dryRun) {
    const result = {
      action: "would_create_invoice_and_send_notice",
      period,
      billableSegments: usage.billableSegments,
      amountCents,
      amount: `$${dollars(amountCents)}`,
      notice: noticeBody(usage.billableSegments, amountCents, config.ratePerSegment, period),
      dryRun: true,
    };
    await writeSummary(result);
    return result;
  }

  const invoice = await createDraftInvoice(period, usage, amountCents, config);
  const result = await deliverNotice(invoice, config);
  await writeSummary({ ...result, amount: `$${dollars(amountCents)}`, dryRun: false });
  return result;
}

export {
  NOTICE_WAIT_MS,
  centsForSegments,
  cloudDecision,
  invoicePeriod,
  latestPaidCutoff,
  noticeAgeMs,
  noticeBody,
  parseArgs,
  parsePeriodKey,
  periodKey,
  previousTuesdayMondayWeek,
  smsSegments,
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runCloud(args);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
