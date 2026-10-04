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
  **The launch feeds (§3–§8) were retired on 2026-10-05** — code kept, delivery
  off, restored with `ALERTS_STOCK_FEEDS=on`. See §15.5. The alpha feeds, the
  monitoring watchdog and `/research` are live.

> This file is kept in step with the code. When a change to alert behaviour is
> settled and accepted, update it in the same commit.

## Features

Deep dives on non-alert parts of the app.

- [`/research` — on-demand protocol research (Platinum)](features/research-command.md)
  — how the command resolves an address/URL/repo into a sourced report, checks a
  project's docs against its deployed bytecode, and tells a protocol apart from a
  project with a launchpad token bolted on
- [Dex Orders — data flow](features/dex-orders-flow.md)
- [Dune SQL — Pump.fun deploys](features/dune-query-all-deploys.md)

## Research

One-off investigations, kept because the derivation is the value.

- [Send protocol — QUANT's QNT holder rewards](research/send-protocol-holder-rewards-quant.md)
  — why a sender.family holder-reward market pays nothing until someone calls
  `collect`, traced against a working market
- [StonkFun — Airdrop Mode](research/stonkfun-airdrop-mode.md)
- [StonkFun — H6qOWZ4 funding evidence](research/stonkfun-h6qowz4-funding-evidence.md)
- [Robinhood Chain — $2M ATHs over 60 days](research/rh-ath-2m-60d.md)
- [Robinhood Chain — $5M coins, two weeks](research/rh-5m-coins-two-weeks.md)
- [Schiff ep. 746 — Shiba Inu and memecoins](research/schiff-ep746-shiba-inu-memecoins.md)

## Reference

Schemas for third-party data the app consumes.

- [GMGN address page](reference/gmgn-address-schema.md)
- [GMGN top traders](reference/gmgn-top-trader-schema.md)
- [GMGN scraper fields](reference/gmgn-scraper-fields.md)
