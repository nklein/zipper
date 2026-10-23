'use strict';

(function () {
  const cfg = Zipper.config;

  function smoothstep(t) {
    const u = Math.max(0, Math.min(1, t));
    return u * u * (3 - 2 * u);
  }

  // All colors and sizes come from CSS custom properties on the canvas.
  function readStyle(canvas) {
    const css = getComputedStyle(canvas);
    const value = (name) => css.getPropertyValue(name).trim();
    const number = (name, fallback) => {
      const n = parseFloat(value(name));
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      roadSurface: value('--road-surface'),
      roadEdge: value('--road-edge'),
      laneMarking: value('--lane-marking'),
      chokeMarking: value('--choke-marking'),
      carColors: value('--car-colors').split(',').map((c) => c.trim()).filter(Boolean),
      carOutline: value('--car-outline'),
      exitMarker: value('--exit-marker'),
      maxLaneHeight: number('--max-lane-height', 20),
      padding: number('--road-padding', 8),
      carSize: number('--car-size', 0.35),
      lineWidth: number('--line-width', 1),
      exitMarkerWidth: number('--exit-marker-width', 2),
      dash: value('--lane-dash').split(/[\s,]+/).map(Number).filter(Number.isFinite),
    };
  }

  class Renderer {
    constructor(canvas, sim) {
      this.canvas = canvas;
      this.sim = sim;
      this.ctx = canvas.getContext('2d');
    }

    resize() {
      const canvas = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { width, height };
    }

    layout(width, height, style) {
      const sim = this.sim;
      const exitLanes = sim.lanesBefore - sim.lanesAfter;
      const units = sim.isExit ? sim.lanesBefore + exitLanes + 1 : sim.lanesBefore;
      const laneHeight = Math.min(style.maxLaneHeight, (height - 2 * style.padding) / units);
      const top = (height - units * laneHeight) / 2;
      const startX = sim.chokeX - cfg.viewBeforeFt;
      const endX = sim.chokeX + cfg.viewAfterFt;
      const scale = width / (endX - startX);
      const rampDrop = (exitLanes + 1) * laneHeight;
      return {
        laneHeight,
        top,
        startX,
        endX,
        scale,
        px: (x) => (x - startX) * scale,
        drop: (x) => (sim.isExit && x > sim.chokeX
          ? rampDrop * smoothstep((x - sim.chokeX) / cfg.rampCurveFt)
          : 0),
      };
    }

    draw() {
      const { width, height } = this.resize();
      const style = readStyle(this.canvas);
      const view = this.layout(width, height, style);
      this.ctx.clearRect(0, 0, width, height);
      this.drawRoad(view, style);
      this.drawMarkings(view, style);
      this.drawCars(view, style);
    }

    // y of the boundary above lane `edge` (fractional lanes allowed).
    edgeY(view, edge, x, onRamp) {
      return view.top + edge * view.laneHeight + (onRamp ? view.drop(x) : 0);
    }

    rampPoints(view, edge) {
      const sim = this.sim;
      const points = [];
      const samples = 48;
      for (let i = 0; i <= samples; i++) {
        const x = sim.chokeX + (view.endX - sim.chokeX) * (i / samples);
        points.push([view.px(x), this.edgeY(view, edge, x, true)]);
      }
      return points;
    }

    drawRoad(view, style) {
      const ctx = this.ctx;
      const sim = this.sim;
      const N = sim.lanesBefore;
      const M = sim.lanesAfter;
      const y = (edge) => this.edgeY(view, edge, 0, false);
      const right = view.px(view.endX);

      ctx.fillStyle = style.roadSurface;
      ctx.beginPath();
      if (sim.isExit) {
        const chokePx = view.px(sim.chokeX);
        const yM = y(M);
        const yN = y(N);
        ctx.fillRect(0, view.top, right, M * view.laneHeight);
        ctx.rect(0, yM, chokePx, yN - yM);
        ctx.fill();
        const upper = this.rampPoints(view, M);
        const lower = this.rampPoints(view, N).reverse();
        ctx.beginPath();
        [...upper, ...lower].forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
      } else {
        const first = sim.lanesEndingLeft;
        const outline = [...this.reductionEdge(view, 0), [right, y(first)],
          [right, y(first + M)], ...this.reductionEdge(view, N).reverse()];
        outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
      }
      ctx.fill();
    }

    // At a lane reduction, the lanes that end squeeze into the nearest
    // continuing lane along the taper.
    squeezedEdge(edge) {
      const first = this.sim.lanesEndingLeft;
      const last = first + this.sim.lanesAfter;
      return Math.max(first, Math.min(last, edge));
    }

    // Points along the boundary above lane `edge` of a lane reduction, up to
    // the choke-point if it ends there, and on to the end of the view if not.
    reductionEdge(view, edge) {
      const sim = this.sim;
      const y = (e) => this.edgeY(view, e, 0, false);
      const squeezed = this.squeezedEdge(edge);
      const points = [[0, y(edge)], [view.px(sim.chokeX - cfg.taperFt), y(edge)],
        [view.px(sim.chokeX), y(squeezed)]];
      if (squeezed === edge) points.push([view.px(view.endX), y(edge)]);
      return points;
    }

    strokeLine(points, color, dash) {
      const ctx = this.ctx;
      ctx.strokeStyle = color;
      ctx.setLineDash(dash);
      ctx.beginPath();
      points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }

    drawMarkings(view, style) {
      const ctx = this.ctx;
      const sim = this.sim;
      const N = sim.lanesBefore;
      const M = sim.lanesAfter;
      const left = 0;
      const right = view.px(view.endX);
      const chokePx = view.px(sim.chokeX);
      const y = (edge) => this.edgeY(view, edge, 0, false);
      const solid = [];
      const dashed = style.dash;

      ctx.lineWidth = style.lineWidth;

      if (sim.isExit) {
        // Through lanes.
        this.strokeLine([[left, y(0)], [right, y(0)]], style.roadEdge, solid);
        for (let edge = 1; edge < M; edge++) {
          this.strokeLine([[left, y(edge)], [right, y(edge)]], style.laneMarking, dashed);
        }
        this.strokeLine([[left, y(M)], [chokePx, y(M)]], style.laneMarking, dashed);
        this.strokeLine([[chokePx, y(M)], [right, y(M)]], style.roadEdge, solid);

        // Lanes that exit.
        for (let edge = M + 1; edge < N; edge++) {
          this.strokeLine([[left, y(edge)], [chokePx, y(edge)], ...this.rampPoints(view, edge)],
            style.laneMarking, dashed);
        }
        this.strokeLine(this.rampPoints(view, M), style.roadEdge, solid);
        this.strokeLine([[left, y(N)], [chokePx, y(N)], ...this.rampPoints(view, N)],
          style.roadEdge, solid);
      } else {
        // The edges of the continuing lanes are dashed until the lanes beside
        // them end, and solid after.
        const first = sim.lanesEndingLeft;
        for (let edge = 0; edge <= N; edge++) {
          const points = this.reductionEdge(view, edge);
          const outer = edge === 0 || edge === N;
          const sides = !outer && (edge === first || edge === first + M);
          this.strokeLine(sides ? points.slice(0, 3) : points,
            outer ? style.roadEdge : style.laneMarking, outer ? solid : dashed);
          if (sides) this.strokeLine(points.slice(2), style.roadEdge, solid);
        }
      }

      // The choke-point itself.
      this.strokeLine([[chokePx, y(0)], [chokePx, y(N)]], style.chokeMarking, dashed);
      ctx.setLineDash([]);
    }

    carY(view, car) {
      const sim = this.sim;
      const onRamp = sim.isExit && car.lane >= sim.lanesAfter;
      let position = car.visLane + 0.5;
      const squeezed = sim.isExit ? position : this.squeezedEdge(position);
      if (squeezed !== position) {
        // Squeeze cars in an ending lane along the taper.
        const t = Math.max(0, Math.min(1, (car.x - (sim.chokeX - cfg.taperFt)) / cfg.taperFt));
        position = squeezed + (position - squeezed) * (1 - 0.8 * t);
      }
      return this.edgeY(view, position, car.x, onRamp);
    }

    drawCars(view, style) {
      const ctx = this.ctx;
      const sim = this.sim;
      const colors = style.carColors.length ? style.carColors : [style.carOutline];
      const radius = Math.max(1.5, Math.min(view.laneHeight * style.carSize,
        view.scale * (cfg.carLengthFt + cfg.minGapFt) * 0.45));
      const margin = radius / view.scale + cfg.carLengthFt;

      ctx.setLineDash([]);
      for (const car of sim.cars) {
        if (car.x < view.startX - margin || car.x - car.len > view.endX + margin) continue;
        const cx = view.px(car.x - car.len / 2);
        const cy = this.carY(view, car);
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
        ctx.fillStyle = colors[car.colorIndex % colors.length];
        ctx.fill();
        if (sim.isExit && car.wantsExit) {
          ctx.lineWidth = style.exitMarkerWidth;
          ctx.strokeStyle = style.exitMarker;
        } else {
          ctx.lineWidth = style.lineWidth;
          ctx.strokeStyle = style.carOutline;
        }
        ctx.stroke();
      }
    }
  }

  Zipper.Renderer = Renderer;
})();
