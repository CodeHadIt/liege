# Liège Documentation

All project documentation lives here. The only Markdown file kept outside this
folder is the root [`README.md`](../README.md), which stays put because GitHub
renders it as the repository landing page.

## Alerts

How the Liège Alerts bot's push feeds work, per chain.

- [**Alert system**](alerts/alert-system.md) — the granular reference. Covers
  both families: the launch feeds (StonkFun, Sunrise, Robinhood Chain, BNB
  Chain), which watch platforms, and the alpha feeds (wallet confluence, the
  daily ATH scan, deployer alerts), which watch people.

> This file is kept in step with the code. When a change to alert behaviour is
> settled and accepted, update it in the same commit.

## Features

Deep dives on non-alert parts of the app.

- [Dex Orders — data flow](features/dex-orders-flow.md)
- [Dune SQL — Pump.fun deploys](features/dune-query-all-deploys.md)

## Reference

Schemas for third-party data the app consumes.

- [GMGN address page](reference/gmgn-address-schema.md)
- [GMGN top traders](reference/gmgn-top-trader-schema.md)
- [GMGN scraper fields](reference/gmgn-scraper-fields.md)
