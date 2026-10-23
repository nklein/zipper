'use strict';

window.Zipper = window.Zipper || {};

Zipper.units = {
  FT_PER_MILE: 5280,
  mphToFps(mph) { return mph * 5280 / 3600; },
  fpsToMph(fps) { return fps * 3600 / 5280; },
};

// Hidden tuning values. Everything a driver does is a slight perturbation
// of these (and of the values set in the control panel).
Zipper.config = {
  // Driving dynamics, in miles-per-hour per second.
  accelMphps: 6,                // comfortable acceleration
  comfortDecelMphps: 8,         // comfortable braking
  maxDecelMphps: 20,            // hardest braking a car will ever do
  laneChangeThresholdMphps: 0.5, // acceleration gain needed to bother passing

  // Per-car perturbations (standard deviations). Speed/accel/decel are
  // fractions of the base value; eagerness is absolute on a 0..1 scale.
  speedSpread: 0.05,
  accelSpread: 0.15,
  decelSpread: 0.1,
  eagernessSpread: 0.05,
  giveUpSpread: 0.2,
  perturbationLimit: 2.5,       // clamp perturbations to this many std devs
  courtesyProbability: 0.5,     // chance a driver makes room for a merger

  // Car-following (Intelligent Driver Model) and lane changing.
  carLengthFt: 15,
  minGapFt: 7,                  // bumper gap when stopped in traffic
  headwaySec: 1.4,              // desired following time
  safeGapFt: 5,                 // smallest gap anyone will merge into
  safeHeadwaySec: 0.6,          // smallest following time accepted when merging
  mergeHeadwayCut: 0.1,         // once committed to getting over, accept 10% less than that...
  mergeHeadwayMinFactor: 0.5,   // ...shrinking to this fraction of it...
  mergeHeadwayShrinkFt: 2640,   // ...after driving this far since committing
  entryHeadwaySec: 1.0,         // following time required to enter the road
  hardGapFt: 1,                 // absolute minimum bumper gap (collision guard)
  politeness: 0.3,              // how much a passer cares about the car it cuts in front of
  laneChangeEvalSec: 0.6,       // how often a driver reconsiders lanes (when not urgent)
  laneChangeCooldownSec: 2,
  laneChangeDurationSec: 1.5,   // visual only
  perLaneChangeFt: 300,         // distance a last-moment driver allows for each lane change
  courtesyRangeFt: 200,         // how far ahead a courteous driver looks for mergers
  courtesyZoneFt: 500,          // mergers this close to the choke-point get courtesy
  courtesySlowZoneFt: 5280,     // extra courtesy zone for a stopped merger (scales with slowness²)
  wallZoneFt: 10,               // "stuck at the choke-point" distance
  stoppedFps: 1,
  priorityGapFt: 0.25,          // room a priority car needs to squeeze in
  priorityTieFt: 1,             // stopped cars this close count as tied for farthest
  giveUpSec: 25,                // exits only: stuck this long, take the other road

  // Road geometry, in feet.
  arrivalToChokeFt: 1.5 * 5280,
  afterChokeFt: 1500,
  viewBeforeFt: 1500,
  viewAfterFt: 600,
  rampCurveFt: 500,
  taperFt: 300,                 // lane reduction taper (visual only)
  prepopulateMarginFt: 200,     // keep pre-populated cars this far before the view

  // Simulation clock.
  stepSec: 0.1,
  maxStepsPerFrame: 400,
  statsWindowSec: 300,
  flowWindowSec: 60,
  realTimeScale: 4,             // simulated seconds per real second at "1×"
  playbackSpeeds: [0.25, 0.5, 1, 2, 4, 8, 16],
  defaultPlaybackIndex: 2,
};
