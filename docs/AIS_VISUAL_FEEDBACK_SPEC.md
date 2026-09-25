# AIS-assisted visual feedback and vessel tracking

**Status:** Proposed design  
**Scope:** Extend Forward Watch with locally captured or camera-supplied images, reviewable camera/model/AIS suggestions, and persistent multi-image vessel tracks. This document does not authorize automatic model training or replacement on the boat.

## 1. Goals

1. Associate camera detections with nearby AIS tracks when the evidence is strong enough.
2. Use matched AIS data to estimate range, bearing, target motion, and vessel dimensions, with age and uncertainty recorded.
3. Preserve repeated observations of the same visible vessel so its track and motion estimate improve over time.
4. Collect both detections and misses as a versioned, human-reviewable training dataset.
5. Improve velocity and closest-point-of-approach (CPA) / time-to-CPA (TCPA) estimates without presenting a camera-only guess as an AIS fact.
6. Keep image capture, storage, export, training, and model activation bounded and operator-controlled.
7. Accept event images from cameras that cannot provide continuous RTSP, preserve any camera-supplied tags, and make human review available in a browser.
8. Run a bounded, local visual first pass on captured stills so human reviewers start with boxes, a short scene summary, and reasons to inspect the image.

## 2. Non-goals and safety boundary

- AIS is not a radio ranging system. Range is computed from the own-ship and target AIS/GNSS positions at a common time.
- AIS does not provide visual bounding boxes. A person must review boxes, including for AIS-associated images.
- Vessel dimensions and reported position references can be absent or wrong. AIS length is a weak size prior, not a substitute for a visible box.
- Camera-only monocular distance, heading, velocity, CPA, or TCPA must not be presented as precise navigation data.
- A camera's motion or object tag is a suggestion about why an image was captured; it is not a marine detection label or an AIS identity.
- A vision-language model's description, object box, or negative result is a suggestion, not a reviewed label, AIS identity, measured range, or reason to suppress a safety alert.
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
- Image origin (`rtsp`, `camera_ftp`, `local_import`, or another explicit adapter), camera ID, received timestamp, raw camera event tags, and their provenance. Use `unknown` when the transfer does not actually convey an event type.

Requirements:

- Configurable enable/disable, maximum storage bytes, maximum age, and behavior when full (stop capture and report status; do not evict reviewed labels silently).
- Sampling/rate limits and deduplication by image checksum/perceptual similarity to avoid storing hundreds of near-identical video frames.
- A clear local review/export workflow. Export should be an explicit operator action and produce a versioned manifest plus checksums.
- Keep the image and AIS metadata on the boat by default. Do not upload, download, or transfer images over a metered link automatically. Any later off-boat training/export path must be separately configured and user initiated.
- Redact RTSP credentials from logs, manifests, and exported metadata. Do not retain camera passwords with training examples.

## 7. Camera event ingestion and browser review

### Camera-supplied stills

Add an optional image ingress service alongside the existing RTSP grabber. It accepts files from a camera FTP/FTPS drop directory, a manually populated local directory, or a future authenticated HTTP upload adapter. The ingress path is separate from the live detection loop: a camera event can arrive while Signal K or the reviewer is busy, and a failed review service must not discard the image. The plugin should consume the finished local file and never require the camera to poll for a review result.

The ingress service must wait until an upload is complete (temporary filename/atomic rename when available, otherwise stable size and a successful image decode), reject unsupported or oversized files, avoid following symlinks outside the drop directory, compute a SHA-256 checksum, and write an immutable image plus a metadata record into the bounded archive. Use a stable capture ID for retry-safe imports and record duplicate event occurrences without copying identical image bytes. Preserve both camera capture time, if trustworthy, and server receive time; mark time confidence and avoid precise AIS matching if the capture time is unknown.

Normalize each image to this minimum provenance before running the Forward Watch detector:

```text
capture_id, camera_id, image_sha256, image_width, image_height,
captured_at, received_at, time_quality, source_adapter,
raw_camera_tags[], camera_tag_source, camera_tag_confidence,
original_filename, trip_id
```

Store the camera's raw tags separately from Forward Watch predictions and human labels. Do not infer a person/vehicle/animal tag merely because that type was enabled in the camera's alarm schedule. If a device sends only a JPEG with no reliable event metadata, record `raw_camera_tags=[]` and `camera_tag_source=unknown`. A Reolink battery camera may supply motion-triggered FTP images only on supported model/hardware combinations or through a compatible hub/NVR, and battery cameras do not provide timed FTP uploads. Its smart-alert classes concern people, vehicles, animals and similar categories, so they must not be mapped directly to `ship`, `boat`, or `debris`.

