# `/research` — on-demand protocol research (Platinum)

A Platinum-only command on the **Liège Alerts** bot. Give it anything that
identifies a protocol and it returns a TL;DR followed by a sourced report:
mechanism, fees, supply, rewards, admin powers, security, the project's own
documentation checked against its deployed bytecode, and an explicit list of what
it could not answer.

**Last updated:** 2026-10-01 (two subject shapes; repo-as-docs; multi-input)

---

## 1. Using it

**More than one input is normal.** People hand over what they have — an address
*and* the repo, or a site *and* its docs. The address takes the subject slot
because it anchors the chain reads; every other token becomes a hint that
short-circuits a discovery step, and the coverage block records it:

```
/research FUuH1auf…fvR3 https://github.com/org/repo
```


```
/research 0x47ACCD13264D8F954105256FaaC8376ce6A55999   contract address (EVM)
/research <solana mint>                                SPL token or program
/research sender.family                                website
/research https://sender.family/docs                   docs page
/research github.com/uniswap/v4-core                   repository or org
/research hyperliquid                                  name / ticker
```

Entitlement is `FEATURE.RESEARCH` in
[`alerts-bot.ts`](../../src/lib/telegram/alerts-bot.ts), Platinum only. A Gold
user who guesses the command gets `🚧 Coming soon.` — the settled rule that a Gold
user must not be able to infer which features exist behind the tier line (see
`docs/private/alert-bot-feature-inventory.md`). `/help` appends the command only
for entitled chats, and the command menu is registered per chat with
`setMyCommands` + `BotCommandScopeChat`, so it never appears in a Gold user's
autocomplete.

One run at a time per chat. A run takes 6–60 seconds depending on how much
documentation the project publishes.

---

## 2. Two kinds of subject

The command covers two populations, because they need different reports:

| Shape | What it is | What the report leads with |
|---|---|---|
| `protocol` | Crypto-native, with a mechanism of its own: fees, supply policy, rewards, admin powers, contracts | the mechanism, checked against the deployed code |
| `project-with-token` | Software that stands on its own, with a token attached | what the software does, and that the token is a **separate object** with no mechanism |
| `token-only` | A token with no docs, repo or site | the market data, and the fact that nothing documents it |

Classification is evidence-based, in `profile.ts`. A subject is `protocol` only
when **two or more mechanism topics appear in crypto context**, or its docs
publish contract addresses.

The "in crypto context" clause is load-bearing. `fee`, `supply`, `token` and
`burn` are ordinary English and ordinary ML jargon: an AI-research repo with a
GPU hosting plan ("*Cost math — if fees are lower than that, run the pod only
during live sessions*") and LLM tokens ("*110 tokens under each framing*") was
classified crypto-native on the first pass, and printed a protocol report about a
project with no protocol. So a mechanism sentence only counts if that sentence
itself carries a crypto term, and the document as a whole must carry at least
three distinct ones.

### Naming an attached token for what it is

`token-shape.ts` answers "what is this token mechanically" independently of what
it is attached to, from three signals it then prints:

1. **The venue** — DexScreener's `dexId` names the launchpad (`pumpfun`,
   `pumpswap`, `launchlab`, `moonshot`, `fourmeme`, `clanker`…).
2. **The address** — launchpads vanity-grind their mints (`…pump`, `…bonk`).
3. **The shape** — 1,000,000,000 supply at 6 decimals with both authorities
   revoked is pump.fun's fingerprint, not a coincidence.

Custom code outranks all three: an owner, a mint path or a pause switch means it
is not a stock mint whatever venue it trades on.

In project mode the TLDR then leads with the line that matters most to someone
about to buy:

> ⚠️ **Token ≠ project.** This is a pump.fun-style token — a stock launchpad mint
> with no contract, fees, emissions or governance of its own, attached to
> **ai-torture-chamber**, which describes itself as: "Steering language models
> into strong negative and positive valence states…". The project's own
> repository never mentions a token, so the association comes from the token's
> metadata and socials rather than from the project itself.

That last clause is its own check: the repo is searched for any crypto reference,
and a project that never mentions a token gets a **high** flag saying the
association is unverified. "token" alone does not count — in an ML repo it is a
unit of text.

---

## 3. What it actually does

```
                    ┌─────────────────────────── classify.ts
   user input ──────┤  evm-address · solana-address · url-github ·
                    │  url-docs · url-whitepaper · url-article ·
                    └─ url-website · query
                                │
          ┌─────────────────────┼──────────────────────┐
          ▼                     ▼                      ▼
    DexScreener            RPC + explorer          CoinGecko
  chain, market,        supply, owner, proxy,    homepage, whitepaper,
  websites, socials     bytecode selectors,      repos, X handle,
                        verified source name     categories, followers
          └─────────────────────┬──────────────────────┘
                                ▼
                        docs discovery (docs.ts)
                given → link → probe → external link
                                ▼
                     crawl (≤8 pages, budgeted)
                                ▼
                     extract.ts — 14 topic buckets
                                ▼
                   verify.ts — docs vs deployed code
                                ▼
                    report.ts — risk flags, no score
                                ▼
                  render.ts — TLDR + numbered pages
```

