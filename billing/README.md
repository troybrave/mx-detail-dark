# MX Detail SMS Billing

The GitHub Actions workflow in `.github/workflows/mx-detail-sms-billing.yml` reconciles MX Detail SMS billing in the cloud. It runs twice daily so a delayed GitHub cron does not strand the weekly cycle, but the Stripe-backed state machine permits only one notice and one charge per billing period.

## Weekly cycle

1. After Tuesday 12:00 AM America/New_York, measure HighLevel SMS usage from the last paid cutoff through the newest completed Tuesday cutoff.
2. Create a draft Stripe invoice with the billing period, segment count, amount, and state in metadata.
3. Mark the invoice `notice_sending`, send the notice through Twilio, then mark it `notice_sent` with the accepted-message ID and timestamp.
4. On a later run at least 24 hours after the notice, finalize and pay the same invoice.
5. Store the paid cutoff on the Stripe customer so the next period starts exactly where the last one ended.

Stripe idempotency keys protect invoice creation, invoice items, finalization, payment, and metadata updates. Twilio's standard message-create endpoint does not provide equivalent idempotency, so an interrupted `notice_sending` state fails closed and opens a GitHub issue for manual review.

## Live lock

The repository variable `MX_DETAIL_BILLING_ENABLED` is the independent live lock:

- `false`: scheduled and manual runs are read-only dry runs.
- `true`: scheduled runs may send the notice and charge after the 24-hour wait.

A manual `live` dispatch also refuses to proceed unless the repository variable is `true`.

## Configuration

GitHub repository secret:

- `DOPPLER_TOKEN`: read-only service token scoped to Doppler `endless-winning/prd`.

Doppler secrets consumed at runtime:

- `GHL_MXDETAIL_PIT`
- `STRIPE_ENDLESS_WINNING`
- `TWILIO_EW_SID`
- `TWILIO_EW_AUTH`
- `MX_DETAIL_BILLING_FROM_PHONE`
- `MX_DETAIL_BILLING_NOTICE_TO`

GitHub repository variables:

- `MX_DETAIL_BILLING_ENABLED`
- `MX_DETAIL_GHL_LOCATION_ID`
- `MX_DETAIL_STRIPE_CUSTOMER_ID`
- `MX_DETAIL_SMS_RATE`
- `MX_DETAIL_BILLING_BOOTSTRAP_START`

## Local verification

```bash
node --test scripts/mx-detail-weekly-sms-billing.test.mjs

doppler run --project endless-winning --config prd -- \
  node scripts/mx-detail-weekly-sms-billing.mjs cloud --dry-run
```

Custom period checks are dry-run only:

```bash
doppler run --project endless-winning --config prd -- \
  node scripts/mx-detail-weekly-sms-billing.mjs cloud --dry-run \
  --start 2026-07-21T04:00:00.000Z --end 2026-08-29T04:00:00.000Z
```

Do not enable live billing until the GitHub-hosted dry run succeeds and its period, segment count, and amount have been reviewed.