### Annotation tool choice

Use **self-hosted Label Studio Community Edition** for the first still-image review interface. Forward Watch owns capture records and review status; Label Studio owns the browser editor. It supports local image storage, imported read-only predictions, editable image boxes, dynamic choices, and API/JSON export. Keep the integration optional so Forward Watch continues collecting when Label Studio is stopped. Run it on the same host/LAN as the image archive when possible, with its own persistent data volume, a read-only mount of only the archive image directory, and access limited to the boat's private network or an authenticated tunnel. Do not expose the image archive through a public URL. Configure `LABEL_STUDIO_LOCAL_FILES_SERVING_ENABLED=true` and a narrow `LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT` that points only at the read-only image mount.

The project labeling configuration is [label-studio/label-config.xml](label-studio/label-config.xml), with a representative [import task](label-studio/example-task.json). It shows the image, camera event description, and AIS candidate summary; lets the reviewer correct boxes/classes; and requires an explicit frame status and `accept`/`hold` decision. For each selected box, dynamic choices offer the candidate MMSIs plus `none`, `uncertain`, and `not listed`. The current six detector classes retain their exact names; `other_obstacle` is review-only until a later model version deliberately expands the class map. An `other_obstacle`-only image must not be silently exported as a clear negative for the current detector.

The interface also shows a concise first-pass visual summary, its model identity, and review-priority reasons. Keep the live detector and first-pass boxes in separate `predictions` entries with distinct `model_version` values so the reviewer can inspect their disagreement. The text summary is task data, never a substitute for opening the full-resolution image.

Forward Watch sends one Label Studio task per unique capture, with a local-file image reference, immutable capture ID, camera tags as data, AIS candidates as dynamic choices, and model boxes under `predictions`. The current detector's normalized center/width/height coordinates must be converted to Label Studio's top-left percentage boxes against the original image dimensions. Suggestions are displayed as predictions; they are not accepted annotations. If several vessels appear, each reviewed box gets its own AIS choice. The AIS options are display suggestions only; the exported value is a stable `ais:<MMSI>` token or a fixed non-match token. Escape camera/AIS names before using any formatted display text. Retain trip ID and capture time so the reviewer can inspect neighboring stills in order; each frame's AIS identity still requires its own decision.

Use Label Studio's task import API in bounded batches, with a durable mapping from `capture_id` to Label Studio task ID and retries that do not create duplicates. Annotation webhooks can prompt a quick refresh, but a periodic API reconciliation is required because Label Studio does not retry failed webhooks. An update to a reviewed annotation creates a new local review revision; the original capture and earlier review remain auditable. The API token belongs in server-side configuration and never in a task, URL, browser page, or exported dataset.

The reviewer flow is:

1. Open the Forward Watch review link (or Label Studio project) and see queued camera events, detector misses, ambiguous AIS matches, and ordinary empty-water samples.
2. Inspect the camera's event tag and time, correct/add/delete every relevant box, mark the frame as `targets_visible`, `clear_negative`, or `unusable`, and choose an AIS disposition for each box.
3. Mark camera tag quality and explicitly choose `accept` or `hold`. An accepted clear-negative frame has no boxes and remains useful for false-positive training. A held or unusable frame cannot enter training.
4. Save. Forward Watch reconciles the annotation, checks that the saved box/choice IDs match, and records a reviewed revision. Training export includes only accepted, non-cancelled human annotations and accepted clear negatives, never predictions alone. `targets_visible` requires at least one reviewed box; `clear_negative` requires no boxes; `unusable` and `hold` are excluded. An image containing only `other_obstacle` boxes remains in the canonical dataset but is excluded from the current six-class YOLO export.

Keep the full accepted Label Studio JSON and Forward Watch capture record as the canonical review data. A separate converter makes YOLO image/label files for a chosen versioned class map, preserving camera tags, AIS association, and review provenance in a sidecar manifest. A direct YOLO export from the labeling UI cannot be the sole archive because it cannot represent all of those fields.

Label Studio Community Edition supports annotation but does not provide a separate role-based reviewer/approver workflow. The explicit decision above is sufficient for a single operator; if independent multi-person review or video track editing becomes necessary, evaluate self-hosted CVAT, which supports job stages and a review mode. Keep the Forward Watch capture/review interchange format tool-independent so that change would not rewrite the dataset.