The order is the point. The address stage produces a website, the website stage
produces the docs, and the docs are what the chain then gets checked against —
so `/research <ca>` and `/research <docs url>` converge on the same report,
entering the graph at different points.

### Finding the docs

Four routes, tried in order, and the report names which one worked:

| Route | How |
|---|---|
| `given` | the user passed a docs or whitepaper URL |
| `link` | a link on the project's own site, scored for docs-ness (`docs.` subdomain, `/docs` path, GitBook/Mintlify/ReadMe hosts, anchor text), with depth penalised and blog/legal paths excluded |
| `probe` | the conventional locations: `/docs`, `/documentation`, `/developers`, `/whitepaper`, `/litepaper`, `/learn`, plus `docs.<apex>` and `developer.<apex>` |
| `external` | a docs or whitepaper link published on CoinGecko or in the repo |
| `repo` | **the repository itself** — README, `docs/*.md`, and root files named like specs (WHITEPAPER, TOKENOMICS, ARCHITECTURE…) |

A candidate is only accepted if the page **reads** like documentation
(`looksLikeDocs`: ≥800 chars, and either ≥3 headings or ≥3 reference words).
Single-page apps answer 200 for everything, so "the URL resolved" proves nothing.

The `repo` route exists because a code-first project publishes no docs site: its
README **is** the specification. The first version skipped the docs stage entirely
for want of a homepage, which scored a self-documenting project as undocumented —
exactly backwards. It also runs when a docs site was found but turned out to be a
stub, since a 900-character landing page should not outrank a real README.

Reading Markdown needed three fixes that HTML never exposed:

- **Hard wrapping.** Markdown wraps prose at 72–80 columns, so one sentence
  arrives as three lines. Every quote was truncated mid-clause until consecutive
  prose lines were joined into paragraphs.
- **Bullet continuations.** An indented line under a bullet belongs to that
  bullet, not to a new paragraph.
- **The banner line.** READMEs open with "Live: example.com — …" before the
  sentence that says what the project does, so the lead-paragraph rule skips
  label-and-colon openers and lines whose first breath is a domain.

Only the **first** page may supply the lead description, and only its sentences
carry extra authority for "what is this for". Letting every file claim a lead let
`docs/x_handles.md` and `docs/repo_hosting.md` — notes about hosting and a Twitter
dogpile — answer the question instead of the README. For the same reason the
README gets first refusal on every TLDR slot.

Two details that matter in practice:

- **SPA payloads.** Next.js sites frequently ship their docs URL only inside a
  script payload, never in an `<a href>`. `extractUrlsFromText` mines those, so a
  site with perfectly good docs does not read as having none.
- **Nav dedup is scoped.** Repeated nav lines are collapsed only *before* the
  first heading. A global dedup of short lines eats content — a fee table's
  `Protocol` label is also a nav entry, and dropping it leaves `6% of trading
  fees` with nothing to attach to.

### Reading the docs

`extract.ts` is the research framework, encoded. It buckets sentences into 14
topics — the union of the standard token/protocol due-diligence checklists
(supply and allocation, emissions against demand, value capture, admin powers,
audit status, upgradeability, custody, stated risks, external dependencies) plus
one this bot treats as first class:

