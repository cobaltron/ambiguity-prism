# Offline reading proposals (§5, source 2)

Templated axes cover structured defects. Free-text clauses need readings that no
template predicts. §5 allows an LLM to propose those readings **once, offline**,
with its output stored as a reviewable artifact — *never* generated at runtime.

This build therefore ships **no runtime generation path at all**. `src/proposals.js`
only reads a reviewed artifact. That is deliberate: a generation call on the hot
path would reintroduce exactly the failure §2 rules out, where a model's reasoning
collapses toward one interpretation and the fork is lost.

## Schema

```json
{
  "entries": [
    {
      "clause": "The coordinator must settle the balance before the window closes.",
      "reviewedBy": "your-name",
      "reviewedAt": "2026-10-04",
      "readings": [
        {
          "id": "settle_transfer",
          "label": "settle = transfer the funds",
          "instructions": "Read the sentence literally, with no charity and no outside context. Does the sentence require the funds to be transferred before the window closes?"
        },
        {
          "id": "settle_reconcile",
          "label": "settle = reconcile the ledger",
          "instructions": "Read the sentence literally, with no charity and no outside context. Does the sentence require the ledger entries to be reconciled before the window closes?"
        }
      ]
    }
  ]
}
```

Pass it with `prism analyze <file> --proposals proposals.json`.

## Rules the loader enforces

| Rule | Why | Enforced by |
|---|---|---|
| `reviewedBy` must be present | an unreviewed set defeats the entire point of the artifact | `loadProposals` returns `[]` without it |
| at least two readings per entry | one reading cannot show a fork | `route()` drops the axis |
| flat, direct, one hop | Jev's indirection weakness punishes nesting (§13) | `lintReading` |
| no negation | double negatives are answered badly | `lintReading` |
| no unquoted `and` / `or` | a conjunction bundles two readings into one Noul (§6) | `lintReading` |
| one `?` only | one judgement per Noul (§6) | `lintReading` |

A reading that fails lint is **dropped and reported**, not sent. `prism analyze`
prints `lint: dropped "<label>" — <reason>` so a bad artifact is visible rather
than silently degrading recall.

## Review checklist for a human

1. Does each reading describe a state of the world an implementer could **act on
   differently**? If two readings imply the same code, they are not a fork.
2. Is each reading true to the words as written, with no charity?
3. Could a reading be answered yes for a reason unrelated to the ambiguity? If so,
   it will light up on clean clauses and cost precision.
4. Are the readings mutually exclusive? A fork between two readings that can both
   legitimately hold is not an ambiguity.
5. Is the phrasing single-hop? If you need a comma and a subordinate clause to say
   it, split it or drop it.

## Why the proposal step is not automated here

§15.3 leaves this open: templates only for the MVP, or wire the offline proposal
step in phase 1. This build chose **templates only**, with the loader in place, so
that the artifact can be added without touching anything else. The honest reason:
an automated proposer whose output nobody reviewed would quietly become a runtime
generator with an extra file in the way.