### Deployment and offline behavior

The plugin must start and detect normally without Label Studio. If the annotation server is offline, persist pending tasks locally and sync them when it returns. Do not copy an entire image library into Label Studio's uploaded-media store: serve images from the bounded local archive through a narrowly mounted local-files root and import task references plus suggestions. Camera ingress, Label Studio sync, and training export must have separate enable switches and quotas. Images stay on the camera-side server; transferring them to a home server or training machine requires a deliberate export on an appropriate connection.

### Automated first review pass

Start by evaluating [Microsoft Florence-2-base](https://huggingface.co/microsoft/Florence-2-base) as an **optional, asynchronous** local reviewer. Its 0.23B-parameter model supports object detection and region captioning, giving a useful trial of boxes plus a brief scene description without a multi-billion-parameter general-purpose VLM. This is a candidate, not a claim that it recognizes small marine targets reliably or runs acceptably on the boat's Raspberry Pi 4. Benchmark it on the intended inference host and held-out boat images before enabling it. Run the existing Forward Watch detector in the live path; Florence operates only on archived, selected stills and never gates alerts, AIS association, or capture.

The worker should use the model's structured object-detection output for box suggestions. A caption can explain a scene or flag possible glare/occlusion, but cannot create a box or a `clear_negative` label by itself. Map detector phrases to the six current classes through a versioned, conservative synonym table; preserve raw phrases. An unknown or ambiguous phrase stays `other_obstacle` or unclassified for review. Reject malformed/out-of-image boxes and record any resizing and coordinate transformation back to the original image. Do not turn a generated vessel description into an MMSI, ship dimensions, range, or heading. AIS candidates remain geometric suggestions from section 4.

Queue a bounded set of stills from camera events, low-confidence or conflicting detector results, AIS-in-view images with no detection, and a randomized sample of otherwise empty frames. Do not let an AI `nothing visible` response remove an image from the human queue: those misses are particularly valuable. Prioritize model disagreement, AIS-in-view misses, small/distant boxes, unfamiliar camera tags, and poor image quality. Rate-limit repeated frames and keep a small random audit sample across all triage outcomes so selection bias and missed targets can be measured. Reviewers should see the priority reason, original camera tag, live-detector output, first-pass output, and AIS context separately.

Persist each run as append-only provenance: capture checksum, model repository/revision and artifact checksum, processor/runtime version, task prompts and decoding settings, class-map version, output boxes/raw text, duration, outcome (`completed`, `timed_out`, `failed`, `skipped`), and skip/failure reason. A result arriving after a human annotation must not overwrite it. Label Studio receives distinct prediction versions; the export pipeline reads accepted human annotations only. Prediction scores, if emitted, are model-specific ranking hints, not calibrated probabilities or proof of agreement.

Run the worker outside the Signal K event loop with explicit queue depth, concurrency, memory and CPU limits, and a timeout per image. If it is unavailable or too slow, import the image for human review with `AI review unavailable` and continue. Keep images and inference local to the capture host or its LAN; remote inference is opt-in and never sends images over the metered connection by default. Download pinned model revisions on the inference host only when the recorded artifact checksum differs; do not transfer model weights or image batches from the development laptop by SSH/SCP. The Coral Edge TPU, if fitted, is for a compatible quantized detector; it does not accelerate Florence's transformer workload.

Promotion criterion: on held-out outings, compare the live detector alone with the detector plus first-pass review. Report small/distant target recall, the share of false negatives that still reach human review, false suggestions per image, median/P95 reviewer time, and P95 worker latency, RAM, and power on the chosen host. Include glare, wakes, night/twilight, rain, buoys, debris, and empty water. Keep the worker optional unless the measured review benefit justifies its resource cost. A larger vision-language model or an open-vocabulary detector can be tried on a capable local home server as a second experiment, using the same interface and test set; do not assume that a more fluent caption yields better boxes.

## 8. Review and training workflow

1. **Collect:** local, bounded capture records; no model changes.
2. **Pre-review and prioritize:** run the optional bounded visual first pass, then queue detector misses, model disagreements, false positives, ambiguous AIS matches, small/distant targets, and conditions underrepresented in the dataset. Keep a random audit sample and expose failures rather than hiding them.
3. **Review:** operator uses the browser queue to confirm/edit boxes, classes, camera tags, AIS identity, and optional visibility/occlusion tags. Preserve disagreements and provenance. `accept` is required for training inclusion.
4. **Freeze a dataset version:** immutable manifest, split assignment, label audit, and checksums.
5. **Train off the live Signal K loop:** fine-tune the selected detector on a controlled training host. Use a pretrained baseline and include representative negatives. Split by whole trip/session/camera period, not random adjacent frames, to avoid leakage.
6. **Evaluate:** compare against the existing model on a held-out set of complete outings. Report per-class precision/recall, missed targets by pixel size/range/condition, false alarms per operating hour, and latency on the target hardware. Evaluate AIS association and range/CPA errors separately from image detection mAP.
7. **Package:** save model checksum, dataset version, class map, training configuration, evaluation report, and runtime compatibility metadata.
8. **Canary and activate:** run candidate in shadow mode on the boat, compare outputs without publishing candidate alerts, then require explicit operator activation/rollback. Retain the prior model.

Training data must not be split by neighboring frames. Test sets must contain held-out trips or sessions. Augmentation should preserve maritime evidence; avoid transformations that erase tiny targets or make reflections, horizon, and vessel orientation physically implausible.

### Coral Edge TPU deployment path

Treat the trained detector checkpoint as the source artifact and produce separately versioned deployment artifacts for each inference backend. For a boat fitted with a Coral Edge TPU, evaluate a small detector such as YOLO26n and export a fully INT8-quantized TensorFlow Lite Edge TPU model. Run export and Edge TPU compilation on x86-64 Linux or another supported non-ARM training/export host; the compiler is not available on the Raspberry Pi. Use representative images from the frozen marine training set for quantization calibration. Keep the existing CPU ONNX artifact available as a fallback.

The Edge TPU compiler may leave unsupported operations on the Pi CPU. A successful export is not sufficient: record its operation-placement summary and require the model's main neural-network workload to run on the TPU. Re-evaluate the quantized model on the held-out marine outings for per-class precision/recall, small and distant target recall, false alarms per operating hour, and end-to-end latency on the actual boat Pi and Coral device. Tune image size against both target visibility and measured speed; 320 pixels is a starting point, not a fixed requirement.

Forward Watch currently uses a Node.js ONNX detector. Add an inference-backend boundary that preserves its detection record and class-map contract. The Coral backend may use a long-running Python/TFLite worker or an equivalent runtime with the Edge TPU delegate; keep the model loaded between frames and exchange bounded requests/results over local IPC. Do not spawn a fresh interpreter process per image or block the Signal K event loop. Report the selected backend, model checksum, TPU availability, and CPU fallback state. A fallback to ONNX must be explicit in status so an unavailable or partially compiled Coral model is not mistaken for accelerated inference.

## 9. Signal K interface and operator controls

Keep detection, AIS association, and track estimates under a Forward Watch-owned namespace (initially `environment.forwardWatch`) with stable IDs and source metadata. A record should expose detection confidence, calibrated bearing, AIS match state, MMSI when confirmed, range and range source, target COG/SOG/heading with provenance, CPA/TCPA with uncertainty, and timestamps/ages.

Required configuration controls:

- AIS-assisted association on/off and maximum candidate age.
- Camera field-of-view/calibration and yaw offset.
- Capture/review storage on/off, quota, retention, and sampling rate.
- Camera image ingress adapter/drop directory, accepted formats/size limits, and Label Studio server/project connection on/off.
- Optional first-pass visual reviewer on/off, pinned model revision/checksum, inference host, queue and resource limits, sampling policy, and failure status.
- Detector backend selection (`cpu-onnx` or `coral-edgetpu`), artifact path/version, and explicit CPU fallback policy.
- Confirmation policy and ambiguity margin.
- Track gap timeout and CPA prediction horizon.
- Candidate model shadow mode and explicit activation/rollback.

Status should distinguish `camera unavailable`, `AIS unavailable`, `calibration missing`, `collecting`, `storage full`, and `tracking with stale AIS`. Loss of AIS must degrade to visual-only detections and disable AIS-derived range/CPA; it must not reuse the last fix indefinitely.

## 10. Validation and acceptance criteria

Before enabling AIS-assisted training or CPA output:

1. Unit tests cover radians/degrees, wraparound at north, camera pixel-to-bearing conversion, geodesic/local-coordinate range, stale-fix projection, AIS dimensions/offset handling, and CPA/TCPA edge cases.
2. Association tests include two same-class ships, crossing bearings, duplicate detections, stale AIS, missing heading/dimensions, and one AIS candidate competing for two detections.
3. Replay tests use synchronized camera/Signal K recordings and verify deterministic match decisions and timestamps.
4. Dataset tests prove empty scenes and detector misses can be reviewed, record checksums are verified, and quotas/retention work without deleting reviewed labels.
5. Model evaluation uses held-out outings and reports false alarms/hour and recall for small/distant vessels, not only aggregate mAP.
6. CPA/TCPA estimates are compared with replayed AIS trajectories and clearly expose input age, source, and uncertainty.
7. No unreviewed candidate model can replace the active model; rollback to the previous checksum is tested.
8. Camera-ingress tests cover partial uploads, duplicate/retried events, malformed files, missing tags, untrusted filenames, time uncertainty, and a full storage queue.
9. Web-review tests cover image-only and prediction-backed tasks, multiple boxes with distinct AIS choices, accepted clear negatives, held/unusable images, edited annotations, Label Studio outages, failed webhook delivery, and reconciliation without duplicate tasks.
10. A Coral candidate is verified on the boat Pi: the Edge TPU runtime is selected, compiler placement is recorded, quantized accuracy is evaluated on held-out marine images, and end-to-end latency is measured. CPU fallback remains observable and the Signal K event loop remains responsive if Coral initialization or inference fails.
11. First-pass review tests cover structured box conversion, unknown phrases, prompt/model provenance, model disagreement, late predictions, bounded queues, timeouts, and offline worker behavior; replay confirms a negative AI result never hides an AIS-in-view miss. Held-out review trials measure whether human time falls without losing small-target review coverage.

## 11. Delivery phases

**Phase A — calibrated AIS overlay:** read Signal K AIS/self data, record image timestamp, project AIS bearings into the calibrated image, display match candidates, and log no images by default.

**Phase B — camera ingress and local review queue:** bounded image plus metadata capture from RTSP, camera event uploads, or manual import, including AIS-in-view misses; connect Label Studio for browser box/class/AIS review and immutable export. Add the optional, measured first-pass visual worker after basic ingestion and human review work; Label Studio and the worker are independently optional and retry-safe.

**Phase C — persistent tracks and kinematics:** repeated-frame visual IDs, confirmed MMSI links, smoothed target motion, and uncertainty-aware CPA/TCPA in a shadow display.

**Phase D — offline model iteration:** versioned dataset, training/evaluation scripts and reports, model artifact checksums, boat-side shadow/canary, explicit activation and rollback.

Each phase should be useful and testable on its own. Phase C must not depend on Phase D, and the active detector must remain usable when AIS, storage, or the review tool is unavailable.

## References for the proposed integration

- [Label Studio Community Edition capabilities](https://labelstud.io/guide/label_studio_compare), [prediction import](https://labelstud.io/guide/predictions), [local storage](https://labelstud.io/guide/storage_local), [dynamic and per-region choices](https://labelstud.io/tags/choices), and [webhook delivery behavior](https://labelstud.io/guide/webhooks.html).
- [CVAT manual review](https://docs.cvat.ai/docs/qa-analytics/manual-qa/) and [job stages](https://docs.cvat.ai/docs/manual/basics/vocabulary/).
- [Reolink FTP support by model/hardware](https://support.reolink.com/articles/900000625446-Which-Cameras-NVRs-Support-FTP-Uploading/), [FTP event schedule behavior](https://support.reolink.com/hc/en-us/articles/360020081034-How-to-Set-/), and [smart detection categories](https://support.reolink.com/articles/900002812826-Introduction-to-Reolink-Smart-Detection/).
- [Ultralytics Edge TPU export guide](https://docs.ultralytics.com/integrations/edge-tpu), [Coral on Raspberry Pi deployment guide](https://docs.ultralytics.com/guides/coral-edge-tpu-on-raspberry-pi), and [Coral Edge TPU compiler documentation](https://coral.ai/docs/edgetpu/compiler/).
- [Microsoft Florence-2-base model card and object-detection examples](https://huggingface.co/microsoft/Florence-2-base), [Label Studio prediction import and model versions](https://labelstud.io/guide/predictions), and [Label Studio prediction API](https://api.labelstud.io/api-reference/api-reference/predictions/list).
