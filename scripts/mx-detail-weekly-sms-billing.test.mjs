import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTICE_WAIT_MS,
  centsForSegments,
  cloudDecision,
  invoicePeriod,
  latestPaidCutoff,
  noticeBody,
  parseArgs,
  parsePeriodKey,
  previousTuesdayMondayWeek,
  smsSegments,
} from "./mx-detail-weekly-sms-billing.mjs";

test("counts GSM-7 and Unicode message segments", () => {
  assert.equal(smsSegments("A".repeat(160)), 1);
  assert.equal(smsSegments("A".repeat(161)), 2);
  assert.equal(smsSegments("{".repeat(80)), 1);
  assert.equal(smsSegments("“".repeat(71)), 2);
});

test("rounds the known catch-up charge to cents", () => {
  assert.equal(centsForSegments(2_395, 0.00747), 1_789);
});

test("keeps the notice within the SMS limit", () => {
  assert.match(noticeBody(2_395, 1_789, 0.00747), /\$17\.89/);
  assert.ok(noticeBody(2_395, 1_789, 0.00747).length <= 180);
});

test("calculates the most recently completed Tuesday cutoff in New York", () => {
  const period = previousTuesdayMondayWeek(new Date("2026-08-28T22:00:00Z"));
  assert.deepEqual(period, {
    start: "2026-08-18T04:00:00.000Z",
    end: "2026-08-25T04:00:00.000Z",
  });
});

test("parses legacy period metadata in the billing timezone", () => {
  assert.deepEqual(parsePeriodKey("2026-07-07_2026-07-21"), {
    start: "2026-07-07T04:00:00.000Z",
    end: "2026-07-21T04:00:00.000Z",
  });
});

test("derives the latest paid cutoff from both old and new invoices", () => {
  const invoices = [
    {
      status: "paid",
      metadata: { client: "MX Detail", period_key: "2026-07-07_2026-07-21" },
    },
    {
      status: "paid",
      metadata: {
        billing_workflow: "mx_detail_sms",
        period_start: "2026-07-21T04:00:00.000Z",
        period_end: "2026-07-28T04:00:00.000Z",
      },
    },
  ];
  assert.equal(latestPaidCutoff(invoices), "2026-07-28T04:00:00.000Z");
  assert.equal(invoicePeriod(invoices[0]).end, "2026-07-21T04:00:00.000Z");
});

test("state machine waits 24 hours before charging", () => {
  const pendingInvoice = {
    metadata: { billing_status: "notice_sent", notice_sent_at: "2026-08-25T13:00:00.000Z" },
  };
  assert.deepEqual(
    cloudDecision({
      pendingInvoice,
      start: "2026-08-18T04:00:00.000Z",
      end: "2026-08-25T04:00:00.000Z",
      now: new Date("2026-08-26T12:59:59.999Z"),
    }),
    { action: "wait" },
  );
  assert.deepEqual(
    cloudDecision({
      pendingInvoice,
      start: "2026-08-18T04:00:00.000Z",
      end: "2026-08-25T04:00:00.000Z",
      now: new Date(new Date("2026-08-25T13:00:00.000Z").getTime() + NOTICE_WAIT_MS),
    }),
    { action: "charge" },
  );
});

test("state machine fails closed on an ambiguous notice send", () => {
  assert.deepEqual(
    cloudDecision({
      pendingInvoice: { metadata: { billing_status: "notice_sending" } },
      start: "2026-08-18T04:00:00.000Z",
      end: "2026-08-25T04:00:00.000Z",
    }),
    { action: "manual_review" },
  );
});

test("live mode requires the explicit environment lock", () => {
  const before = process.env.MX_DETAIL_BILLING_ENABLED;
  delete process.env.MX_DETAIL_BILLING_ENABLED;
  assert.throws(() => parseArgs(["cloud", "--live"]), /Live billing is locked/);
  process.env.MX_DETAIL_BILLING_ENABLED = "true";
  assert.equal(parseArgs(["cloud", "--live"]).live, true);
  if (before === undefined) delete process.env.MX_DETAIL_BILLING_ENABLED;
  else process.env.MX_DETAIL_BILLING_ENABLED = before;
});
