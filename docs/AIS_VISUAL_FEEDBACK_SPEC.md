# AIS-assisted visual feedback and vessel tracking

**Status:** Proposed design  
**Scope:** Extend Forward Watch with locally captured, reviewable AIS-assisted examples and persistent multi-image vessel tracks. This document does not authorize automatic model training or replacement on the boat.

## 1. Goals

1. Associate camera detections with nearby AIS tracks when the evidence is strong enough.
2. Use matched AIS data to estimate range, bearing, target motion, and vessel dimensions, with age and uncertainty recorded.
3. Preserve repeated observations of the same visible vessel so its track and motion estimate improve over time.
4. Collect both detections and misses as a versioned, human-reviewable training dataset.
5. Improve velocity and closest-point-of-approach (CPA) / time-to-CPA (TCPA) estimates without presenting a camera-only guess as an AIS fact.
6. Keep image capture, storage, export, training, and model activation bounded and operator-controlled.

## 2. Non-goals and safety boundary

- AIS is not a radio ranging system. Range is computed from the own-ship and target AIS/GNSS positions at a common time.
- AIS does not provide visual bounding boxes. A person must review boxes, including for AIS-associated images.
- Vessel dimensions and reported position references can be absent or wrong. AIS length is a weak size prior, not a substitute for a visible box.
- Camera-only monocular distance, heading, velocity, CPA, or TCPA must not be presented as precise navigation data.
- The plugin must not train, quantize, or replace its live model automatically on a Signal K host. A new model is a separately versioned, tested artifact and requires explicit activation.
- Forward Watch output must remain distinguishable from received AIS. Synthetic visual detections must never be written or relayed as real AIS reports.

## 3. Inputs and coordinate conventions

At each image capture, retain a single timestamped snapshot of:

- Image capture UTC timestamp and a monotonic local timestamp.
- Own-ship `navigation.position`, `navigation.headingTrue`, `navigation.courseOverGroundTrue`, and `navigation.speedOverGround`, including source and value timestamps.
- Nearby AIS vessel contexts keyed by MMSI, including position, COG, SOG, true heading, AIS vessel type, static dimensions (length and beam or A/B/C/D offsets when available), source, and each value's timestamp.
- Camera calibration and installation settings: horizontal/vertical field of view or camera intrinsics, camera yaw relative to the vessel, camera pitch, image dimensions, and optional stabilization/roll data.
- Original detector outputs, model identifier and checksum, inference settings, and source image checksum.

Signal K navigation angles are radians. Convert once at the boundary; keep internal bearings in radians or use an explicit `deg` suffix consistently. Never silently treat a missing or stale value as a valid zero.

For a calibrated pinhole camera, horizontal pixel `u` maps to camera-relative azimuth `atan((u - cx) / fx)`, where `cx` and `fx` are the calibrated principal point and focal length in pixels. The target's true bearing is own-ship true heading plus camera yaw plus this azimuth, normalized to one full turn. If heading is unavailable, COG may be used only above a configurable speed threshold and must be marked as a course-based approximation.

Compute the AIS target's range and true bearing from time-aligned own-ship and target positions in a local east/north frame or geodesically. Interpolate short gaps only when source timestamps and motion support it. For a stale AIS fix, project position using its reported velocity only within a configurable horizon and grow its uncertainty with fix age. Record the raw AIS range as antenna/reference-point range. Estimate hull-edge range only when target dimensions, their reference offsets, and a valid target orientation are available; record it as a separate derived value.

## 4. AIS association

### Candidate generation

For each image, project each fresh AIS target into camera azimuth using the synchronized own-ship pose. Compare that azimuth to each visual detection's calibrated bearing. Candidate generation must also consider:

- Angular residual and its uncertainty, including camera yaw calibration and heading source quality.
- AIS position age and expected movement since its fix.
- Visual class versus AIS ship type as a soft compatibility term, never a hard identity rule.
- Consistency with an existing visual/AIS track association.
- Whether a projected target is plausibly inside the camera's horizontal field of view.

Assign candidates one-to-one for an image or video frame using a deterministic minimum-cost assignment. Do not assign one AIS vessel to several visual detections in the same frame. More than one candidate within the ambiguity margin produces `ambiguous`, not an automatic match.

### Match states

Every association is one of:

- `candidate`: geometrically plausible, not yet confirmed.
- `confirmed`: operator-confirmed or passed a documented high-confidence persistence rule.
- `rejected`: operator says the detection and AIS vessel differ.
- `ambiguous`: several plausible AIS targets or weak geometry.
- `expired`: evidence exceeded configured freshness/retention limits.

