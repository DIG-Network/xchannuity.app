// Preview the side-profile Diamond (mirrors components/Diamond.tsx).
const { chromium } = require("playwright");
const s = ([x, y]) => `${x},${y}`;
const TABLE_L=[42,18],TABLE_R=[78,18],GIRD_L=[14,40],GIRD_R=[106,40],BREAK_L=[40,40],BREAK_R=[80,40],CULET=[60,108];
const SIL=[TABLE_L,TABLE_R,GIRD_R,CULET,GIRD_L];
const TABLE=[TABLE_L,TABLE_R,BREAK_R,BREAK_L];
const BEZEL_L=[TABLE_L,BREAK_L,GIRD_L], BEZEL_R=[TABLE_R,BREAK_R,GIRD_R];
const GX=[14,27,40,53,67,80,93,106];
const PAV=GX.slice(0,-1).map((x,k)=>[[x,40],[GX[k+1],40],CULET]);
const PF=["#33394a","#aee0f0","#dbe4f0","#2c313d","#e7eef8","#cdb8e8","#363d4b"];
const glint=(x,y,r)=>`M${x} ${y-r} L${x+r*0.24} ${y-r*0.24} L${x+r} ${y} L${x+r*0.24} ${y+r*0.24} L${x} ${y+r} L${x-r*0.24} ${y+r*0.24} L${x-r} ${y} L${x-r*0.24} ${y-r*0.24} Z`;

const svg=`<svg viewBox="0 0 120 122" width="320" height="325">
<defs>
<radialGradient id="dTable" cx="50%" cy="20%" r="80%"><stop offset="0" stop-color="#fff"/><stop offset="0.5" stop-color="#dde6f2"/><stop offset="1" stop-color="#9aa3b4"/></radialGradient>
<radialGradient id="dHalo" cx="50%" cy="40%" r="55%"><stop offset="0" stop-color="#cfe6ff" stop-opacity="0.45"/><stop offset="1" stop-color="#cfe6ff" stop-opacity="0"/></radialGradient>
<linearGradient id="dGloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.5"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.05"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="dSheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.34" stop-color="#bff0ff" stop-opacity="0.3"/><stop offset="0.48" stop-color="#fff" stop-opacity="0.9"/><stop offset="0.6" stop-color="#ffe6a6" stop-opacity="0.34"/><stop offset="0.72" stop-color="#e7c0ff" stop-opacity="0.32"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<clipPath id="dClip"><polygon points="${SIL.map(s).join(" ")}"/></clipPath>
<filter id="dBlur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2"/></filter>
</defs>
<ellipse cx="60" cy="48" rx="56" ry="48" fill="url(#dHalo)"/>
<ellipse cx="60" cy="114" rx="26" ry="5" fill="#000" opacity="0.5" filter="url(#dBlur)"/>
${PAV.map((f,i)=>`<polygon points="${f.map(s).join(" ")}" fill="${PF[i]}"/>`).join("")}
<polygon points="${BEZEL_L.map(s).join(" ")}" fill="#3a4150"/>
<polygon points="${BEZEL_R.map(s).join(" ")}" fill="#2c313d"/>
<polygon points="${TABLE.map(s).join(" ")}" fill="url(#dTable)"/>
<ellipse cx="58" cy="26" rx="12" ry="5" fill="#fff" opacity="0.5" filter="url(#dBlur)"/>
<g stroke="#fff" stroke-opacity="0.55" stroke-width="0.5" fill="none" stroke-linejoin="round">
<line x1="14" y1="40" x2="106" y2="40" stroke-opacity="0.85" stroke-width="0.9"/>
${GX.map((x)=>`<line x1="${x}" y1="40" x2="60" y2="108"/>`).join("")}
<line x1="40" y1="40" x2="42" y2="18"/><line x1="80" y1="40" x2="78" y2="18"/><line x1="42" y1="18" x2="78" y2="18" stroke-opacity="0.8"/>
<polygon points="${SIL.map(s).join(" ")}" stroke-opacity="0.95" stroke-width="1.2"/>
</g>
<g clip-path="url(#dClip)">
<polygon points="${SIL.map(s).join(" ")}" fill="url(#dGloss)"/>
<rect x="34" y="0" width="50" height="116" fill="url(#dSheen)" transform="skewX(-14)"/>
</g>
<g fill="#fff"><path d="${glint(78,18,3.2)}"/><path d="${glint(58,26,2.6)}"/><path d="${glint(60,106,2.4)}"/></g>
</svg>`;

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 420, height: 430 } });
  await p.setContent(`<body style="margin:0;display:flex;align-items:center;justify-content:center;height:430px;background:radial-gradient(circle at 50% 42%, #15171c, #0b0c0e)">${svg}</body>`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: "pw-diamond.png" });
  await b.close();
  console.log("wrote pw-diamond.png");
})();
