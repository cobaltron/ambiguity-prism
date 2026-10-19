# Ambiguity Prism

Detects when one sentence admits more than one valid reading, and shows the
ambiguity as two beams lit at once — which collapse into one as the author rewrites
the sentence to be unambiguous.

Built on **absolute per-reading Nouls**: each candidate reading is its own yes/no
question answered in isolation, so two readings of the same clause can both answer
yes. That multi-yes signature *is* the detector. A relative primitive that forces a
single winner would hide exactly the fork being hunted.

> Detects interpretation ambiguity only. Recall is bounded by the enumerated
> reading set. Raw Noul values are comparative, never probabilities.

---

## Setting the API key

Copy the example file and fill in your key:

```powershell
Copy-Item .env.example .env     # PowerShell
# cp .env.example .env          # bash
```

```ini
TYPESAFE_API_KEY=your-key-here
```

`.env` is gitignored. A shell variable always overrides the file, so
`TYPESAFE_API_KEY=... npm run serve` works without editing anything. Only the
local proxy process reads the key — it is never sent to the page (§12). Keys:
[jevplayground.com/jev-api](https://jevplayground.com/jev-api).

**There is no fallback.** Without a key every entry point fails and prints what to
do. An earlier build substituted an offline rule table so it could run key-less;
that was removed, because the failure mode is a demo quietly showing invented
numbers with `jev-1.13.0` printed next to them.

Confirm it took — `npm run serve` prints what it is actually talking to, with the
key fingerprinted rather than echoed:

```
Ambiguity Prism — http://127.0.0.1:8787
provider: jev  model: jev-1.13.0
endpoint: https://api.typesafe.ai/v1/systemone
env:      C:\...\Ambiguity Prism\.env
key:      sk-l…9f (48 chars)
```

## Status — read this first

The pipeline runs end to end against live `jev-1.13.0`. **It does not work well
enough to make the design document's claim.**

Measured on the hand-written gold set (22 items, stratified half fitted, half
held out), against the real model:

| | Held-out half |
|---|---|
| **Recall** | **20%** — 1 of 5 known-ambiguous clauses caught |
| Precision | 100% — no false alarms on known-clear clauses |

§10 names recall as the honest headline, *because a missed reading is a missed
ambiguity*. 20% is a failure by that standard. Fitting the thresholds does not
rescue it: the fitted pair (`HIGH 0.53 / LOW 0.15`) scores the same 20% on the
held-out half as the shipped defaults. **The dead zone is not the problem — Jev
resolves these clauses.**

| Part | State |
|---|---|
| Mechanism — segmentation, axis routing, lint, dead zone, regimes, entropy severity, cache | **Built and tested** (57 unit tests) |
| Endpoint, auth, request/response shape | **Verified live.** Real calls succeed; `answers[k].noul` reads correctly; 513–623 ms per clause |
| The multi-yes signature itself | **Real, and observed:** modifier attachment forks at `0.84 / 0.72` — sums to 1.56, the non-additivity §2 is built on |
| Forked-vs-clean separation across axes | **2 of 6 axes** (attachment, obligation). Boundary, coordination and reference do not fork |
| Cost | ~400 tokens/clause, not the doc's ~220. Still ≈$0.000017/clause |

`src/provider/jev.js` is the single swap point. Nothing above it knows about the
network; it deals only in `{readingId -> raw noul}`.

`--provider heuristic` still exists as an **explicit** offline test double, used by
the test suite and `prism probe` to exercise the mechanism without burning calls.
Its values are a rule table, labelled `synthetic` in every output, and it is never
selected on your behalf. `prism calibrate` refuses to fit thresholds on it unless
you pass `--allow-synthetic`.

---

## Run it

```bash
npm test                  # 57 tests over the mechanism
npm run probe             # phase-1 exit check: forked vs clean, per axis
npm run analyze           # §9 report over fixtures/requirements.md
npm run serve             # the prism UI at http://127.0.0.1:8787
```

One clause at a time:

```bash
node bin/prism.js clause "The service should retry failed requests up to three times before returning an error."
node bin/prism.js rewrite fixtures/requirements.md 4.2     # the fork, side by side
node bin/prism.js lint                                     # §13 reading discipline
node bin/prism.js dismiss boundary                         # suppress an axis
node bin/prism.js accept fixtures/requirements.md 4.2      # mark reviewed
```

`node bin/prism.js --help` lists every flag.

### What the report looks like

```
requirements.md · 11 clauses · 4 ambiguous · 1 underspecified · 0 uncertain · 5 clear

🔴  §4.2    "...The service should retry failed requests up to th..."   severity 0.81
      ▸ 3 after the first (4 total)                ▓▓▓▓▓▓░░ 0.71
      ▸ 3 in total (2 after the first)             ▓▓▓▓▓░░░ 0.66
      secondary: obligation strength — recommended but optional (0.63) vs mandatory (0.44)
      [ accept ] [ rewrite ] [ dismiss axis: boundary ]
```

Bars, never a quoted percentage. `0.71` and `0.66` sum past 1 on purpose.

---

## How it fits together

```
text ──▶ segment ──▶ route ──▶ [ one batched request per clause ] ──▶ score ──▶ render
         (code)      (code)      Jev: absolute Nouls, in parallel      (code)    (UI/CLI)
```

| File | Owns |
|---|---|
| [src/segment.js](src/segment.js) | sentence split, section labels, requirement detection |
| [src/axes.js](src/axes.js) | **the §4 axis table — swap this file to change domain** |
| [src/route.js](src/route.js) | which axes fire; assembles the reading battery |
| [src/lint.js](src/lint.js) | §13 reading discipline, enforced before anything is sent |
| [src/provider/jev.js](src/provider/jev.js) | the §6 request. The only networking code |
| [src/provider/heuristic.js](src/provider/heuristic.js) | the offline stand-in judge |
| [src/score.js](src/score.js) | dead zone, regimes, entropy severity, hysteresis |
| [src/calibrate.js](src/calibrate.js) | §10 held-out validation |
| [src/review.js](src/review.js) | accept / dismiss persistence |
| [server/proxy.js](server/proxy.js) | holds the key, serves the UI |
| [ui/prism.js](ui/prism.js) | debounce, sequencing, beam reconciliation |

Jev never generates. It only judges an enumerated, reviewable set of readings. All
arithmetic, routing, segmentation and thresholds live in code.

---

## Decisions taken on the open questions (§15)

| # | Question | Taken | Why |
|---|---|---|---|
| 1 | First domain | **Requirements** | the §4 table is already written for it; §11 says swap one file to move |
| 2 | Demo key path | **Local proxy**, with the offline judge as the no-key fallback | the key never reaches the page, and the demo still runs with no key at all |
| 3 | Reading source | **Templates only**, with the artifact loader in place | §5 forbids runtime generation; an unreviewed auto-proposer is a runtime generator with a file in the way. See [docs/proposals.md](docs/proposals.md) |
| 4 | Dead-zone stance | **Favour recall** (`HIGH 0.60 / LOW 0.35`) | a missed reading is a missed ambiguity. `--stance precision` gives `0.72 / 0.45` |

---

## The reading space is light

Light was chosen for the use scene: an author editing a requirements document in
daylight, next to the document itself. There is no dark variant and no toggle;
`color-scheme: light` tells the browser to keep its own surfaces light too.

Inverting the ground changes the material, not the binding. A beam's weight is
still exactly its raw Noul — but on black a lit reading gained **luminance**, and
on paper it gains **ink**:

| | Dark | Light |
|---|---|---|
| A reading the clause supports | glows, full brightness | full ink, saturated, sits down with a real shadow |
| A reading it rules out | fades to black | fades to the colour of the paper |
| Dead-zone reading | dim + out of focus | faint + off-register, like a misprint |
| Severity | halo behind the input | the sheet lifts, scaled by entropy |

Both say *this reading is present* in the only currency the medium has. The
gradient stop at `--noul` keeps the second encoding — inked **length** as well as
density — so the value is legible without comparing two glows.

## Severity

§7 asks for Shannon entropy over the raw, unnormalised Noul vector. A raw vector is
not a distribution, so entropy alone cannot be taken from it directly, and taking
entropy over `v / Σv` would discard the magnitudes — two *dim* evenly-matched
readings would score as severe as two bright ones. The implementation is:

```
severity = sqrt( normalisedEntropy(raw) × secondHighestRaw )
```

The entropy term says how *evenly* forked the readings are; the second-highest raw
Noul says whether the weaker side of the fork is actually lit. Both must be high.
This reproduces the §9 worked example (`0.71 / 0.66 → 0.81`, the doc says `0.82`)
and scores `0.2 / 0.2` at `0.45` rather than at a false maximum. The second-highest
raw value remains available as the scalar proxy the doc suggests.

---

## What the real model actually says

The §9 worked examples, re-run against live `jev-1.13.0` with no cache:

| Clause | Doc's numbers | Measured | Verdict |
|---|---|---|---|
| "…retry failed requests **up to three times**…" | 0.71 / 0.66 → ambiguous | **0.69 / 0.42** | **does not fork.** Jev reads "three times" as three retries *after* the first, and rejects "three in total" |
| "…**shall** return HTTP 404 when the resource does not exist." | 0.93 / 0.05 → unambiguous | **0.94 / 0.03** | reproduces |
| "…shall respond **quickly**…" | 0.90 / 0.88 → underspecified | **0.89 / 0.97** | reproduces |

So the document's flagship demo sentence — the one the whole pitch is built around
— **is not ambiguous to Jev.** Obligation on "should" lands at 0.47 / 0.51: a clean
"undecided", which the dead zone correctly routes to review rather than flagging.

Per-axis, forked clause vs. its rewritten twin:

| Axis | Forked clause | Clean twin | |
|---|---|---|---|
| Modifier attachment | **0.84 / 0.72 — forks** | axis does not fire | ✅ |
| Obligation | 0.53 / 0.31 — dead zone | 0.96 / 0.03 | ✅ |
| Quantifier scope | 0.90 / **0.58** — just misses `HIGH` | does not fire | ✴ near |
| Boundary | 0.75 / 0.40 | 0.86 / 0.12 | ❌ |
| Coordination | 0.74 / 0.22 | 0.93 / 0.08 | ❌ |
| Reference | 0.86 / 0.06 / 0.06 | does not fire | ❌ |

Two readings of this, and the honest answer is probably both:

1. **My gold labels are over-eager.** "compress **or** encrypt" as inclusive-or,
   and "retry up to three times" as three retries, are the standard engineering
   readings. Jev picking them is not obviously an error — it may be *right*, and my
   "ambiguous" label a pedant's view rather than a competent implementer's.
2. **Jev collapses toward one reading** on exactly the axes where ambiguity is
   lexical rather than structural — which is the failure §2 attributes to LLMs and
   expects the absolute Noul to avoid. It demonstrably *does* avoid it on
   attachment, where the fork is structural.

Where that leaves the thesis: the multi-yes signature is real and no Choice could
produce it (1.56 does not normalise), but it fires on **structural** ambiguity, not
on the lexical and scope defects that make up most of the §4 table. A useful next
step is a gold set labelled by someone other than its author, and more probes on
attachment-like structural axes before trusting the others.

## The Noul is not deterministic

Same clause, same reading set, five uncached runs of `quant_wide` on
*"The worker shall archive all records that exceed the retention window."*:

```
0.58   0.61   0.63   0.68   0.81          (quant_narrow held at 0.90 throughout)
```

A ±0.11 spread, straddling `HIGH = 0.60`. The design document does not mention
this, and three things follow that it therefore gets wrong:

1. **A clause's regime can flip between runs** with no edit. `prism probe` scored
   this axis as a FAIL at 0.58 and the document run scored it as a forked PASS at
   0.65 — same code, same clause, different sample.
2. **The §12 cache is not just a cost optimisation.** "Deterministic within the
   cache lifetime" is what makes a report reproducible at all. Re-running with
   `--no-cache` is re-sampling, not re-checking.
3. **Fitting thresholds to two decimal places is false precision.** The gap
   between the fitted `HIGH 0.53` and the shipped `HIGH 0.60` is inside the noise
   for any reading in this band, which is consistent with both scoring the same
   20% on the held-out half.

The dead zone and the asymmetric hysteresis (§7, §8) are the right shape of
defence, and this is the evidence for why they were needed — but hysteresis only
smooths a live editing session, not two separate CLI runs. The honest fix is to
sample a near-boundary reading more than once and take the median, at a multiple
of the cost. **That is not implemented**: it changes the cost model and the cache
key, and it is a decision for the project owner rather than a silent addition.

## Deviations from the design document

0. **§6's response path is wrong.** The doc reads `result.nouls[k].noul`. The live
   API nests answers under `answers`: `{"answers": {"<key>": {"type": "noul",
   "noul": 0.95}}, "usage": {...}}`. Taking the doc literally would have thrown on
   every real call. The reader prefers `answers` and still accepts `nouls`. The
   doc's base URL was also absent; it is `https://api.typesafe.ai`. Real
   `usage.input_tokens` now replaces the character-count estimate when reporting
   cost. The doc's §12 figures for rate limits (1,200 req/min, 250k tok/s), context
   (64k total, 32k state + longest question) and price ($0.042/M input, output
   free) all match the published API.

1. **§9 clause 2 reference readings are not reproduced.** The doc lists
   `Reference: single antecedent 0.90` and `Competing reference 0.04` for *"The API
   shall return HTTP status 404 when the requested resource does not exist."* That
   clause contains no pronoun and only one candidate antecedent before the only
   definite description, so the reference axis correctly does not fire. Making it
   fire would require treating every definite description as anaphoric, which fires
   on almost every requirement sentence. The clause still lands in the documented
   regime (**unambiguous**) via obligation alone.

2. **§9 calls "should" at `0.44 / 0.63` a "secondary obligation ambiguity".** Under
   the doc's own `HIGH = 0.60`, that is one HIGH reading and one dead-zone reading,
   not the two-HIGH signature. This build reports it as a dead-zone axis — *needs
   review* — and `fixtures/clauses.json` records the expectation as `deadzone` with
   the reasoning inline. The doc is internally inconsistent here; the thresholds
   win, because the multi-yes test is the whole mechanism.

3. **The vagueness regime condition is read as written-intent, not literally.** §7
   says underspecified requires "no interpretation reading HIGH", but §9 clause 3
   has obligation HIGH at 0.90 and is still labelled underspecified. Implemented as:
   *no interpretation axis is forked*, plus vagueness HIGH.

4. **Modifier attachment is deliberately conservative.** It is the one axis with no
   reliable surface signal; without a POS tagger a loose pattern reads verbs and
   function words as nouns (`"requested" modifies does`). It now requires a
   determiner-led noun phrase with open-class heads. Missed attachment ambiguities
   are reported under the stated recall bound; false ones would train the author to
   ignore the tool.

5. **Scrub mode (§8, phase-3 flourish) is not built.** Confidence-as-focus and the
   severity halo are. Scrub mode needs a scrolling corpus view that shares nothing
   with the single-clause prism; it was the cheapest thing to leave out.

---

## What is verified, and what is not

**Verified by running it against live `jev-1.13.0`:**

- Real calls succeed. `answers[k].noul` reads correctly; `usage.input_tokens` is
  surfaced; 513–623 ms per clause, inside the sub-1s flow band §8 designs for.
- `prism probe` and `prism calibrate` both run against the model, and both report
  worse results than the design doc implies. Those numbers are above, unedited.

**Verified by running it offline:**

- 57 unit tests: segmentation, triggers, lint, all four regimes, hysteresis in both
  directions, cache key sensitivity, the request shape and endpoint (against a
  stubbed `fetch`), retry policy (429/529 retried, 401/422 not), `.env` precedence,
  raw values surviving unnormalised, the dead zone never passing silently.
- **The endpoint is live.** A deliberately bad key returns a structured
  `authentication_error` from `https://api.typesafe.ai/v1/systemone`, which
  confirms the URL, path, and `Authorization: Bearer` header.
- A failed request renders as `NOT MEASURED`, never as a verdict about the text,
  and exits non-zero.
- `prism probe`: 6/6 axes separate a forked clause from its rewritten twin.
- The collapse **data path**: the worked clause scores `forked`, and its fix scores
  `resolved` with the losing reading at 0.09.
- The proxy's three endpoints, by `curl`.

**Not verified:**

- **Recall against anything but a 22-item set written by one person who knew what
  the detector looks for.** The 20% figure is real but the set is too small and too
  compromised to carry a conclusion on its own.
- **The UI was not rendered in a browser.** The beam logic and the server responses
  that drive it were checked, the stylesheet and markup serve correctly, contrast
  ratios were computed by hand, and the reconciler updates beams in place
  specifically so CSS transitions animate rather than restart — but nobody has
  watched the collapse. That is the phase-2 exit criterion and it remains open.
- Recall against any external corpus. §10's suggested corpora were unverified leads
  in the design doc and remain unverified. `fixtures/goldset.json` is hand-written
  by one person who knew what the detector looks for; its 100% held-out score is
  circular and the output says so.
