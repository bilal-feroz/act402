# Act402

**Give AI agents a browser they can actually control.**

Act402 is browser execution infrastructure for autonomous agents, sold per call over x402 on the XDC AI marketplace. Your agent sends a website and a list of browser actions; Act402 runs them in a real Chromium session and returns structured JSON with screenshot evidence.

> Scrapers read websites. Act402 operates them.

```bash
curl -X POST https://<your-deployment>/act \
  -H "content-type: application/json" \
  -d '{
    "url": "https://example.com",
    "actions": [
      { "type": "click", "target": { "text": "Learn more" } },
      { "type": "extract", "selector": "body" },
      { "type": "screenshot" }
    ]
  }'
```

Full documentation: `GET /docs` on a running deployment, `GET /capabilities` for machine-readable details. (Detailed README in progress.)