Store match score, angular residual, report ages, selected MMSI, and reasons. The interface must show the candidate AIS name/MMSI, bearing residual, range, and data age beside the image so the operator can catch false matches.

### Avoiding false ground truth

Automatic association alone is a weak label. It may seed a review queue, but it must not silently become a trusted bounding-box or class label. Record label provenance independently for class, box, AIS identity, dimensions, and kinematics (for example `human`, `AIS-derived`, or `model-suggestion`).

Images with an AIS target projected into view but no detector result are first-class review items. The operator can draw a missed vessel box, confirm that it is not visually discernible, or reject the projection. Otherwise the dataset would contain only model successes and reinforce its existing blind spots.

## 5. Repeated observations and target motion

### Track identity

Maintain separate IDs for a visual track and an AIS MMSI. Link them only through the association state machine above. For successive images/frames, update visual tracks using class, box overlap, bearing continuity, scale change, and elapsed time. For a confirmed AIS match, the MMSI anchors track identity across camera occlusion and changing boxes. Never use a detection class as a target identity.

When only sparse event images are available, association may be lost between images. Keep a track only while its timing and motion remain plausible; do not bridge a long gap as if it were continuous video. An RTSP stream can support frame-level tracking, while event-triggered stills should use a separately configured maximum gap.

### Heading, course, and velocity

Keep these concepts distinct in every record and display:

- **True heading:** direction the vessel's bow points, from a valid AIS heading field when available.
- **Course over ground (COG):** direction of motion over Earth's surface, from AIS COG or the smoothed derivative of successive AIS positions.
- **Speed over ground (SOG):** AIS-reported speed or the speed from a smoothed position derivative.
- **Visual orientation:** an optional image estimate of bow/stern direction, with its own confidence; it is not AIS heading.

For matched ships, retain multiple timestamped AIS positions. Estimate target east/north velocity from a short robust/Kalman-smoothed window of fresh positions and compare it with reported AIS SOG/COG. Use the reported true heading for hull orientation only when present and credible. If heading is unavailable, COG is a reasonable direction-of-motion estimate only while moving; label it `course-derived`, not `heading`.

Repeated visual boxes add useful evidence: bearing rate, apparent-size change, continuity through partial occlusion, and possible visual orientation. They should refine track association and flag AIS inconsistencies. They do not independently determine absolute velocity or distance without a known range or sufficient own-ship motion/parallax. Camera-only triangulation is a later experimental feature and must carry a wider uncertainty.

### CPA and TCPA

At a common timestamp, express relative position and velocity in local east/north coordinates:

```text
r = target_position - own_position
v = target_velocity - own_velocity
t_cpa = -dot(r, v) / dot(v, v)
cpa = norm(r + v * t_cpa)
```

Clamp/omit TCPA outside the configured prediction horizon, when `dot(v, v)` is near zero, or when inputs are stale. Report whether the projected direction uses AIS COG/SOG, a smoothed AIS position derivative, or a camera-only estimate. Include uncertainty and source ages with CPA/TCPA. Smooth over several fixes rather than reacting to one noisy report; reset or widen uncertainty after a maneuver, track swap, or long gap. Do not emit an emergency-level alarm solely from an unconfirmed visual/AIS match.

## 6. Capture and dataset storage

Use Signal K's plugin data directory for a bounded local queue. Do not place image bytes in Signal K deltas or logs. Each record should contain:

- Immutable image filename and SHA-256 checksum.
- Capture and sensor timestamps, camera/calibration version, model version, and settings.
- Detector boxes and candidates, including empty-detection images.
- Relevant AIS snapshots and source/age data, keyed by MMSI.
- Human review decisions and provenance for each label field.
- Trip/session ID and optional coarse environmental tags entered or inferred locally (lighting, visibility, sea state); never infer exact weather as truth from pixels.

Requirements:

- Configurable enable/disable, maximum storage bytes, maximum age, and behavior when full (stop capture and report status; do not evict reviewed labels silently).
- Sampling/rate limits and deduplication by image checksum/perceptual similarity to avoid storing hundreds of near-identical video frames.
- A clear local review/export workflow. Export should be an explicit operator action and produce a versioned manifest plus checksums.
- Keep the image and AIS metadata on the boat by default. Do not upload, download, or transfer images over a metered link automatically. Any later off-boat training/export path must be separately configured and user initiated.
- Redact RTSP credentials from logs, manifests, and exported metadata. Do not retain camera passwords with training examples.