> **Negative guarantees** — the sentences that say what *cannot* happen ("no mint
> function", "the owner cannot withdraw locked liquidity", "fixed at launch and
> can never change"). They are the only claims a reader can check against
> bytecode, and they are what §3 then checks. A report that quotes the features
> and skips the constraints has copied the marketing.

Extraction is **deterministic and quoting-only**: keyword and pattern rules over
the docs text, never paraphrase. Every sentence a report prints is a sentence the
project wrote, attached to the URL it came from. No LLM sits in this path, which
is deliberate — a summariser that rewrites claims can invent one, and an invented
claim about someone's money is the failure mode this feature cannot have.

Headline numbers are pulled separately, and docs lay them out as two-column
tables that strip into label/value line pairs:

```
$SEND burn
24% of trading fees, plus half of every launch fee
```

so each line is also tested with the short line above it prepended — the table
row, reassembled. A reassembled row outranks a prose mention, because prose
rounds shares together ("30% goes to the burn and the protocol" is two shares
added). Values print with the line they were read from, so a wrong parse is
visible rather than silent.

---

## 4. Docs vs deployed code

The section that separates this from a summary of someone's website. Five checks,
each a claim made in prose that the chain answers in bytecode:

| Docs claim | Checked against |
|---|---|
| "no mint function", "fixed supply" | mint selectors in the deployed bytecode; on Solana, the SPL mint authority |
| a stated supply figure | `totalSupply()`, scaled by `decimals()` |
| "no owner" | whether `owner()` answers |
| "immutable", "cannot be upgraded" | EIP-1167 clone pattern in the code, EIP-1967 implementation slot |
| pausability | pause/unpause selectors |

Wording rules, because being wrong here is expensive:

- Selector **absence is proof** — code with no mint selector cannot mint.
- Selector **presence is not proof of reachability** (it may sit behind a check
  that always reverts), so it is reported as "the bytecode contains", and it is a
  mismatch only where the docs claimed the function does not exist.
- A claim we cannot test returns `unverifiable` **and says why**. A liquidity
  lock, for instance, needs the locker's withdrawal paths read — a source review,
  not a state read — so the report says so instead of implying a pass.

Anything the chain contradicts is promoted to the top of the risk register and
into the TL;DR.

---

## 5. Risk flags, and why there is no score

`report.ts` emits a flat list with three severities — `high` (could cost the
position outright), `medium` (materially changes the risk, or a gap where a claim
should be), `info` (worth knowing, including the project's own disclosures).

There is deliberately **no grade**. A single letter implies the inputs are
commensurable, and "unaudited" and "thin liquidity" are not two units of the same
thing. Someone deciding whether to size a position needs the list, not an average
of it.

Gaps are flags too: every framework bucket that produced no evidence becomes an
explicit open question. "No audit statement anywhere" reads very differently from
a documented "unaudited", and the report keeps the two apart.

---

## 6. Budget, failure and coverage

One wall-clock budget for the whole run (default 110s), each fetch with its own
timeout, nothing retried more than once. A host that answers 403/429/451 is
recorded as blocked and not asked again — a WAF or geo block is a property of the
host, not of the request.

Every source reports `ok` / `empty` / `failed` / `skipped` with a reason, and the
report prints the coverage block. This mirrors the alert feeds' health model: a
skipped source must never look like a clean check.

---

## 7. Sources, and what is missing

| Source | Gives | Key |
|---|---|---|
| DexScreener | chain, price, FDV, liquidity, volume, pair age, the token's own website/social links | none |
| CoinGecko | homepage, whitepaper, repos, X handle + follower count, categories | optional `COINGECKO_API_KEY` (rate limit only) |
| Public RPCs | supply, owner, decimals, bytecode selectors, proxy slot | none — rotated on failure |
| Blockscout | verified source name, proxy, deployer, holder count (eth / base / RH) | none |
| BscScan / BaseScan | verified source name and proxy where Blockscout is not used | existing `BSCSCAN_API_KEY`, `BASESCAN_API_KEY` |
| Project docs | everything about the mechanism | none |
| GitHub | liveness (`pushed_at`), stars, license, `docs/` `audits/` `tests/` | optional `GITHUB_TOKEN` (rate limit only) |

**Not covered, and stated as such in the report:**

- **X/Twitter content.** Reading what is being said about a contract address needs
  an X API key this bot does not hold. The report links a live X search for the
  address and says plainly that it did not read it, rather than implying it did.
- **PDF whitepapers.** Recorded as existing, not parsed.
- **Holder concentration.** Holder *count* comes from Blockscout where available;
  a top-holder distribution is a separate call chain and is not in this version.
- **Token unlock calendars.** Only what the docs state about vesting is reported.

---

## 8. Testing it

```bash
# print to stdout, nothing sent
npx tsx scripts/test-research-report.ts 0x47ACCD13264D8F954105256FaaC8376ce6A55999

# deliver to ALERTS_PLATINUM_IDS through the alerts bot
npx tsx scripts/test-research-report.ts sender.family --send

# knobs
npx tsx scripts/test-research-report.ts <input> --pages 12 --budget 180 --json
```

The script reads only: no seen-sets, no cursors, no database rows.

---

## 9. Files

| File | Role |
|---|---|
| [`research/classify.ts`](../../src/lib/research/classify.ts) | what the user gave us |
| [`research/fetcher.ts`](../../src/lib/research/fetcher.ts) | budgeted fetch, HTML → text, link mining |
| [`research/sources/docs.ts`](../../src/lib/research/sources/docs.ts) | docs discovery and crawl |
| [`research/sources/onchain.ts`](../../src/lib/research/sources/onchain.ts) | EVM + Solana state, explorer enrichment |
| [`research/sources/coingecko.ts`](../../src/lib/research/sources/coingecko.ts) | the link graph |
| [`research/sources/github.ts`](../../src/lib/research/sources/github.ts) | repo liveness |
| [`research/extract.ts`](../../src/lib/research/extract.ts) | the framework: topics, metrics, TLDR, gaps |
| [`research/verify.ts`](../../src/lib/research/verify.ts) | docs vs deployed code |
| [`research/report.ts`](../../src/lib/research/report.ts) | risk synthesis |
| [`research/render.ts`](../../src/lib/research/render.ts) | Telegram HTML, TLDR + pagination |
| [`research/index.ts`](../../src/lib/research/index.ts) | the orchestrator |
| [`telegram/commands/research.ts`](../../src/lib/telegram/commands/research.ts) | the command handler |
