'use strict';

(function () {
  const cfg = Zipper.config;
  const { mphToFps } = Zipper.units;

  function perturbation(rng, spread) {
    const z = Math.max(-cfg.perturbationLimit, Math.min(cfg.perturbationLimit, rng.normal()));
    return spread * z;
  }

  // Runs the two simulations in lock-step and feeds them identical cars.
  class Traffic {
    constructor(settings) {
      this.settings = settings;
      this.sims = [0, 1].map((which) => new Zipper.Simulation(settings, which));
      this.reset();
    }

    reset() {
      const seed = (Math.random() * 4294967296) >>> 0;
      this.rng = Zipper.makeRandom(seed);
      this.time = 0;
      this.nextId = 0;
      for (const sim of this.sims) sim.reset(seed ^ 0x9E3779B9);
      this.prepopulate();
    }

    makeSpec() {
      const rng = this.rng;
      const s = this.settings;
      return {
        id: this.nextId++,
        lane: rng.int(s.lanesBefore),
        colorIndex: rng.int(1 << 30),
        wantsExit: rng() < s.exitShare / 100,
        courteous: rng() < cfg.courtesyProbability,
        speedFactor: 1 + perturbation(rng, cfg.speedSpread),
        accelFactor: 1 + perturbation(rng, cfg.accelSpread),
        decelFactor: 1 + perturbation(rng, cfg.decelSpread),
        eagerNoise: perturbation(rng, cfg.eagernessSpread),
        giveUpFactor: 1 + perturbation(rng, cfg.giveUpSpread),
        createdAt: this.time,
      };
    }

    // Adds the car to both simulations, or neither.
    tryAdd(spec, x) {
      const v = Math.min(...this.sims.map((sim) => sim.entrySpeed(spec.lane, spec, x)));
      if (v < 0) return false;
      for (const sim of this.sims) sim.addCar(spec, x, v);
      return true;
    }

    // Joins both roads at the same place: the arrival point if both have
    // room, otherwise far enough back that both do.
    addArrival(spec) {
      let x = 0;
      for (;;) {
        const xs = this.sims.map((sim) => sim.entryPoint(spec, x));
        if (xs.every((at) => at === x)) break;
        x = Math.min(...xs);
      }
      this.tryAdd(spec, x);
    }

    // Scatter cars between the arrival point and the visible part of the
    // road, as if they had arrived over the last little while.
    prepopulate() {
      const rate = this.settings.arrivalRate;
      if (!(rate > 0)) return;
      const span = cfg.arrivalToChokeFt - cfg.viewBeforeFt - cfg.prepopulateMarginFt;
      const vBase = mphToFps(this.settings.highwayMph);
      const horizon = span / vBase;
      for (let t = this.rng.exponential(rate); t < horizon; t += this.rng.exponential(rate)) {
        const spec = this.makeSpec();
        spec.createdAt = -t;
        this.tryAdd(spec, Math.min(span, vBase * spec.speedFactor * t));
      }
    }

    step(dt) {
      this.time += dt;
      const arrivals = this.rng.poisson(Math.max(0, this.settings.arrivalRate) * dt);
      for (let i = 0; i < arrivals; i++) this.addArrival(this.makeSpec());
      for (const sim of this.sims) sim.step(dt);
    }
  }

  Zipper.Traffic = Traffic;
})();
