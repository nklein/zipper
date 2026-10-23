'use strict';

(function () {
  const cfg = Zipper.config;
  const { mphToFps, fpsToMph } = Zipper.units;

  // Each lane is an array of cars sorted by position, front-most first.
  // Returns the index at which a car at position x would be inserted.
  function locate(lane, x) {
    let lo = 0;
    let hi = lane.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lane[mid].x > x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Positions are in feet along the road (x is the car's front bumper),
  // speeds in ft/s. Lane 0 is the left-most lane. Lanes at index
  // lanesAfter and above are the ones that exit (or end) at the choke-point.
  class Simulation {
    constructor(settings, which) {
      this.settings = settings;
      this.which = which;
    }

    reset(seed) {
      const s = this.settings;
      this.lanesBefore = s.lanesBefore;
      this.lanesAfter = s.lanesAfter;
      this.isExit = s.chokeType === 'exit';
      this.chokeX = cfg.arrivalToChokeFt;
      this.endX = this.chokeX + cfg.afterChokeFt;
      this.maxDecel = mphToFps(cfg.maxDecelMphps);
      this.rng = Zipper.makeRandom(seed);
      this.time = 0;
      this.cars = [];
      this.lanes = Array.from({ length: this.lanesBefore }, () => []);
      this.completions = [];
      this.chokePasses = [];
      this.completed = 0;
      this.diverted = 0;
      this.priority = null;
    }

    // ----- per-car parameters (live, so control changes apply at once) -----

    eagerness(car) {
      const base = this.settings.eagerness[this.which] / 100;
      return Math.min(1, Math.max(0, base + car.eagerNoise));
    }

    // A driver who has committed to getting over accepts a slightly tighter
    // gap, and tighter still the farther they've driven without managing it.
    mergeHeadway(car) {
      const start = 1 - cfg.mergeHeadwayCut;
      const progress = Math.min(1, (car.x - car.commitX) / cfg.mergeHeadwayShrinkFt);
      return cfg.safeHeadwaySec * (start - (start - cfg.mergeHeadwayMinFactor) * progress);
    }

    // Mergers well below their desired speed (traffic already backed up)
    // get courtesy farther from the choke-point.
    courtesyZone(car) {
      const slowness = Math.max(0, 1 - car.v / this.desiredSpeed(car));
      return cfg.courtesyZoneFt + cfg.courtesySlowZoneFt * slowness * slowness;
    }

    desiredSpeed(car) { return mphToFps(this.settings.highwayMph) * car.speedFactor; }
    accel(car) { return mphToFps(cfg.accelMphps) * car.accelFactor; }
    comfortDecel(car) { return mphToFps(cfg.comfortDecelMphps) * car.decelFactor; }

    headsForExit(car) { return this.isExit && car.wantsExit !== car.diverted; }

    targetRange(car) {
      return this.headsForExit(car)
        ? [this.lanesAfter, this.lanesBefore - 1]
        : [0, this.lanesAfter - 1];
    }

    lanesNeeded(car, lane) {
      const [lo, hi] = this.targetRange(car);
      if (lane < lo) return lo - lane;
      if (lane > hi) return lane - hi;
      return 0;
    }

    laneExists(lane, x) {
      if (lane < 0 || lane >= this.lanesBefore) return false;
      return lane < this.lanesAfter || this.isExit || x < this.chokeX;
    }

    // Does this lane lead into the reduced-speed area?
    isLimitedLane(lane) { return !this.isExit || lane >= this.lanesAfter; }

    desiredSpeedAt(car, lane, x) {
      let v0 = this.desiredSpeed(car);
      if (this.lanesNeeded(car, lane) === 0 && this.isLimitedLane(lane)) {
        const limit = mphToFps(this.settings.limitMph);
        const dist = this.chokeX - x;
        // Slow down gently (half of comfortable braking) to arrive at the limit.
        const cap = dist <= 0 ? limit : Math.sqrt(limit * limit + this.comfortDecel(car) * dist);
        v0 = Math.min(v0, cap);
      }
      return v0;
    }

    // ----- car following -----

    interaction(car, gap, leaderSpeed) {
      const v = car.v;
      const dynamic = v * cfg.headwaySec
        + v * (v - leaderSpeed) / (2 * Math.sqrt(this.accel(car) * this.comfortDecel(car)));
      const desiredGap = cfg.minGapFt + Math.max(0, dynamic);
      const ratio = desiredGap / Math.max(gap, 0.01);
      return ratio * ratio;
    }

    accelerationIn(car, lane, leader, extraLeader) {
      const v0 = this.desiredSpeedAt(car, lane, car.x);
      let interaction = 0;
      for (const other of [leader, extraLeader]) {
        if (other) {
          interaction = Math.max(interaction,
            this.interaction(car, other.x - other.len - car.x, other.v));
        }
      }
      if (car.x < this.chokeX && this.lanesNeeded(car, lane) > 0) {
        // This lane doesn't go where the driver wants: treat the
        // choke-point as a stopped obstacle.
        interaction = Math.max(interaction, this.interaction(car, this.chokeX - car.x, 0));
      }
      const free = Math.pow(car.v / Math.max(v0, 0.1), 4);
      return Math.max(-this.maxDecel, this.accel(car) * (1 - free - interaction));
    }

    // A courteous driver slows for a car just ahead in the next lane that is
    // trying to get into this lane near the choke-point.
    // Everyone yields to the priority car; others only if courteous.
    courtesyLeader(car) {
      let best = null;
      const p = this.priority;
      if (p && this.mergeLane(p) === car.lane) {
        const gap = p.x - p.len - car.x;
        if (gap > 0 && gap <= cfg.courtesyRangeFt) best = p;
      }
      if (!car.courteous) return best;
      for (const side of [car.lane - 1, car.lane + 1]) {
        if (side < 0 || side >= this.lanesBefore) continue;
        const lane = this.lanes[side];
        const at = locate(lane, car.x);
        const other = at > 0 ? lane[at - 1] : null;
        if (!other || other.mergeTarget !== car.lane) continue;
        const gap = other.x - other.len - car.x;
        if (gap <= 0 || gap > cfg.courtesyRangeFt) continue;
        if (!best || other.x < best.x) best = other;
      }
      return best;
    }

    // ----- lane changing -----

    // The adjacent lane a car is trying to move into, or -1.
    mergeLane(car) {
      if (!car.urgent) return -1;
      const [lo] = this.targetRange(car);
      return car.lane + (car.lane < lo ? 1 : -1);
    }

    // Does the car physically fit beside the given neighbors, with room
    // for the follower to stop under hard braking?
    hasRoom(car, leader, follower) {
      if (leader && leader.x - leader.len - car.x < cfg.priorityGapFt) return false;
      if (follower) {
        const stopping = follower.v * follower.v / (2 * this.maxDecel);
        if (car.x - car.len - follower.x < cfg.priorityGapFt + stopping) return false;
      }
      return true;
    }

    neighborsIn(laneIndex, x) {
      const lane = this.lanes[laneIndex];
      const at = locate(lane, x);
      return {
        at,
        leader: at > 0 ? lane[at - 1] : null,
        follower: at < lane.length ? lane[at] : null,
      };
    }

    // A stopped car that needs to change lanes and isn't overlapping
    // anyone in the lane it wants.
    canHavePriority(car) {
      const target = this.mergeLane(car);
      if (target < 0 || car.v >= cfg.stoppedFps || car.x >= this.chokeX) return false;
      const { leader, follower } = this.neighborsIn(target, car.x);
      if (leader && leader.x - leader.len - car.x < cfg.priorityGapFt) return false;
      if (follower && car.x - car.len - follower.x < cfg.priorityGapFt) return false;
      return true;
    }

    // The farthest-forward eligible stopped car gets to go (ties broken at
    // random). It keeps priority until it has merged.
    updatePriority() {
      if (this.priority && this.canHavePriority(this.priority)) return;
      let candidates = [];
      let farthest = -Infinity;
      for (const car of this.cars) {
        if (car.x < farthest - cfg.priorityTieFt || !this.canHavePriority(car)) continue;
        candidates.push(car);
        farthest = Math.max(farthest, car.x);
      }
      candidates = candidates.filter((car) => car.x >= farthest - cfg.priorityTieFt);
      this.priority = candidates.length ? candidates[this.rng.int(candidates.length)] : null;
    }

    // A driver who has to get over lines up with a gap in the next lane:
    // the middle of the gap beside them if it is big enough, otherwise the
    // middle of the one just behind (dropping back to it). If neither will
    // do, they at least stay behind the car beside them so that a courteous
    // follower's gap can open up. Returns a cap on acceleration (Infinity
    // when not seeking a gap); gap seeking never brakes harder than is
    // comfortable.
    gapSeekingAcceleration(car) {
      const target = this.mergeLane(car);
      if (target < 0 || car === this.priority || car.x >= this.chokeX) return Infinity;
      const { at, leader, follower } = this.neighborsIn(target, car.x);
      if (!leader) return Infinity;
      const behind = this.lanes[target][at + 1];
      const headway = this.mergeHeadway(car);
      const fits = (front, back) => !back || front.x - front.len - back.x
        >= car.len + 2 * cfg.safeGapFt + headway * (front.v + back.v);
      const middle = (front, back) => back && (front.x - front.len + back.x + car.len) / 2;

      let front = leader;
      let aimX;
      if (!follower) {
        // Open road behind the car beside: just keep behind it.
      } else if (fits(leader, follower)) {
        aimX = middle(leader, follower);
      } else if (fits(follower, behind)) {
        front = follower;
        aimX = middle(follower, behind);
      }

      // A stand-in leader whose following distance puts the car at aimX.
      const rearX = aimX === undefined
        ? front.x - front.len
        : aimX + cfg.minGapFt + car.v * cfg.headwaySec;
      if (rearX <= car.x) return car.v >= front.v ? -this.comfortDecel(car) : 0;
      return Math.max(-this.comfortDecel(car),
        this.accelerationIn(car, car.lane, { x: rearX, len: 0, v: front.v }));
    }

    requiredGap(follower, leader, followerDecel, headway) {
      const vf = follower.v;
      const vl = leader.v;
      return cfg.safeGapFt + vf * headway
        + Math.max(0, (vf * vf - vl * vl) / (2 * followerDecel));
    }

    isSafe(car, leader, follower, headway = cfg.safeHeadwaySec) {
      if (leader) {
        const gap = leader.x - leader.len - car.x;
        if (gap < this.requiredGap(car, leader, this.comfortDecel(car), headway)) return false;
      }
      if (follower) {
        const gap = car.x - car.len - follower.x;
        if (gap < this.requiredGap(follower, car, this.comfortDecel(follower), headway)) return false;
      }
      return true;
    }

    considerLaneChange(car) {
      const [lo] = this.targetRange(car);
      const need = this.lanesNeeded(car, car.lane);
      const dist = this.chokeX - car.x;
      const beforeChoke = dist > 0;
      // Eagerness 1 commits from the arrival point; eagerness 0 waits until
      // just enough room remains for the needed lane changes. Cars backed
      // up behind the arrival point count as being at it.
      const horizon = this.eagerness(car) * cfg.arrivalToChokeFt
        + cfg.perLaneChangeFt * Math.max(1, need);
      const committed = beforeChoke && Math.min(dist, cfg.arrivalToChokeFt) <= horizon;
      const urgent = committed && need > 0;
      car.urgent = urgent;
      if (!urgent) car.commitX = null;
      else if (car.commitX === null) car.commitX = car.x;

      car.mergeTarget = urgent && dist < this.courtesyZone(car)
        ? car.lane + (car.lane < lo ? 1 : -1)
        : -1;
      car.nextEval = this.time + (urgent ? 0 : cfg.laneChangeEvalSec * (0.5 + this.rng()));
      if (this.time - car.lastChange < cfg.laneChangeCooldownSec) return;

      const current = this.lanes[car.lane];
      const index = current.indexOf(car);
      const accNow = this.accelerationIn(car, car.lane, index > 0 ? current[index - 1] : null);
      const threshold = mphToFps(cfg.laneChangeThresholdMphps);
      let best = null;
      let bestScore = 0;

      for (const candidate of [car.lane - 1, car.lane + 1]) {
        if (!this.laneExists(candidate, car.x)) continue;
        // Past the choke-point the ramp and the through lanes are separate roads.
        if (!beforeChoke && (candidate < this.lanesAfter) !== (car.lane < this.lanesAfter)) continue;
        const candidateNeed = this.lanesNeeded(car, candidate);
        if (committed && candidateNeed > need) continue;

        const lane = this.lanes[candidate];
        const at = locate(lane, car.x);
        const leader = at > 0 ? lane[at - 1] : null;
        const follower = at < lane.length ? lane[at] : null;
        const merging = committed && candidateNeed < need;
        const prioritized = car === this.priority && candidateNeed < need;
        const headway = merging ? this.mergeHeadway(car) : cfg.safeHeadwaySec;
        if (prioritized ? !this.hasRoom(car, leader, follower) : !this.isSafe(car, leader, follower, headway)) continue;

        let score;
        if (merging) {
          score = Infinity;
        } else {
          const accThere = this.accelerationIn(car, candidate, leader);
          let followerCost = 0;
          if (follower) {
            const before = this.accelerationIn(follower, candidate, leader);
            const after = this.accelerationIn(follower, candidate, car);
            followerCost = Math.max(0, before - after);
          }
          score = accThere - accNow - cfg.politeness * followerCost - threshold;
        }
        if (score > bestScore) {
          bestScore = score;
          best = { candidate, at };
        }
      }

      if (best) {
        current.splice(index, 1);
        this.lanes[best.candidate].splice(best.at, 0, car);
        car.lane = best.candidate;
        car.lastChange = this.time;
        car.mergeTarget = -1;
      }
    }

    // ----- adding cars -----

    // Fastest speed (up to the car's desired speed) at which a car could be
    // placed at x in this lane without crowding anyone, or -1 if none.
    entrySpeed(lane, spec, x) {
      const cars = this.lanes[lane];
      const at = locate(cars, x);
      const leader = at > 0 ? cars[at - 1] : null;
      const follower = at < cars.length ? cars[at] : null;
      const v0 = mphToFps(this.settings.highwayMph) * spec.speedFactor;
      const probe = { x, len: cfg.carLengthFt, v: 0, decelFactor: spec.decelFactor };
      const steps = 20;
      for (let k = 0; k <= steps; k++) {
        probe.v = v0 * (1 - k / steps);
        if (this.isSafe(probe, leader, follower, cfg.entryHeadwaySec)) return probe.v;
      }
      return -1;
    }

    // The first place at or behind x where a new car can join its lane.
    entryPoint(spec, x = 0) {
      const lane = this.lanes[spec.lane];
      for (;;) {
        if (this.entrySpeed(spec.lane, spec, x) >= 0) return x;
        // Skip past whichever car is in the way.
        const at = locate(lane, x);
        const blocker = at < lane.length ? lane[at] : lane[at - 1];
        const behind = blocker.x - blocker.len - cfg.minGapFt;
        x = behind < x ? behind : x - 1;
      }
    }

    addCar(spec, x, v) {
      const car = {
        ...spec,
        x,
        v,
        len: cfg.carLengthFt,
        visLane: spec.lane,
        acc: 0,
        lastChange: -Infinity,
        nextEval: this.time,
        mergeTarget: -1,
        urgent: false,
        commitX: null,
        wallWait: 0,
        diverted: false,
      };
      const lane = this.lanes[car.lane];
      lane.splice(locate(lane, x), 0, car);
      this.cars.push(car);
      return car;
    }

    // ----- stepping -----

    step(dt) {
      this.time += dt;

      this.updatePriority();
      for (const car of this.cars) {
        if (this.time >= car.nextEval) this.considerLaneChange(car);
      }

      for (const lane of this.lanes) {
        for (let i = 0; i < lane.length; i++) {
          const car = lane[i];
          car.acc = Math.min(
            this.accelerationIn(car, car.lane, i > 0 ? lane[i - 1] : null, this.courtesyLeader(car)),
            this.gapSeekingAcceleration(car));
        }
      }

      // Front-to-back, so each car sees where its leader ended up.
      for (const lane of this.lanes) {
        let leader = null;
        for (const car of lane) {
          this.advance(car, leader, dt);
          leader = car;
        }
      }

      const visualRate = dt / cfg.laneChangeDurationSec;
      for (const car of this.cars) {
        const delta = car.lane - car.visLane;
        car.visLane += Math.max(-visualRate, Math.min(visualRate, delta));
      }

      this.removeFinished();
    }

    advance(car, leader, dt) {
      const a = car.acc;
      let v = car.v + a * dt;
      let dx;
      if (v < 0) {
        dx = a < 0 ? (car.v * car.v) / (-2 * a) : 0;
        v = 0;
      } else {
        dx = 0.5 * (car.v + v) * dt;
      }
      let x = car.x + dx;

      if (leader) {
        const maxX = leader.x - leader.len - cfg.hardGapFt;
        if (x > maxX) {
          x = Math.max(car.x, maxX);
          v = Math.min(v, leader.v);
        }
      }

      if (car.x < this.chokeX && this.lanesNeeded(car, car.lane) > 0) {
        const wallX = this.chokeX - cfg.hardGapFt;
        if (x > wallX) {
          x = Math.max(car.x, wallX);
          v = 0;
        }
        if (wallX - x < cfg.wallZoneFt && v < cfg.stoppedFps) {
          car.wallWait += dt;
          if (this.isExit && car.wallWait > cfg.giveUpSec * car.giveUpFactor) {
            // Missed the exit, or forced off at it.
            car.diverted = !car.diverted;
            car.wallWait = 0;
            this.diverted++;
          }
        } else {
          car.wallWait = 0;
        }
      }

      if (car.x < this.chokeX && x >= this.chokeX) this.chokePasses.push(this.time);
      car.x = x;
      car.v = v;
    }

    removeFinished() {
      let removed = false;
      for (const lane of this.lanes) {
        while (lane.length && lane[0].x > this.endX) {
          const car = lane.shift();
          this.completed++;
          this.completions.push({ time: this.time, trip: this.time - car.createdAt });
          removed = true;
        }
      }
      if (removed) this.cars = this.cars.filter((car) => car.x <= this.endX);
    }

    stats() {
      const now = this.time;
      while (this.completions.length && this.completions[0].time < now - cfg.statsWindowSec) {
        this.completions.shift();
      }
      while (this.chokePasses.length && this.chokePasses[0] < now - cfg.flowWindowSec) {
        this.chokePasses.shift();
      }
      const count = this.completions.length;
      const meanTrip = count ? this.completions.reduce((sum, c) => sum + c.trip, 0) / count : NaN;
      const tripVariance = count
        ? this.completions.reduce((sum, c) => sum + (c.trip - meanTrip) ** 2, 0) / count
        : NaN;
      const flowSpan = Math.max(1, Math.min(cfg.flowWindowSec, now));
      // Speeds of the cars still approaching the choke-point.
      const speeds = this.cars.filter((car) => car.x < this.chokeX).map((car) => car.v);
      const meanSpeed = speeds.length ? speeds.reduce((sum, v) => sum + v, 0) / speeds.length : NaN;
      const speedVariance = speeds.length
        ? speeds.reduce((sum, v) => sum + (v - meanSpeed) ** 2, 0) / speeds.length
        : NaN;
      return {
        eagerness: this.settings.eagerness[this.which],
        onRoad: this.cars.length,
        avgMph: fpsToMph(meanSpeed),
        speedStdDevMph: fpsToMph(Math.sqrt(speedVariance)),
        completed: this.completed,
        diverted: this.diverted,
        avgTripSec: meanTrip,
        tripStdDevSec: Math.sqrt(tripVariance),
        flowPerMin: this.chokePasses.length * 60 / flowSpan,
      };
    }
  }

  Zipper.Simulation = Simulation;
})();
