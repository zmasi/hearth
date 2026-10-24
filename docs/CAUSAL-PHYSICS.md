# Hearth Causal Living-World Physics (`hearth-causal-physics-v1`)

Hearth's causal physics subsystem gives places and resident-made things genuine physical, mechanical, hydrological, atmospheric, and ecological consequences while preserving every constitutional right of the city.

## 1. Modeled Fidelity & Explicit Non-Claims

Hearth runs on serverless Vercel Functions backed by a single transactional PostgreSQL JSONB ledger (`hearth_ledger`). There is no background daemon ticking at 60 Hz while residents sleep. Instead, the world evolves **lazily and analytically over elapsed time $\Delta t = t_{\text{now}} - t_0$**:

- **Spatial & Mechanical Dynamics (`client/causal-physics.mjs`):**
  - Deterministic 3D axis-aligned bounding-box (AABB) room bounds and solid occupancy with `400 out_of_bounds` and `409 collision` rejection.
  - Directed acyclic vertical support stacks (`place_on`, `remove_from`, `move_to`) with footprint center-of-mass stability and recursive supported-load summation (`load_kg`, `load_g`).
  - Hookean elastic beam/spring deflection ($\delta = \min(\delta_{\max}, m_{\text{load}} g / k)$) with mechanical latch thresholds (`latch_threshold_mm`, `latched`).
  - Counterweight-to-sluice coupling (`coupled_support_id`): when a supporting beam deflects at or past its latch threshold, any coupled sluice gate automatically opens; when unloaded (by `remove_from`, `give`, or `destroy`), the beam springs back and the coupled sluice snaps shut.
  - Rigid-body 1D collision impulse (`strike`) computing momentum transfer, coefficient-of-restitution rebound velocity (`last_rebound_ms`), kinetic-friction slide on unanchored bodies ($\mu_k = 0.35$), cumulative plastic deformation work (`work_j`), and exponentially decaying acoustic resonance ($A(t) = A_0 e^{-(t - t_{\text{strike}})/\tau_{\text{ring}}}$ at `natural_hz`).
  - **Explicit Scope:** This is a deterministic reduced-coordinate 3D AABB, support-stack, elastic-deflection, and collision-impulse solver — not a 6-DoF triangle-mesh rigid-body engine.
- **Coupled Multi-Place Hydrology:**
  - Places opt into hydrological reaches (`elevation_m`, `area_m2`, `max_depth_m`, `source_inflow_m3s`, `crest_height_m`, `aperture`, `conductance_s`) linked across adjacent places by directed channels (`couple_channel`).
  - `solveHydrologyNetwork` evolves connected components with a matrix exponential inside each filling, flowing or capped regime. This retains equal-rate cascade terms and avoids division by nearly equal rates. Thresholds use a logarithmic sampling grid and numerical bisection, not an exact symbolic root proof.
  - Water entering downstream reaches comes from the same integrated outflow used upstream; divided channels split that outflow equally. Volumes stay in `[0, capacity]` apart from boundary rounding. The tests check mass balance and partition/restart differences within **0.00001 m³**, or **0.0001 m³** for the long-absence and varied-graph cases.
  - A connected component has at most **32 reaches**, bounding matrix cost. Separate components are independent. Work scales with graph/rate/time scales, not one tick per elapsed second. The tested 180-day fixture is bounded; this is not unconditional O(1), bit identity across platforms, or a proof for every possible graph. A convergence failure refuses the calculation rather than silently dropping elapsed time.
- **Atmosphere, Soil Moisture & Living Flora:**
  - Deterministic UTC solar altitude, phase (`night`, `dawn`, `day`, `dusk`), and irradiance (`sunlight_pct`), plus seeded synoptic wind (`wind_speed_ms`, `wind_direction_deg`) and rain (`rain_mm_hr`) attenuated by place exposure (`open`, `canopy`, `sheltered`).
  - Exponential soil-moisture water balance (`soil_moisture`, `moisture_pct`) driven by rain + river-reach seepage minus solar/wind evapotranspiration across canonical **one-hour UTC cells**. The declared climate repeats every **14 days**, seeded by ledger genesis and weather region, independently of live topology. River seepage is sampled at each hour boundary; its current-hour driver survives intermediate commits/restarts.
  - Logistic tree/flora biomass growth (`biomass_kg`, `canopy_pct`, `stage`) integrates the moisture-dependent rate through the elapsed interval, including analytic clamp crossings; it does not multiply an endpoint growth rate by the whole interval. Wind drives canopy sway.
  - Once soil and seepage settle into their climate cycle, complete cycles fast-forward using the cycle's growth integral. Synthetic 30- and 180-day jumps agree with daily anchors within **0.0001 kg**. If river forcing still has not settled after 28 days and more than another cycle remains, ecology uses the projected final seepage for the remaining interval and sets **`history_approximation: true`** on the environment/flora projection. A committed approximation retains that marker. Hydrology still evolves its full interval. This case has no uniform equivalence claim to daily ecology commits; the marker is not a promise of exact historical weather or growth.

## 2. Constitutional & Sovereignty Guarantees

1. **Pure Observation (`GET` Never Mutates or Appends):**
   - `GET /api/me`, `GET /api/perception`, `GET /api/map`, and `GET /api/physics` evaluate physical state purely in memory at `now()`. They never issue database `UPDATE`s, never append ledger events, and never backfill storage fields.
2. **Untyped Things Stay Untyped (Phase 7 Invariant):**
   - `make` creates plain things with exact keys `["id", "name", "body", "ownerHandle", "placeId", "createdAt"]`. Only things explicitly configured via `configure_physics` or `actuate` (or carrying `fields.open`) project a `thing.physical` DTO.
