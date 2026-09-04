/**
 * The dynamics of a pen stroke, after Plamondon's Kinematic Theory.
 *
 * A pen-down chain is a sequence of strokes, each aimed at a virtual target
 * along a circular arc. Each stroke's speed profile is a lognormal bell
 * (Sigma-Lognormal model: O'Reilly & Plamondon 2009; Plamondon et al. 2014),
 * and strokes overlap in time: the next one starts before the previous has
 * finished, so the pen never quite reaches its targets and the corners
 * between strokes round off - the sharper the shorter the overlap. The sum
 * of the displacements still lands exactly on the last target. The
 * parameterisation from a duration and a skew is Berio, Fol Leymarie &
 * Plamondon's (2017).
 */

/** Lognormal parameters for a stroke of duration T and skew Ac (0.1 is a natural default). */
export function lognormalParams(T, Ac = 0.1) {
  const sigma = Math.sqrt(-Math.log(1 - Ac));
  const mu = 3 * sigma - Math.log((Math.exp(6 * sigma) - 1) / T);
  return { mu, sigma };
}

function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

const pdf = (t, t0, mu, sigma) => {
  const x = t - t0;
  if (x <= 0) return 0;
  const l = Math.log(x);
  return Math.exp(-((l - mu) ** 2) / (2 * sigma * sigma)) / (x * sigma * Math.sqrt(2 * Math.PI));
};
const cdf = (t, t0, mu, sigma) => {
  const x = t - t0;
  if (x <= 0) return 0;
  return 0.5 * (1 + erf((Math.log(x) - mu) / (sigma * Math.SQRT2)));
};

/**
 * Integrate one pen-down chain.
 *
 * @param {Array<{to:number[], arc:number, T:number, t0:number, Ac?:number, p?:number}>} strokes
 *        in order; each stroke runs from the previous stroke's target (the
 *        first from `start`) to `to`, turning through `arc` radians
 *        (counter-clockwise positive, y up), lasting about T seconds from
 *        onset t0, with pressure hint p (0 hairline .. 1 full shade)
 * @param {number[]} start  where the chain begins
 * @param {number} rate     samples per second
 * @returns {{pts:number[][], times:number[], pressure:number[]}}
 */
export function integrateChain(strokes, start, rate = 200) {
  const S = [];
  let from = start;
  for (const st of strokes) {
    const dx = st.to[0] - from[0], dy = st.to[1] - from[1];
    const chord = Math.hypot(dx, dy);
    const chordAngle = Math.atan2(dy, dx);
    const arc = st.arc || 0;
    const D = Math.abs(arc) < 1e-4 ? chord : (chord * arc) / (2 * Math.sin(arc / 2));
    const { mu, sigma } = lognormalParams(Math.max(0.02, st.T), st.Ac ?? 0.1);
    S.push({ D, thetaS: chordAngle - arc / 2, thetaE: chordAngle + arc / 2, t0: st.t0, mu, sigma, p: st.p ?? 0, T: st.T });
    from = st.to;
  }
  if (!S.length) return { pts: [start.slice()], times: [0], pressure: [0] };
  const tStart = Math.min(...S.map((s) => s.t0));
  // a lognormal's tail: the stroke is essentially over when its CDF passes 0.999
  const tEnd = Math.max(...S.map((s) => s.t0 + Math.exp(s.mu + 3.1 * s.sigma)));
  const dt = 1 / rate;
  const pts = [], times = [], pressure = [];
  let x = start[0], y = start[1];
  for (let t = tStart; t <= tEnd + dt; t += dt) {
    let vx = 0, vy = 0, vsum = 0, psum = 0;
    for (const s of S) {
      const v = s.D * pdf(t, s.t0, s.mu, s.sigma);
      if (v <= 0) continue;
      const c = cdf(t, s.t0, s.mu, s.sigma);
      const phi = s.thetaS + (s.thetaE - s.thetaS) * c;
      vx += v * Math.cos(phi);
      vy += v * Math.sin(phi);
      vsum += v;
      // the shade swells over the first half of the stroke: a downstroke's bell
      // starts while the pen is still on the crest above it
      psum += v * s.p * Math.min(1, 2 * c);
    }
    pts.push([x, y]);
    times.push(t - tStart);
    pressure.push(vsum > 1e-9 ? psum / vsum : 0);
    x += vx * dt;
    y += vy * dt;
  }
  return { pts, times, pressure };
}
