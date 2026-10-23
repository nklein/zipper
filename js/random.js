'use strict';

// Small seeded PRNG (mulberry32) with a few distributions bolted on.
Zipper.makeRandom = function (seed) {
  let state = seed >>> 0;

  const next = function () {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  next.int = (n) => Math.floor(next() * n);

  next.normal = () => {
    let u = 0;
    while (u === 0) u = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };

  next.exponential = (rate) => -Math.log(1 - next()) / rate;

  next.poisson = (mean) => {
    if (!(mean > 0)) return 0;
    const limit = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= next();
    } while (p > limit);
    return k - 1;
  };

  return next;
};