## 7. Review and training workflow

1. **Collect:** local, bounded capture records; no model changes.
2. **Prioritize:** queue detector misses, false positives, ambiguous AIS matches, small/distant targets, and conditions underrepresented in the dataset.
3. **Review:** operator confirms/edits box, class, AIS identity, and optional visibility/occlusion tags. Preserve disagreements and provenance.
4. **Freeze a dataset version:** immutable manifest, split assignment, label audit, and checksums.
5. **Train off the live Signal K loop:** fine-tune the selected detector on a controlled training host. Use a pretrained baseline and include representative negatives. Split by whole trip/session/camera period, not random adjacent frames, to avoid leakage.
6. **Evaluate:** compare against the existing model on a held-out set of complete outings. Report per-class precision/recall, missed targets by pixel size/range/condition, false alarms per operating hour, and latency on the target hardware. Evaluate AIS association and range/CPA errors separately from image detection mAP.
7. **Package:** save model checksum, dataset version, class map, training configuration, evaluation report, and runtime compatibility metadata.
8. **Canary and activate:** run candidate in shadow mode on the boat, compare outputs without publishing candidate alerts, then require explicit operator activation/rollback. Retain the prior model.

Training data must not be split by neighboring frames. Test sets must contain held-out trips or sessions. Augmentation should preserve maritime evidence; avoid transformations that erase tiny targets or make reflections, horizon, and vessel orientation physically implausible.

## 8. Signal K interface and operator controls

Keep detection, AIS association, and track estimates under a Forward Watch-owned namespace (initially `environment.forwardWatch`) with stable IDs and source metadata. A record should expose detection confidence, calibrated bearing, AIS match state, MMSI when confirmed, range and range source, target COG/SOG/heading with provenance, CPA/TCPA with uncertainty, and timestamps/ages.

Required configuration controls:

- AIS-assisted association on/off and maximum candidate age.
- Camera field-of-view/calibration and yaw offset.
- Capture/review storage on/off, quota, retention, and sampling rate.
- Confirmation policy and ambiguity margin.
- Track gap timeout and CPA prediction horizon.
- Candidate model shadow mode and explicit activation/rollback.

Status should distinguish `camera unavailable`, `AIS unavailable`, `calibration missing`, `collecting`, `storage full`, and `tracking with stale AIS`. Loss of AIS must degrade to visual-only detections and disable AIS-derived range/CPA; it must not reuse the last fix indefinitely.

## 9. Validation and acceptance criteria

Before enabling AIS-assisted training or CPA output:

1. Unit tests cover radians/degrees, wraparound at north, camera pixel-to-bearing conversion, geodesic/local-coordinate range, stale-fix projection, AIS dimensions/offset handling, and CPA/TCPA edge cases.
2. Association tests include two same-class ships, crossing bearings, duplicate detections, stale AIS, missing heading/dimensions, and one AIS candidate competing for two detections.
3. Replay tests use synchronized camera/Signal K recordings and verify deterministic match decisions and timestamps.
4. Dataset tests prove empty scenes and detector misses can be reviewed, record checksums are verified, and quotas/retention work without deleting reviewed labels.
5. Model evaluation uses held-out outings and reports false alarms/hour and recall for small/distant vessels, not only aggregate mAP.
6. CPA/TCPA estimates are compared with replayed AIS trajectories and clearly expose input age, source, and uncertainty.
7. No unreviewed candidate model can replace the active model; rollback to the previous checksum is tested.

## 10. Delivery phases

**Phase A — calibrated AIS overlay:** read Signal K AIS/self data, record image timestamp, project AIS bearings into the calibrated image, display match candidates, and log no images by default.

**Phase B — local review queue:** bounded image plus metadata capture, including AIS-in-view misses; add accept/reject/box/class review and immutable export.

**Phase C — persistent tracks and kinematics:** repeated-frame visual IDs, confirmed MMSI links, smoothed target motion, and uncertainty-aware CPA/TCPA in a shadow display.

**Phase D — offline model iteration:** versioned dataset, training/evaluation scripts and reports, model artifact checksums, boat-side shadow/canary, explicit activation and rollback.

Each phase should be useful and testable on its own. Phase C must not depend on Phase D, and the active detector must remain usable when AIS, storage, or the review tool is unavailable.
