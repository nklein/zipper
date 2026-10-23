'use strict';

(function () {
  const cfg = Zipper.config;
  const byId = (id) => document.getElementById(id);

  const settings = {
    chokeType: 'exit',
    lanesBefore: 3,
    lanesAfter: 2,
    exitShare: 30,
    highwayMph: 65,
    limitMph: 65,
    arrivalRate: 1.5,
    eagerness: [0, 30],
  };

  // Blank or half-typed number inputs keep the previous value.
  function readNumber(id, fallback, min, max) {
    const input = byId(id);
    const n = parseFloat(input.value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max ?? parseFloat(input.max), Math.max(min ?? parseFloat(input.min), n));
  }

  function readSettings() {
    settings.chokeType = byId('chokeType').value;
    settings.lanesBefore = Math.round(readNumber('lanesBefore', settings.lanesBefore));
    const lanesAfter = byId('lanesAfter');
    lanesAfter.max = settings.lanesBefore - 1;
    settings.lanesAfter = Math.round(readNumber('lanesAfter', settings.lanesAfter, 1, settings.lanesBefore - 1));
    settings.exitShare = readNumber('exitShare', settings.exitShare);
    settings.highwayMph = readNumber('highwayMph', settings.highwayMph);
    settings.limitMph = readNumber('limitMph', settings.limitMph);
    settings.arrivalRate = readNumber('arrivalRate', settings.arrivalRate);
    settings.eagerness[0] = readNumber('eagerA', settings.eagerness[0]);
    settings.eagerness[1] = readNumber('eagerB', settings.eagerness[1]);
  }

  function showSettings() {
    const isExit = settings.chokeType === 'exit';
    for (const element of document.querySelectorAll('[data-exit-only]')) element.hidden = !isExit;
    byId('limitLabel').textContent = isExit ? 'Off-ramp speed limit' : 'Reduced-lanes speed limit';
    byId('eagerAValue').value = settings.eagerness[0];
    byId('eagerBValue').value = settings.eagerness[1];
    byId('exitShareValue').value = `${settings.exitShare}%`;
  }

  readSettings();
  const traffic = new Zipper.Traffic(settings);
  const figures = [byId('simA'), byId('simB')];
  const renderers = figures.map((figure, i) =>
    new Zipper.Renderer(figure.querySelector('canvas'), traffic.sims[i]));

  // ----- controls -----

  let playing = true;
  let speedIndex = cfg.defaultPlaybackIndex;

  function showPlayback() {
    byId('play').disabled = playing;
    byId('pause').disabled = !playing;
    byId('slower').disabled = speedIndex === 0;
    byId('faster').disabled = speedIndex === cfg.playbackSpeeds.length - 1;
    byId('playbackSpeed').value = `${cfg.playbackSpeeds[speedIndex]}×`;
  }

  const form = byId('controls');
  const structural = new Set(['chokeType', 'lanesBefore', 'lanesAfter']);

  form.addEventListener('submit', (event) => event.preventDefault());
  form.addEventListener('input', (event) => {
    if (structural.has(event.target.id)) return;
    readSettings();
    showSettings();
  });
  form.addEventListener('change', (event) => {
    readSettings();
    showSettings();
    if (structural.has(event.target.id)) {
      byId('lanesAfter').value = settings.lanesAfter;
      traffic.reset();
    }
  });

  byId('play').addEventListener('click', () => { playing = true; showPlayback(); });
  byId('pause').addEventListener('click', () => { playing = false; showPlayback(); });
  byId('slower').addEventListener('click', () => { speedIndex = Math.max(0, speedIndex - 1); showPlayback(); });
  byId('faster').addEventListener('click', () => {
    speedIndex = Math.min(cfg.playbackSpeeds.length - 1, speedIndex + 1);
    showPlayback();
  });
  byId('clear').addEventListener('click', () => { readSettings(); traffic.reset(); });

  // ----- stats -----

  function formatClock(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  function showStats() {
    byId('clock').value = formatClock(traffic.time);
    traffic.sims.forEach((sim, i) => {
      const stats = sim.stats();
      const outputs = figures[i].querySelectorAll('output[name]');
      for (const output of outputs) {
        const value = stats[output.name];
        if (output.name.endsWith('Sec')) output.value = Number.isFinite(value) ? formatClock(value) : '—';
        else if (output.name === 'flowPerMin') output.value = value.toFixed(0);
        else output.value = value;
      }
    });
  }

  // ----- main loop -----

  let last = performance.now();
  let pending = 0;
  let lastStats = 0;

  function frame(now) {
    const elapsed = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (playing) {
      pending += elapsed * cfg.realTimeScale * cfg.playbackSpeeds[speedIndex];
      let steps = 0;
      while (pending >= cfg.stepSec && steps < cfg.maxStepsPerFrame) {
        traffic.step(cfg.stepSec);
        pending -= cfg.stepSec;
        steps++;
      }
      if (steps === cfg.maxStepsPerFrame) pending = 0;
    }
    for (const renderer of renderers) renderer.draw();
    if (now - lastStats > 250) {
      showStats();
      lastStats = now;
    }
    requestAnimationFrame(frame);
  }

  Zipper.app = { settings, traffic };  // handy from the console

  showSettings();
  showPlayback();
  showStats();
  requestAnimationFrame(frame);
})();
