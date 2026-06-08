// A brilliant-cut diamond in PROFILE (side view): flat table on top, crown
// shoulders out to the widest girdle, then a faceted pavilion tapering to a culet
// point. Same luxury treatment as before — dramatic facet scintillation, prismatic
// fire, a rainbow sheen sweep, a luminous table, a halo, and twinkling glints.

type P = [number, number];
const s = ([x, y]: P) => `${x.toFixed(1)},${y.toFixed(1)}`;

// silhouette + key points
const TABLE_L: P = [42, 18];
const TABLE_R: P = [78, 18];
const GIRD_L: P = [14, 40];
const GIRD_R: P = [106, 40];
const BREAK_L: P = [40, 40];
const BREAK_R: P = [80, 40];
const CULET: P = [60, 108];
const SIL: P[] = [TABLE_L, TABLE_R, GIRD_R, CULET, GIRD_L];

// crown: bright table trapezoid flanked by two darker bezels
const TABLE: P[] = [TABLE_L, TABLE_R, BREAK_R, BREAK_L];
const BEZEL_L: P[] = [TABLE_L, BREAK_L, GIRD_L];
const BEZEL_R: P[] = [TABLE_R, BREAK_R, GIRD_R];

// pavilion: wedges from the girdle converging on the culet
const GX = [14, 27, 40, 53, 67, 80, 93, 106];
const PAV: P[][] = GX.slice(0, -1).map((x, k) => [[x, 40], [GX[k + 1], 40], CULET]);
const PAV_FILL = ["#33394a", "#aee0f0", "#dbe4f0", "#2c313d", "#e7eef8", "#cdb8e8", "#363d4b"];

const glint = (x: number, y: number, r: number) =>
  `M${x} ${y - r} L${x + r * 0.24} ${y - r * 0.24} L${x + r} ${y} L${x + r * 0.24} ${y + r * 0.24} ` +
  `L${x} ${y + r} L${x - r * 0.24} ${y + r * 0.24} L${x - r} ${y} L${x - r * 0.24} ${y - r * 0.24} Z`;

export default function Diamond({ className = "h-28 w-28" }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 122" className={`${className} diamond-float`} aria-hidden>
      <defs>
        <radialGradient id="dTable" cx="50%" cy="20%" r="80%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.5" stopColor="#dde6f2" />
          <stop offset="1" stopColor="#9aa3b4" />
        </radialGradient>
        <radialGradient id="dHalo" cx="50%" cy="40%" r="55%">
          <stop offset="0" stopColor="#cfe6ff" stopOpacity="0.45" />
          <stop offset="1" stopColor="#cfe6ff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="dGloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.5" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0.05" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        {/* sweeping reflection carries a subtle rainbow — a diamond's fire */}
        <linearGradient id="dSheen" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.34" stopColor="#bff0ff" stopOpacity="0.3" />
          <stop offset="0.48" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="0.6" stopColor="#ffe6a6" stopOpacity="0.34" />
          <stop offset="0.72" stopColor="#e7c0ff" stopOpacity="0.32" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id="dClip">
          <polygon points={SIL.map(s).join(" ")} />
        </clipPath>
        <filter id="dBlur" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="2" />
        </filter>
      </defs>

      {/* halo + floor shadow */}
      <ellipse cx="60" cy="48" rx="56" ry="48" fill="url(#dHalo)" />
      <ellipse cx="60" cy="114" rx="26" ry="5" fill="#000" opacity="0.5" filter="url(#dBlur)" />

      {/* pavilion wedges (scintillation + fire) */}
      {PAV.map((f, i) => (
        <polygon key={`p${i}`} points={f.map(s).join(" ")} fill={PAV_FILL[i]} />
      ))}

      {/* crown */}
      <polygon points={BEZEL_L.map(s).join(" ")} fill="#3a4150" />
      <polygon points={BEZEL_R.map(s).join(" ")} fill="#2c313d" />
      <polygon points={TABLE.map(s).join(" ")} fill="url(#dTable)" />
      {/* bright table core reflection */}
      <ellipse cx="58" cy="26" rx="12" ry="5" fill="#fff" opacity="0.5" filter="url(#dBlur)" />

      {/* facet hairlines — crisp edges read as clarity */}
      <g stroke="#ffffff" strokeOpacity="0.55" strokeWidth="0.5" fill="none" strokeLinejoin="round">
        {/* girdle highlight */}
        <line x1={GIRD_L[0]} y1={GIRD_L[1]} x2={GIRD_R[0]} y2={GIRD_R[1]} strokeOpacity="0.85" strokeWidth="0.9" />
        {/* pavilion facet lines to the culet */}
        {GX.map((x, i) => (
          <line key={`pl${i}`} x1={x} y1={40} x2={CULET[0]} y2={CULET[1]} />
        ))}
        {/* crown facet lines */}
        <line x1={BREAK_L[0]} y1={BREAK_L[1]} x2={TABLE_L[0]} y2={TABLE_L[1]} />
        <line x1={BREAK_R[0]} y1={BREAK_R[1]} x2={TABLE_R[0]} y2={TABLE_R[1]} />
        <line x1={TABLE_L[0]} y1={TABLE_L[1]} x2={TABLE_R[0]} y2={TABLE_R[1]} strokeOpacity="0.8" />
        {/* silhouette */}
        <polygon points={SIL.map(s).join(" ")} strokeOpacity="0.95" strokeWidth="1.2" />
      </g>

      {/* glassy crown gloss + sweeping rainbow reflection */}
      <g clipPath="url(#dClip)">
        <polygon points={SIL.map(s).join(" ")} fill="url(#dGloss)" />
        <rect className="diamond-sheen" x="-50" y="0" width="50" height="116" fill="url(#dSheen)" />
      </g>

      {/* twinkling glints */}
      <g fill="#fff">
        <path className="diamond-glint" style={{ animationDelay: "0s" }} d={glint(TABLE_R[0], TABLE_R[1], 3.2)} />
        <path className="diamond-glint" style={{ animationDelay: "1s" }} d={glint(GIRD_L[0], GIRD_L[1], 2.6)} />
        <path className="diamond-glint" style={{ animationDelay: "2.1s" }} d={glint(CULET[0], CULET[1] - 2, 2.4)} />
        <path className="diamond-glint" style={{ animationDelay: "1.4s" }} d={glint(58, 26, 2.6)} />
      </g>
    </svg>
  );
}
