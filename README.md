# Act402

Real Chromium browser for autonomous AI agents, sold per call over x402 on the XDC AI marketplace.
The calling agent is the brain; Act402 is the browser.

## Endpoints

| Method | Path | Price |
| --- | --- | --- |
| GET | `/health` | free |
| GET | `/capabilities` | free |
| POST | `/act` | $0.50 USDC (x402) |

## POST /act

```bash
curl -X POST https://<host>/act -H "content-type: application/json" -d '{
  "url": "https://example.com",
  "actions": [
    { "type": "click", "target": { "text": "Learn more" } },
    { "type": "extract", "target": { "selector": "body" } },
    { "type": "screenshot" }
  ]
}'
```

Actions: `navigate`, `click`, `type`, `select`, `scroll`, `wait`, `extract`, `screenshot`.
Targets: `selector`, `text`, `role` + `name`, `label`, `placeholder`.

Response:

```json
{
  "success": true,
  "task_id": "act_...",
  "final_url": "https://www.iana.org/help/example-domains",
  "actions_executed": 3,
  "result": { "text": "..." },
  "duration_ms": 2934,
  "evidence": [{ "type": "screenshot", "url": "https://<host>/evidence/act_.../screenshot-1.png" }]
}
```

Failures return a non-2xx status with `error.code` (e.g. `TARGET_NOT_FOUND`, `BLOCKED_URL`, `TIMEOUT`,
`SITE_BLOCKED_AUTOMATION`), so the x402 gateway never charges for them.

## Limits and safety

- 20 actions, 60 s, 3 screenshots per task; 2 concurrent browser contexts (one shared Chromium, isolated context per task).
- SSRF protection: localhost, private ranges, metadata endpoints, `file:`/`javascript:` and redirects to them are blocked (all browser traffic goes through a validating egress proxy).
- No purchases, payments, transfers, deletions, sign-ups, password entry, or CAPTCHA bypass.
- No database: task state in memory; screenshots on local disk, deleted after 24 h.

## Run

```bash
npm ci
npx playwright-core install chromium   # local dev only; Replit uses Nix chromium (see .replit)
npm run build && npm start
npm test
node scripts/smoke.mjs http://localhost:3000
```

Optional env: `ACT402_GATEWAY_SECRET` (when set, `/act` requires header `X-Act402-Key` — configure the same value as the
upstream auth in the XDC AI Gateway), `APP_BASE_URL`, `MAX_ACTIONS`, `MAX_TASK_DURATION_SECONDS`, `MAX_SCREENSHOTS`,
`MAX_BROWSER_SESSIONS`, `CHROMIUM_PATH`.
