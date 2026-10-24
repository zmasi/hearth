# Phase 13 machines: public fields and guarded pins

Implementation: **integrated with causal physics**. Release status is recorded separately. Extends live Phase 13. Constitution 3.1 is unchanged. Join, equality, and judgment stay as `VISION.md`. This is not a kernel taxonomy of objects, not a JS/`vm` host, and not Antigravity's physical environment.

## What is present

A pin may still compose existing world actions. It may also name bounded **mechanism ops** that read and write a public `fields` bag on a live thing or place in the caller's current room:

| op | effect |
|---|---|
| `set` | write a boolean, integer, or string |
| `add` | add a whole number; a missing integer register starts at 0 (write path only) |
| `clear` | delete a field; an empty bag is omitted |
| `push` | append a scalar to a list |
| `when` | if the comparison fails, skip the rest of this perform and keep earlier steps |
| `require` | if the comparison fails, fail the perform and roll every step back |
| `actuate` | checked physical action, using `field` as operation name and `of`/`to` as target/value |

Comparisons (exactly one per guard): `eq`, `ne`, `lt`, `gte`, `exists`, `len_gte`. `of` names another live thing or the current place **in this room**. `bag` is `fields` (default) or `physical`.

Owners standing on their own thing or land may `adjust` fields directly (`set`/`add`/`clear`/`push`). Visitors change state through pins under the current place's `use_thing` permission. Observation does not write fields.

Legacy linear pins are unchanged. Missing `fields` is not backfilled.

## Bounds (mechanical, not moral)

- Instruction count and JSON bytes stay Phase 13: 1–16 steps, 8192 bytes.
- At most 32 fields per target; field names `[a-z][a-z0-9_]{0,31}`.
- Integers in `[-1e9, 1e9]`; strings ≤256 UTF-8 bytes; lists ≤32 scalars; bag JSON ≤4096 bytes.
- Kernel does not interpret field names. `open` is not a weir type.

## Fail-closed reads

A missing mechanism field is missing. `require` of `eq 0` or `gte 3` on a missing field fails; it is never a silent zero. `when` on a missing field skips the rest.

`bag: "physical"` reads the real permission-aware physical sensor namespace at the request UTC instant. Missing or unavailable sensors fail closed (`guard_failed`). Programs cannot `set`/`add`/`clear`/`push`/`adjust` the physical bag. `actuate` invokes the checked physical action and never writes sensor bags directly.

A field on a thing in another place is not nearby. Destroyed targets leave pins inert, same as Phase 13.

## Identity and rights

Perform still runs as the caller. Inner `destroy`/`make`/`say` still check that caller's local doors. Scripts cannot borrow the pin author, trap `go_home`, read or write private memory, or eval.

## Proofs in this branch

Synthetic HTTP tests (no live city):

- Multi-resident weir: two cranks leave `charge` without `open`; the third lifts the gate; `spill` then makes a wet stone; destroying the weir removes the mechanism and leaves the stone.
- Two-handle pump: `draw` requires both handles, then yields water and resets.
- A later inner 404 rolls field edits back.
- Owner `adjust`; visitor denied; unavailable physical `require`; unknown actuator refusal; ignite-style pins still work.

## Integrated physical seam

The handler supplies the real sensor and actuator adapters, bound to the caller
and one request instant captured after the row lock. Both actuator forms work:
`{do:"actuate", field:"set_sluice", of:"$target", to:"0.5"}` and
`{do:"actuate", targetId:"$target", name:"set_sluice", body:"0.5"}`.
`physical` remains read-only. A program changing `fields.open` commits elapsed
physics before the change, and a later failure rolls all effects back.
See [the physical contract](CAUSAL-PHYSICS.md) for gates, coupling, numerical
limits, the public-map asymmetry and recovery. No private notebook capability
is added to scripts.

## Absent on purpose

Loops, delays, nested `perform`, scheduled future actions, expressions, JavaScript, host I/O, private memory, writing sensors, silent zero for missing sensors, content-judging kinds.
