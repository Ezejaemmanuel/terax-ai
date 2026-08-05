# Summarization contract

How a summarizer agent is fed, and what it is allowed to say. This is a design
contract, not a component: it applies wherever a Terax surface hands records to
a model and asks for a summary (agent transcripts, query results, log windows).

The motivating case: a tool returns 50 transactions and reports "300
remaining". What goes into the summarizer?

## 1. Summarize the full set, never the visible page

Summarize every record in scope, not the page that happened to come back.

A page boundary is a transport artifact. It is set by whatever limit the caller
passed, so a summary built from one page silently answers a different question
than the one asked ("your 50 most recent transactions" instead of "your
transactions"), while reading as though it answered the original. Nothing in the
output distinguishes the two, which is what makes it dangerous rather than
merely incomplete.

So the retrieval loop drains the set first, then summarizes. If draining is
impossible (the set is unbounded, or a hard budget stops it), the scope
reduction must be a *stated* one — "transactions since 1 June", not "the first
50 that fit".

## 2. "300 remaining" is a control signal, not context

Pagination metadata — `remaining`, `nextCursor`, `hasMore`, `totalPages` — is
addressed to the retrieval loop. It must not reach the summarizer's context.

A model that sees "300 remaining" writes about the 300. It hedges ("based on the
available subset..."), speculates about what the rest might contain, or invents
proportions for it. The retrieval loop consumes those fields and drops them; the
summarizer receives records and a coverage frame that already states, in plain
terms, what the record set is.

## 3. One pass while it fits; a deterministic fold when it does not

| Records fit in | Strategy |
| --- | --- |
| under ~25-30% of the context window | single pass over the whole set |
| more | map-reduce fold |

The threshold is well under the window because the records are not the only
occupant: the envelope, the instructions, and the output itself all need room,
and quality degrades before the hard limit does.

The fold is deterministic and structural, never opportunistic:

1. **Partition** on a natural key (time bucket, account, file, session), not on
   "whatever filled 100k tokens". A partition that means something produces
   partial summaries that compose; an arbitrary cut produces overlap and gaps.
2. **Map**: summarize each partition against the same output contract as a
   single pass, and carry its aggregates forward as numbers.
3. **Reduce**: fold the partial summaries. The reducer sees partials and
   aggregates, never raw records again.

Partition boundaries are recorded so a fold is reproducible. Two runs over the
same records produce the same partitions.

## 4. Aggregates are computed in code and quoted, never recomputed

Every number a summary depends on — counts, sums, min/max, date range, per-
category totals — is computed in code before the model is called, and passed in
as authoritative facts.

The model quotes them. It never adds, averages, or re-derives, and it never
recounts records to check. Arithmetic over a long record list is exactly where a
language model fails quietly, and a wrong total in a confident summary is worse
than no summary.

Under a fold, this rule is what keeps the reduce step honest: totals come from
code over the whole set, so a partial summary cannot skew them.

## 5. The context envelope

Eight slots, in this order. The order matters: the frame is set before the
records arrive, so the model reads them as an instance of a known shape.

| Slot | Carries | Why |
| --- | --- | --- |
| 1. Intent | The question the summary answers, and who reads it | A summary with no addressee becomes a description of the data instead of an answer |
| 2. Record schema | Field names, units, currency, timezone, enum meanings | Prevents inferring "amount" as dollars when it is cents |
| 3. Coverage frame | What set this is, in plain language, and how it was selected | The one slot allowed to describe scope. Replaces every pagination field |
| 4. Authoritative facts | Code-computed aggregates, marked "quote, do not recompute" | Rule 4 |
| 5. Running state | Under a fold: partial summaries and aggregates so far | Gives the reducer continuity without raw records |
| 6. Output contract | Shape, length, required sections, what may not be claimed | Makes output comparable across runs and foldable |
| 7. Retrieval affordance | How to ask for a specific record, if the surface allows it | Lets the model reference detail instead of guessing at it |
| 8. Records | The records themselves, last | Nearest the generation point, and the only slot that grows |

## 6. Coverage is stated in the output

The summary itself says what it covered: the record count, the range, and any
stated scope reduction. Not as a disclaimer paragraph — as one line of the
contracted output shape.

A summary that cannot be checked against its own scope gets quoted downstream
as though it covered everything. This line is what makes the difference between
partial and complete legible to whoever reads it later.

## Applying this to a paged tool result

The transactions case, end to end:

1. The retrieval loop pages until the set is drained, keeping `remaining` and
   the cursor to itself.
2. Code computes the aggregates over all 350 records.
3. If the records fit, one pass. If not, partition by month, map, reduce.
4. The envelope is assembled in order, with slot 3 reading "all 350
   transactions on account X between 1 April and 30 June" and slot 4 carrying
   the totals.
5. The output opens with its coverage line, quotes the totals verbatim, and
   describes patterns in its own words.
