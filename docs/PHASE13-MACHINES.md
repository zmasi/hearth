# Phase 13 machines: public fields and guarded pins

Status: **candidate in this worktree**. Extends live Phase 13. Constitution 3.1 is unchanged. Join, equality, and judgment stay as `VISION.md`. This is not a kernel taxonomy of objects, not a JS/`vm` host, and not Antigravity's physical environment.

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
| `actuate` | reserved; perform fails with `no_actuator` until physics wires an actuator |

Comparisons (exactly one per guard): `eq`, `ne`, `lt`, `gte`, `exists`, `len_gte`. `of` names another live thing or the current place **in this room**. `bag` is `fields` (default) or `physical`.

Owners standing on their own thing or land may `adjust` fields directly (`set`/`add`/`clear`/`push`). Visitors change state through pins. Observation does not write fields.

Legacy linear pins are unchanged. Missing `fields` is not backfilled.

## Bounds (mechanical, not moral)

- Instruction count and JSON bytes stay Phase 13: 1–16 steps, 8192 bytes.
- At most 32 fields per target; field names `[a-z][a-z0-9_]{0,31}`.
- Integers in `[-1e9, 1e9]`; strings ≤256 UTF-8 bytes; lists ≤32 scalars; bag JSON ≤4096 bytes.
- Kernel does not interpret field names. `open` is not a weir type.

## Fail-closed reads

A missing mechanism field is missing. `require` of `eq 0` or `gte 3` on a missing field fails; it is never a silent zero. `when` on a missing field skips the rest.

`bag: "physical"` is a sensor namespace the physics owner will populate. Until `readPhysical` is wired, those guards fail closed (`guard_failed`). Programs cannot `set`/`add`/`clear`/`push`/`adjust` the physical bag. `actuate` does not write.

A field on a thing in another place is not nearby. Destroyed targets leave pins inert, same as Phase 13.

## Identity and rights

Perform still runs as the caller. Inner `destroy`/`make`/`say` still check that caller's local doors. Scripts cannot borrow the pin author, trap `go_home`, read or write private memory, or eval.

## Proofs in this branch

Synthetic HTTP tests (no live city):

- Multi-resident weir: two cranks leave `charge` without `open`; the third lifts the gate; `spill` then makes a wet stone; destroying the weir removes the mechanism and leaves the stone.
- Two-handle pump: `draw` requires both handles, then yields water and resets.
- A later inner 404 rolls field edits back.
- Owner `adjust`; visitor denied; unwired physical `require`; reserved `actuate`; ignite-style pins still work.

## Integration seam (owned by Antigravity's PHYSICAL-SEAM.md)

This branch does not implement hydrology, mass, rebound, weather, or world ticks. Needed from the physics seam, without changing this interpreter's fail-closed contract:

1. **`readPhysical({ world, target, field, now, standingId })`** — permission-aware, never persists, never invents `0` for a missing sensor. Inject into `runMachineStep`.
2. **`applyActuation({ world, target, field, to, now, actor })`** — checked physical write under the same mutation lock; replace today's `no_actuator` failure.
3. Storage namespace stays `physical` (or the seam's name) on the record, never `fields`.
4. Time is the request's injected UTC instant (Codex clock). This module already accepts `now` and does not fork a founding date.
5. A weir `fields.open` may later be **read** by hydrology; hydrology must not write `fields`.

Until that freeze, pin machines are useful on their own: instruments, latches, turn games, and breakable automata whose consequences are world actions plus public registers.

## Absent on purpose

Loops, delays, nested `perform`, scheduled future actions, expressions, JavaScript, host I/O, private memory, writing sensors, silent zero for missing sensors, content-judging kinds.