3. **Sovereign Cross-Place Coupling (`couple_environment`):**
   - `couple_channel` requires adjacency (`parent`, `child`, or `portal`), non-increasing elevation ($z_{\text{from}} \ge z_{\text{to}}$), DAG acyclicity, and authority on **both** places (`set_local_law` or `couple_environment: "public"`).
   - Lazy physical mutations may advance evolved anchors throughout the coupled world, including another owner's parcel. That applies already-authorized physical evolution; it does not confer editing or vault access.
   - `uncouple_channel` lets either endpoint owner sever while standing on their own endpoint, even when either coupling door is closed. Existing flow is committed first; only subsequent transfer stops. Future re-coupling still needs both sides' authority.
   - Missing `couple_environment` evaluates to `"owner_only"` on owned land, `"public"` on `world`/`arrival`, and `"closed"` on personal enclaves and other unowned land. No resident can flood or drain a neighbor's parcel or enclave without their consent.
   - Ordinary perception follows the existing observe/standing rule. The legacy public `/api/map` still includes public-register and physical projections without those per-place filters; these bags are **not private storage**. Trails applies its existing public-observation filter.
4. **Unblockable `go_home`:**
   - Flooded reaches, closed doors, and colliding room bodies never block `go_home`.
   - If a numerical projection is unavailable, ordinary perception returns an
     explicit `unavailable: true` physical DTO without sensor values. That cannot
     block `go_home` or turn a failed sensor into zero. Physical mutations still
     refuse calculation failures and roll back.

## 3. Actions & Script Composition

### `configure_physics` (`POST /api/action`)
Configures a place's physical environment/hydrology reach or a thing's mechanical properties:

```json
{
  "action": "configure_physics",
  "targetKind": "place",
  "targetId": "plc_weir",
  "exposure": "open",
  "bounds": [12, 6, 12],
  "soil_moisture": 0.45,
  "hydrology": {
    "elevation_m": 25,
    "area_m2": 100,
    "max_depth_m": 8,
    "water_depth_m": 1.0,
    "source_inflow_m3s": 0.5,
    "crest_height_m": 0.4,
    "aperture": 1.0,
    "conductance_s": 0.01
  }
}
```

```json
{
  "action": "configure_physics",
  "targetKind": "thing",
  "targetId": "thg_beam",
  "mechanics": {
    "role": "support",
    "anchored": true,
    "mass_kg": 40,
    "pos": [0, 0, 0],
    "size": [2, 0.4, 1],
    "stiffness_nm": 50000,
    "latch_threshold_mm": 40
  }
}
```

### `couple_channel` (`POST /api/action`)
Links an upstream hydrological reach to an adjacent downstream reach:

```json
{
  "action": "couple_channel",
  "fromPlaceId": "plc_weir",
  "toPlaceId": "plc_bridge"
}
```

### `actuate` (`POST /api/action` and Phase 13 `perform` scripts)
Performs a physical operation (`set_sluice`, `set_weir`, `place_on`, `remove_from`, `move_to`, `strike`) on a thing in the caller's current place (`use_thing` permission required):

- Direct call:
  ```json
  { "action": "actuate", "targetId": "thg_sluice", "op": "set_sluice", "value": 0 }
  ```
- Composed inside a Phase 13 pinned script (`instructions`):
  ```json
  { "do": "actuate", "targetId": "$target", "name": "set_sluice", "body": "$level" }
  ```

## 4. Permission-Safe Sensor Seam (`readPhysicalSensor`)

`client/causal-physics.mjs` (and `api/index.js`) exports `readPhysicalSensor(world, opts)` for programmable guard evaluation (`when` / `require`):

- Verifies the caller is standing in or permitted to observe the target place.
- Verifies the target place or thing is live (not missing or destroyed) and has active physical sensors.
- Uses `Object.hasOwn` against explicit sensor allowlists (`ALLOWED_PLACE_SENSORS`, `ALLOWED_THING_SENSORS`), rejecting prototype properties (`__proto__`, `constructor`, `toString`).
- Refuses missing, destroyed, unobservable, or unconfigured targets with structured `{ ok: false, error_class, http_status, message }` rather than coercing to `0`.


## Integrated execution, custody and recovery

The actual handler injects the authenticated caller, current place, sensor reader,
actuator and one UTC request instant captured **after** the PostgreSQL row lock.
The alternate machine actuator form is also supported:

```json
{"do":"actuate","field":"set_sluice","of":"$target","to":"0.5"}
```

`field` names the actuator operation, not an arbitrary sensor to overwrite.
The original `targetId/name/body` form remains valid, including in stored scripts.
Mixed forms and host/identity fields are refused. The `aperture` name by itself
is not an actuator. `set_sluice` accepts 0..1 as a ratio and values above 1 up to
100 as percentages. `fields.open` takes precedence when present (`0` closed,
`1` fully open, higher numbers as percent); clear it to return to the mechanical
aperture. Register writes through a pin obey the caller's `use_thing` door.

Changing `fields.open`, directly or in a composed program, advances old physics
before writing the register. A later failing instruction restores fields,
anchors, events, rates and depth together; PostgreSQL rolls back the row revision.
Stored instruction grammar is checked at performance and during recovery.

Physical anchors are JSON numbers rounded at stated fields (water totals and
volumes to 9 decimals; controls typically 4). They are not integer-only storage.
Uncertain-commit reconciliation compares the exact intended serialized world,
not an independently recomputed physical trajectory. Recovery copies that state
and verifies its complete digest; it does not replay events or invent weather
history. The updated recovery validator checks optional physical/field bags,
channel topology and both pin forms. Worlds without them remain unchanged.
Use the recovery tooling from this release for snapshots containing these fields.
There is no schema migration, resident-key collection or live demo population.
