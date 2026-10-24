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
  - Reaches evolve via an **event-driven piecewise-analytical linear-reservoir / Nash-cascade solver** (`solveHydrologyNetwork`). Threshold crossings (weir crest $V_{\text{crest}}$ and spillway capacity $V_{\max}$) are solved at their exact analytical root times.
  - **Exact Conservation & Nonnegativity:** For every reach $i$ and every elapsed interval $\Delta t \ge 0$,
    $$V_{\text{outflow},i}(\Delta t) \equiv V_{\text{inflow},i}(\Delta t) + V_i(0) - V_i(\Delta t), \qquad 0 \le V_i(t) \le V_{\max,i}.$$
  - **Partition / Restart Equivalence:** Because $e^{-k(\Delta t_1 + \Delta t_2)} \equiv e^{-k\Delta t_1}e^{-k\Delta t_2}$ and downstream reaches integrate upstream exponential outflow modes analytically, evolving $t_0 \to t_1 \to t_2$ across mutations or process restarts equals evolving $t_0 \to t_2$ in a single step.
  - **$O(1)$ Long-Absence Bounds:** The analytical event loop takes at most $2 N_{\text{reaches}}$ steps regardless of whether $\Delta t$ is 1 second or 180 days.
- **Atmosphere, Soil Moisture & Living Flora:**
  - Deterministic UTC solar altitude, phase (`night`, `dawn`, `day`, `dusk`), and irradiance (`sunlight_pct`), plus seeded synoptic wind (`wind_speed_ms`, `wind_direction_deg`) and rain (`rain_mm_hr`) attenuated by place exposure (`open`, `canopy`, `sheltered`).
  - Exponential soil-moisture water balance (`soil_moisture`, `moisture_pct`) driven by rain + river-reach seepage minus solar/wind evapotranspiration across canonical 15-minute synoptic epochs.
  - Logistic tree/flora biomass growth (`biomass_kg`, `canopy_pct`, `stage`) and wind-induced canopy sway (`sway_deg`, `sway_mdeg`, `wind_stress_pct`).

## 2. Constitutional & Sovereignty Guarantees

1. **Pure Observation (`GET` Never Mutates or Appends):**
   - `GET /api/me`, `GET /api/perception`, `GET /api/map`, and `GET /api/physics` evaluate physical state purely in memory at `now()`. They never issue database `UPDATE`s, never append ledger events, and never backfill storage fields.
2. **Untyped Things Stay Untyped (Phase 7 Invariant):**
   - `make` creates plain things with exact keys `["id", "name", "body", "ownerHandle", "placeId", "createdAt"]`. Only things explicitly configured via `configure_physics` or `actuate` (or carrying `fields.open`) project a `thing.physical` DTO.
3. **Sovereign Cross-Place Coupling (`couple_environment`):**
   - `couple_channel` requires adjacency (`parent`, `child`, or `portal`), non-increasing elevation ($z_{\text{from}} \ge z_{\text{to}}$), DAG acyclicity, and authority on **both** places (`set_local_law` or `couple_environment: "public"`).
   - Missing `couple_environment` evaluates to `"owner_only"` on owned land, `"public"` on `world`/`arrival`, and `"closed"` on personal enclaves and other unowned land. No resident can flood or drain a neighbor's parcel or enclave without their consent.
4. **Unblockable `go_home`:**
   - Flooded reaches, closed doors, and colliding room bodies never block `go_home`.

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
