import { useState, useEffect, useRef } from "react";

// ── Storage ──────────────────────────────────────────────────────────────────
const KEYS = {
  profile:"fc3_profile", foodLog:"fc3_food", workouts:"fc3_workouts",
  walks:"fc3_walks", checkins:"fc3_checkins", savedMeals:"fc3_meals",
  hydration:"fc3_hydration", recovery:"fc3_recovery", prs:"fc3_prs",
  discipline:"fc3_discipline"
};
const load = (k,fb) => { try { const r=localStorage.getItem(k); return r?JSON.parse(r):fb; } catch { return fb; } };
const save = (k,v) => { try { localStorage.setItem(k,JSON.stringify(v)); } catch {} };

// ── Utilities ────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0,10);
const fmt = n => Math.round(n).toLocaleString();
const fmtDate = d => new Date(d+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"});
const last7 = () => Array.from({length:7},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-6+i); return d.toISOString().slice(0,10); });
const hour = () => new Date().getHours();

const calcBMR = p => {
  if (!p.weight||!p.height||!p.age) return 0;
  const kg=p.weight*0.453592, cm=p.height*2.54;
  return Math.round(10*kg+6.25*cm-5*p.age+(p.sex==="female"?-161:5));
};
const actMult = {sedentary:1.2,light:1.375,moderate:1.55,active:1.725,veryActive:1.9};
const calcTDEE = p => Math.round(calcBMR(p)*(actMult[p.activity]||1.55));
const calcBMI = p => { if(!p.weight||!p.height) return 0; return ((p.weight/(p.height*p.height))*703).toFixed(1); };
const bmiCat = b => b<18.5?{l:"Underweight",c:"#60a5fa"}:b<25?{l:"Normal",c:"#34d399"}:b<30?{l:"Overweight",c:"#fbbf24"}:{l:"Obese",c:"#f87171"};

// Water goal: 0.5 oz per lb bodyweight + workout bonus (16 oz per session)
// e.g. 328 lb → 164 oz base + 16 oz if trained = 180 oz
const calcWaterGoalOz = (profile, workedOutToday=false) => {
  const base = (profile.weight||250) * 0.5;
  const workoutBonus = workedOutToday ? 16 : 0;
  return Math.round(base + workoutBonus);
};

// Estimate calories burned from a workout entry
// MET-based: lift=5, cardio=7, outdoor=4, sport=6 · formula: MET × weight(kg) × hours
const calcWorkoutBurn = (workout, weightLb) => {
  const kg = (weightLb||250) * 0.453592;
  // Granular MET values per activity type
  const MET_TABLE = {
    lift:5.0, cardio:7.0, outdoor:4.0, sport:6.0,
    swimming:8.3, swim:8.3,
    running:9.0, run:9.0, jogging:7.0,
    cycling:7.5, biking:7.5, bike:7.5,
    rowing:7.5, row:7.5,
    elliptical:5.0,
    walking:3.8, walk:3.8,
    hiking:6.0, hike:6.0,
  };
  // Check for a specific activity name stored on cardio entries
  const actKey = (workout.cardioActivity||"").toLowerCase().replace(/\s+/g,"");
  const met = MET_TABLE[actKey] || MET_TABLE[workout.type] || 5.0;
  // For lifts, estimate duration from number of sets (avg 3 min/set including rest)
  let hours;
  if (workout.type === "lift") {
    const totalSets = (workout.sets||[]).reduce((a,s)=>a+(parseInt(s.sets)||1),0) || 3;
    hours = (totalSets * 3) / 60;
  } else {
    hours = (parseInt(workout.duration)||30) / 60;
  }
  return Math.round(met * kg * hours);
};

// Total calories burned from workouts on a given date
const calcDayBurn = (workouts, date, weightLb) =>
  workouts.filter(w=>w.date===date).reduce((a,w)=>a+calcWorkoutBurn(w,weightLb),0);

const weightTrend = checkins => {
  const pts = checkins.filter(c=>c.weight).slice(-8).map((c,i)=>({x:i,y:parseFloat(c.weight)}));
  if (pts.length<2) return null;
  const n=pts.length,sx=pts.reduce((a,p)=>a+p.x,0),sy=pts.reduce((a,p)=>a+p.y,0);
  const sxy=pts.reduce((a,p)=>a+p.x*p.y,0),sxx=pts.reduce((a,p)=>a+p.x*p.x,0);
  return (n*sxy-sx*sy)/(n*sxx-sx*sx||1);
};

// Penalty score: how badly over calories
const calPenalty = (eaten, goal) => {
  const over = eaten - goal;
  if (over <= 0) return 0;
  if (over < 100) return 1;
  if (over < 250) return 2;
  if (over < 500) return 3;
  return 4;
};

// Fatigue score based on recent workouts + sleep + check-in performance
const calcFatigue = (workouts, checkins) => {
  const last3days = last7().slice(-3);
  const recentSessions = workouts.filter(w=>last3days.includes(w.date)).length;
  const lastCheckin = checkins.at(-1);
  const sleepScore = lastCheckin?.sleep ? (8 - parseFloat(lastCheckin.sleep)) : 0;
  const perfScore = lastCheckin?.performance ? (3 - lastCheckin.performance) : 0;
  return Math.min(10, Math.max(0, recentSessions*1.5 + sleepScore + perfScore));
};

// ══════════════════════════════════════════════════════════════════════════════
// AI PROVIDER LAYER — Anthropic (default) + Gemini 3.1 Flash-Lite / Pro
// ══════════════════════════════════════════════════════════════════════════════
const AI_KEY = "fc3_ai_settings";
const AI_DEFAULTS = { provider:"anthropic", anthropicKey:"", geminiKey:"", geminiModel:"gemini-3.1-flash-lite" };
const loadAI = () => { try { return {...AI_DEFAULTS,...JSON.parse(localStorage.getItem(AI_KEY)||"{}")}; } catch { return AI_DEFAULTS; } };
const saveAI = cfg => { try { localStorage.setItem(AI_KEY,JSON.stringify(cfg)); } catch {} };
const parseJ = txt => { try { return JSON.parse(txt.replace(/```json|```/g,"").trim()); } catch { return {}; } };

const callAnthropic = async (key, messages, maxTok=1000) => {
  const headers = {"Content-Type":"application/json"};
  if (key) headers["x-api-key"] = key, headers["anthropic-version"] = "2023-06-01";
  const res = await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST", headers,
    body: JSON.stringify({model:"claude-sonnet-4-20250514", max_tokens:maxTok, messages})
  });
  if (!res.ok) { const e=await res.json(); throw new Error(e.error?.message||"Anthropic error "+res.status); }
  const d = await res.json();
  return d.content?.find(b=>b.type==="text")?.text||"{}";
};

const callGemini = async (key, model, parts, maxTok=1000) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url,{
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({contents:[{role:"user",parts}], generationConfig:{maxOutputTokens:maxTok,temperature:0.3}})
  });
  if (!res.ok) { const e=await res.json(); throw new Error(e.error?.message||"Gemini error "+res.status); }
  const d = await res.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text||"{}";
};

// Unified text prompt
const aiText = async (prompt, maxTok=1000) => {
  const cfg = loadAI();
  if (cfg.provider==="gemini" && cfg.geminiKey)
    return callGemini(cfg.geminiKey, cfg.geminiModel, [{text:prompt}], maxTok);
  return callAnthropic(cfg.anthropicKey||"", [{role:"user",content:prompt}], maxTok);
};

// Unified image+text prompt
const aiImage = async (b64, mime, prompt, maxTok=1000) => {
  const cfg = loadAI();
  if (cfg.provider==="gemini" && cfg.geminiKey)
    return callGemini(cfg.geminiKey, cfg.geminiModel, [{inline_data:{mime_type:mime,data:b64}},{text:prompt}], maxTok);
  return callAnthropic(cfg.anthropicKey||"", [{role:"user",content:[
    {type:"image",source:{type:"base64",media_type:mime,data:b64}},
    {type:"text",text:prompt}
  ]}], maxTok);
};

// ── High-level AI calls ───────────────────────────────────────────────────────
const analyzeFood = async (b64, mime) => parseJ(await aiImage(b64, mime,
  `Analyze this food. Return ONLY raw JSON (no markdown):\n{"name":"meal name","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"notes":"1 sentence"}\nBe precise. Sum all items. Realistic portions.`));

const analyzeTranscript = async (transcript) => parseJ(await aiText(
  `User verbally described food eaten. Extract items, calculate full nutrition.\nTranscript: "${transcript}"\nReturn ONLY raw JSON (no markdown):\n{"name":"meal name","calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"sodium":number,"saturated_fat":number,"cholesterol":number,"items":[{"name":"item","qty":"portion","calories":number,"protein":number,"carbs":number,"fat":number}],"notes":"1 sentence"}\nRealistic portions. Vague = standard serving.`, 1200));

const getCutCoach = async (summary) => parseJ(await aiText(
  `You are an aggressive but accurate fat loss coach. Analyze the data and respond based on NET calories (eaten minus workout burn).
Data: ${JSON.stringify(summary)}
Key rules:
- todayNetCalories is what matters — NOT gross calories
- If overGoalToday is true, give a specific recovery plan for the rest of the day (extra cardio, skip next meal, etc.)
- If avgCalories7d is 0 or very low it means no history yet — say "Need Data" not that they're starving
- Be direct and specific. 3-4 sentences max.
Return ONLY raw JSON (no markdown):
{
  "verdict": "On Pace|Too Slow|Too Fast|Need Data|Over Goal",
  "advice": "direct coaching advice string",
  "adjust_calories": number (negative=cut more, positive=eat more, 0=stay course),
  "color": "#34d399 or #fbbf24 or #f87171",
  "recovery_note": "if over goal: specific recovery steps for today, else empty string",
  "overage_plan": "if overGoalToday: concrete actions like walk X min or skip Y meal to get back on track, else empty string"
}`, 900));

const analyzeWorkoutTranscript = async (transcript) => parseJ(await aiText(
  `Parse this spoken workout description. It may be lifting (sets/reps/weight) OR cardio (time/distance/activity) OR a mix of both.
Transcript: "${transcript}"

First determine the workout_type:
- "lift" if it's purely sets, reps, weight (bench press, squats, deadlifts, kettlebell work, etc.)
- "cardio" if it's purely time/distance based (swimming, running, cycling, rowing, walking, elliptical, etc.)
- "mixed" if it contains both

Return ONLY raw JSON (no markdown, no backticks):
{
  "workout_type": "lift|cardio|mixed",
  "summary": "one sentence describing the full workout",
  "cardio": [
    {
      "activity": "activity name (e.g. Swimming, Running, Cycling)",
      "duration_minutes": number,
      "distance": "e.g. 1.5 miles or empty string",
      "intensity": "light|moderate|vigorous",
      "notes": "any extra detail e.g. freestyle and breaststroke"
    }
  ],
  "exercises": [
    {
      "exercise": "exercise name",
      "sets": "number as string",
      "reps": "number as string",
      "weight": "number as string",
      "unit": "lb or kg",
      "notes": "extra info or empty"
    }
  ]
}

Cardio MET guidance for intensity:
- Swimming vigorous=9.8, moderate=7.0, light=5.8
- Running vigorous=11.5, moderate=8.3, light=6.0
- Cycling vigorous=10.0, moderate=7.5, light=5.5
- Rowing vigorous=8.5, moderate=7.0
- Elliptical moderate=5.0
- Walking brisk=4.3, normal=3.5

If no cardio, return empty array for cardio. If no lifting, return empty array for exercises.
Normalize exercise names to standard gym terminology.`, 1000));


// ── Theme ────────────────────────────────────────────────────────────────────
const C = {
  bg:"#07090d", surface:"#0d1017", card:"#111620", border:"#1a2030",
  accent:"#00e5a0", accentD:"#00e5a018", accentM:"#00e5a045",
  red:"#ff3d5a", redD:"#ff3d5a18", yellow:"#ffd166", yellowD:"#ffd16618",
  blue:"#4dabf7", blueD:"#4dabf718", purple:"#c084fc", purpleD:"#c084fc18",
  orange:"#fb8c00", orangeD:"#fb8c0018",
  text:"#dde1eb", muted:"#4e5a6e", success:"#34d399",
  discipline:"#ff3d5a",
};

// ── UI primitives ────────────────────────────────────────────────────────────
const Card = ({children,style={},glow}) => (
  <div style={{
    background:C.card, border:`1px solid ${glow||C.border}`,
    borderRadius:16, padding:20,
    boxShadow: glow ? `0 0 20px ${glow}22` : "none",
    ...style
  }}>{children}</div>
);

const Tag = ({color=C.accent,children,pulse=false}) => (
  <span style={{
    background:color+"22", color, fontSize:10, fontWeight:700,
    padding:"3px 9px", borderRadius:99, letterSpacing:0.8,
    textTransform:"uppercase", display:"inline-block",
    animation: pulse ? "pulse 1.5s ease-in-out infinite" : "none"
  }}>{children}</span>
);

const Stat = ({label,value,unit,color=C.accent,size=24}) => (
  <div style={{textAlign:"center"}}>
    <div style={{fontSize:size,fontWeight:900,color,fontFamily:"'Space Mono',monospace",lineHeight:1}}>
      {value}<span style={{fontSize:size*0.45,color:C.muted,marginLeft:2}}>{unit}</span>
    </div>
    <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginTop:4}}>{label}</div>
  </div>
);

const Bar = ({value,max,color=C.accent,label,sub,flash=false}) => {
  const pct = Math.min(120,Math.round((value/(max||1))*100));
  const over = pct > 100;
  return (
    <div style={{marginBottom:11}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
        <span style={{fontSize:13,color:over?C.red:C.text,fontWeight:over?700:400}}>{label}</span>
        <span style={{fontSize:12,color:over?C.red:C.muted}}>{sub}</span>
      </div>
      <div style={{height:7,background:C.border,borderRadius:99,overflow:"hidden",position:"relative"}}>
        <div style={{
          width:`${Math.min(100,pct)}%`, height:"100%",
          background: over ? C.red : color,
          borderRadius:99, transition:"width 0.5s cubic-bezier(.4,0,.2,1)",
          animation: over&&flash ? "flashRed 0.8s ease-in-out infinite" : "none"
        }}/>
      </div>
    </div>
  );
};

const Btn = ({onClick,children,variant="primary",style={},disabled=false,sm=false}) => {
  const base={padding:sm?"7px 13px":"10px 20px",borderRadius:10,border:"none",fontWeight:700,
    fontSize:sm?11:13,cursor:disabled?"not-allowed":"pointer",transition:"all 0.18s",
    fontFamily:"inherit",opacity:disabled?0.45:1,...style};
  const v={
    primary:{background:C.accent,color:"#000"},
    ghost:{background:"transparent",color:C.accent,border:`1px solid ${C.accentM}`},
    danger:{background:C.red,color:"#fff"},
    warn:{background:C.yellow,color:"#000"},
    shame:{background:"#1a0508",color:C.red,border:`1px solid ${C.red}55`},
  };
  return <button onClick={disabled?undefined:onClick} style={{...base,...v[variant]}}>{children}</button>;
};

const Inp = ({label,...p}) => (
  <div style={{marginBottom:13}}>
    {label&&<div style={{fontSize:11,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:0.8}}>{label}</div>}
    <input {...p} style={{width:"100%",boxSizing:"border-box",background:C.surface,border:`1px solid ${C.border}`,
      borderRadius:10,padding:"9px 13px",color:C.text,fontSize:14,fontFamily:"inherit",outline:"none",...(p.style||{})}}/>
  </div>
);

const Sel = ({label,options,...p}) => (
  <div style={{marginBottom:13}}>
    {label&&<div style={{fontSize:11,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:0.8}}>{label}</div>}
    <select {...p} style={{width:"100%",background:C.surface,border:`1px solid ${C.border}`,
      borderRadius:10,padding:"9px 13px",color:C.text,fontSize:14,fontFamily:"inherit",outline:"none"}}>
      {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </div>
);

const Sparkline = ({data,color=C.accent,h=50,label,fillColor}) => {
  const W=300,pad=6;
  if (!data||data.length<2) return <div style={{height:h,display:"flex",alignItems:"center",justifyContent:"center",color:C.muted,fontSize:11}}>Needs more data</div>;
  const vals=data.map(d=>d.y);
  const mn=Math.min(...vals),mx=Math.max(...vals)||mn+1;
  const px=i=>pad+(i/(data.length-1))*(W-pad*2);
  const py=v=>h-pad-((v-mn)/(mx-mn||1))*(h-pad*2-4)+2;
  const pts=data.map((d,i)=>`${px(i)},${py(d.y)}`).join(" ");
  const area=`${px(0)},${h} ${pts} ${px(data.length-1)},${h}`;
  return (
    <div>
      {label&&<div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:5}}>{label}</div>}
      <svg viewBox={`0 0 ${W} ${h}`} style={{width:"100%",height:h}} preserveAspectRatio="none">
        {fillColor&&<polygon points={area} fill={fillColor} opacity={0.15}/>}
        <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>
        {data.map((d,i)=><circle key={i} cx={px(i)} cy={py(d.y)} r="3.5" fill={color} stroke={C.card} strokeWidth="1.5"/>)}
      </svg>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.muted,marginTop:2}}>
        <span>{fmtDate(data[0].x)}</span>
        <span style={{color,fontWeight:700}}>{data.at(-1).y}</span>
        <span>{fmtDate(data.at(-1).x)}</span>
      </div>
    </div>
  );
};

// ── CSS injection ────────────────────────────────────────────────────────────
const GlobalStyle = () => (
  <style>{`
    @keyframes flashRed { 0%,100%{opacity:1} 50%{opacity:0.4} }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
    @keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }
    @keyframes slideIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
    * { -webkit-tap-highlight-color: transparent; }
    ::-webkit-scrollbar { display: none; }
    input[type=number]::-webkit-outer-spin-button,
    input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
  `}</style>
);

// ══════════════════════════════════════════════════════════════════════════════
// DISCIPLINE MODE BANNER
// ══════════════════════════════════════════════════════════════════════════════
const DisciplineBanner = ({active,onToggle}) => (
  <div onClick={onToggle} style={{
    padding:"8px 14px", marginBottom:12,
    background: active ? "#1a0407" : C.surface,
    border: `1px solid ${active?C.red:C.border}`,
    borderRadius:10, cursor:"pointer",
    display:"flex", justifyContent:"space-between", alignItems:"center",
    transition:"all 0.3s"
  }}>
    <div>
      <span style={{fontSize:12,fontWeight:700,color:active?C.red:C.muted}}>
        {active?"🔴 DISCIPLINE MODE ACTIVE":"⚪ Discipline Mode"}
      </span>
      <div style={{fontSize:10,color:C.muted,marginTop:1}}>
        {active?"Zero tolerance. No excuses. Shame delivered fresh daily.":"Tap to activate strict accountability"}
      </div>
    </div>
    <div style={{
      width:36,height:20,borderRadius:99,
      background:active?C.red:C.border,
      position:"relative",transition:"background 0.3s"
    }}>
      <div style={{
        position:"absolute",top:3,
        left:active?18:3,width:14,height:14,
        borderRadius:"50%",background:"#fff",transition:"left 0.3s"
      }}/>
    </div>
  </div>
);

// ── Penalty Alert ────────────────────────────────────────────────────────────
const PenaltyAlert = ({level,eaten,goal,discipline}) => {
  if (level===0) return null;
  const msgs = [
    null,
    "🟡 Edging over. Put the fork down. Take a walk. Do not open the fridge again.",
    "🟠 250+ over goal. That's not a snack, that's a sabotage. Your deficit just waved goodbye.",
    "🔴 500+ CALORIES OVER. Congratulations, you've officially uncut yourself today. Outstanding work.",
    "💀 CATASTROPHIC OVERAGE. Whatever you just ate better have been worth the next 3 days of extra cardio. Log it. Own it. Cry about it later."
  ];
  const colors = [null,C.yellow,C.orange,C.red,C.red];
  if (!discipline && level < 3) return null;
  return (
    <div style={{
      padding:"11px 14px",borderRadius:10,marginBottom:10,
      background:colors[level]+"22",border:`1px solid ${colors[level]}55`,
      animation: level>=3?"shake 0.4s ease-in-out":"none"
    }}>
      <div style={{fontSize:13,fontWeight:700,color:colors[level]}}>{msgs[level]}</div>
      {discipline&&<div style={{fontSize:11,color:C.muted,marginTop:3}}>Over by {fmt(eaten-goal)} kcal · Minimum 30 min cardio required to compensate.</div>}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// HYDRATION TRACKER
// ══════════════════════════════════════════════════════════════════════════════
const HydrationWidget = ({profile,hydration,setHydration,workedOut,discipline}) => {
  const goalOz = calcWaterGoalOz(profile, workedOut);
  const todayOz = (hydration[today()]||0);
  const pct = Math.min(100,Math.round((todayOz/goalOz)*100));
  const cups = Math.round(todayOz/8);
  const goalCups = Math.round(goalOz/8);

  const addWater = (oz) => {
    const updated = {...hydration, [today()]:(hydration[today()]||0)+oz};
    setHydration(updated); save(KEYS.hydration, updated);
  };
  const resetWater = () => {
    const updated = {...hydration, [today()]:0};
    setHydration(updated); save(KEYS.hydration, updated);
  };

  const behind = hour() > 14 && pct < 50;
  const shameful = discipline && hour() > 18 && pct < 60;

  const drops = Array.from({length:goalCups},(_, i)=>{
    const filled = i < cups;
    return <div key={i} style={{
      width:16,height:20,borderRadius:"0 0 8px 8px",
      background:filled?(pct<50&&behind?C.yellow:C.blue):C.border,
      transition:"background 0.3s",flexShrink:0
    }}/>;
  });

  return (
    <Card style={{marginBottom:12}} glow={shameful?C.red:behind?C.yellow:undefined}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:C.text}}>💧 Hydration</div>
          <div style={{fontSize:10,color:C.muted,marginTop:1}}>Goal based on {profile.weight||"—"}lb, {profile.height?`${Math.floor((profile.height||76)/12)}'${(profile.height||76)%12}"`:"height"}{workedOut?" + workout bonus":""}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:20,fontWeight:900,color:pct>=80?C.blue:pct>=50?C.yellow:C.red,fontFamily:"'Space Mono',monospace"}}>{todayOz}<span style={{fontSize:11,color:C.muted}}>oz</span></div>
          <div style={{fontSize:10,color:C.muted}}>goal: {goalOz}oz</div>
        </div>
      </div>

      <Bar value={todayOz} max={goalOz} color={C.blue} label="" sub="" flash={shameful}/>

      <div style={{display:"flex",flexWrap:"wrap",gap:4,marginBottom:10,maxHeight:50,overflow:"hidden"}}>{drops}</div>

      {shameful&&<div style={{fontSize:11,color:C.red,fontWeight:700,marginBottom:8,padding:"6px 10px",background:C.redD,borderRadius:8}}>
        🚨 Evening and you're under 60% hydrated. Dehydration tanks performance and recovery. Drink NOW.
      </div>}
      {!shameful&&behind&&<div style={{fontSize:11,color:C.yellow,marginBottom:8}}>⚠️ Behind pace — aim for {fmt(goalOz/2)}oz by midday</div>}

      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        {[8,12,16,20].map(oz=>(
          <button key={oz} onClick={()=>addWater(oz)} style={{
            background:C.blueD,color:C.blue,border:`1px solid ${C.blue}44`,
            borderRadius:8,padding:"6px 10px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"
          }}>{oz}oz</button>
        ))}
        <button onClick={()=>addWater(32)} style={{
          background:C.blueD,color:C.blue,border:`1px solid ${C.blue}44`,
          borderRadius:8,padding:"6px 10px",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"
        }}>32oz Bottle</button>
        <button onClick={resetWater} style={{
          background:"transparent",color:C.muted,border:`1px solid ${C.border}`,
          borderRadius:8,padding:"6px 10px",fontSize:11,cursor:"pointer",fontFamily:"inherit"
        }}>Reset</button>
      </div>
    </Card>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// RECOVERY / MOBILITY / ENVIRONMENT
// ══════════════════════════════════════════════════════════════════════════════
const RecoveryWidget = ({recovery,setRecovery}) => {
  const rec = recovery[today()] || {};
  const update = (field,val) => {
    const updated = {...recovery,[today()]:{...rec,[field]:val}};
    setRecovery(updated); save(KEYS.recovery,updated);
  };

  const RatingBtn = ({field,options}) => (
    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
      {options.map(o=>(
        <button key={o.v} onClick={()=>update(field,o.v)} style={{
          padding:"5px 10px",borderRadius:8,border:`1px solid ${rec[field]===o.v?o.c:C.border}`,
          background:rec[field]===o.v?o.c+"22":C.surface,
          color:rec[field]===o.v?o.c:C.muted,
          fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"
        }}>{o.l}</button>
      ))}
    </div>
  );

  const rows = [
    {label:"🛌 Sleep Quality",field:"sleep",options:[{v:"poor",l:"Poor",c:C.red},{v:"ok",l:"OK",c:C.yellow},{v:"good",l:"Good",c:C.accent},{v:"great",l:"Great",c:C.success}]},
    {label:"💪 Muscle Soreness",field:"soreness",options:[{v:"none",l:"None",c:C.success},{v:"mild",l:"Mild",c:C.accent},{v:"moderate",l:"Moderate",c:C.yellow},{v:"severe",l:"Severe",c:C.red}]},
    {label:"🧘 Mobility Work Done",field:"mobility",options:[{v:"none",l:"None",c:C.muted},{v:"light",l:"5–10 min",c:C.yellow},{v:"full",l:"15+ min",c:C.success}]},
    {label:"🌡️ Stress Level",field:"stress",options:[{v:"low",l:"Low",c:C.success},{v:"med",l:"Medium",c:C.yellow},{v:"high",l:"High",c:C.orange},{v:"max",l:"Max",c:C.red}]},
    {label:"🌤️ Environment",field:"env",options:[{v:"indoor",l:"Indoors",c:C.blue},{v:"hot",l:"Hot/Humid",c:C.orange},{v:"cold",l:"Cold",c:"#60a5fa"},{v:"active",l:"On Feet All Day",c:C.accent}]},
  ];

  const recScore = () => {
    let s=100;
    if(rec.sleep==="poor") s-=30; else if(rec.sleep==="ok") s-=15;
    if(rec.soreness==="severe") s-=25; else if(rec.soreness==="moderate") s-=12;
    if(rec.stress==="max") s-=20; else if(rec.stress==="high") s-=10;
    if(rec.mobility==="full") s+=10; else if(rec.mobility==="light") s+=5;
    if(rec.env==="hot") s-=8;
    return Math.min(100,Math.max(0,s));
  };
  const score=recScore();
  const scoreColor=score>=80?C.success:score>=60?C.accent:score>=40?C.yellow:C.red;

  return (
    <Card style={{marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontSize:13,fontWeight:700,color:C.text}}>🔋 Recovery Status</div>
        <div style={{fontSize:22,fontWeight:900,color:scoreColor,fontFamily:"'Space Mono',monospace"}}>{score}<span style={{fontSize:11,color:C.muted}}>/100</span></div>
      </div>
      <div style={{display:"grid",gap:12}}>
        {rows.map(r=>(
          <div key={r.field}>
            <div style={{fontSize:11,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:0.7}}>{r.label}</div>
            <RatingBtn field={r.field} options={r.options}/>
          </div>
        ))}
      </div>
      {rec.env==="hot"&&<div style={{marginTop:10,fontSize:11,color:C.orange,padding:"6px 10px",background:C.orangeD,borderRadius:8}}>🌡️ Hot/humid environment: add 8–12oz water per hour of activity.</div>}
      {rec.stress==="max"&&<div style={{marginTop:8,fontSize:11,color:C.yellow,padding:"6px 10px",background:C.yellowD,borderRadius:8}}>⚡ High stress spikes cortisol. Prioritize sleep and keep training moderate today.</div>}
      {rec.soreness==="severe"&&<div style={{marginTop:8,fontSize:11,color:C.red,padding:"6px 10px",background:C.redD,borderRadius:8}}>🚨 Severe soreness: skip heavy compounds. Walk, stretch, or do mobility only.</div>}
    </Card>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// DISCIPLINE SHAME PANEL
// ══════════════════════════════════════════════════════════════════════════════
const ShamePanel = ({todayCal,goal,proteinEaten,proteinGoal,walkedToday,workedOut,hydrationPct,discipline}) => {
  if (!discipline) return null;
  const failures = [];
  if (todayCal > goal+50) failures.push(`🔴 ${fmt(todayCal-goal)} calories over goal. Congratulations — you just ate your way back to square one. Your future self is furious.`);
  if (todayCal > goal+500) failures.push(`☠️ ${fmt(todayCal-goal)} OVER. That's not a cheat meal, that's a war crime against your metabolism. What are you doing?`);
  if (proteinEaten < proteinGoal*0.8 && hour()>18) failures.push(`🔴 ${fmt(proteinEaten)}g of protein. Your muscles called — they're filing for abandonment. ${proteinGoal}g is the goal, not a suggestion.`);
  if (proteinEaten < proteinGoal*0.5 && hour()>18) failures.push(`💀 Under half your protein at this hour? You might as well be on a cotton candy diet. Your gains are evaporating in real time.`);
  if (!walkedToday && hour()>17) failures.push("🔴 Not a single step logged today. A golden retriever has more discipline than you right now. Get. Outside.");
  if (!walkedToday && hour()>20) failures.push("😂 It's 8pm and you haven't moved. The couch has a permanent impression of your backside. This is not the cut. This is a nap with ambitions.");
  if (hydrationPct < 70 && hour()>16) failures.push(`🔴 ${Math.round(hydrationPct)}% hydrated. Your kidneys are drafting a resignation letter. Drink water, you dried-out raisin.`);
  if (hydrationPct < 40 && hour()>16) failures.push(`🌵 ${Math.round(hydrationPct)}% hydrated. A cactus drinks more than you. Your body is attempting to turn into beef jerky.`);
  if (!workedOut && hour()>19) failures.push("⚠️ No workout today. To be clear: rest days are planned recovery. What you're doing is just avoiding effort and calling it self-care.");

  if (failures.length===0) return (
    <Card style={{marginBottom:12,border:`1px solid ${C.success}44`}} glow={C.success}>
      <div style={{fontSize:13,fontWeight:700,color:C.success}}>✅ DISCIPLINE HOLDING</div>
      <div style={{fontSize:11,color:C.muted,marginTop:3}}>All targets on track. Stay sharp.</div>
    </Card>
  );

  return (
    <Card style={{marginBottom:12,border:`1px solid ${C.red}55`,background:"#0f0508"}} glow={C.red}>
      <div style={{fontSize:13,fontWeight:800,color:C.red,marginBottom:10,letterSpacing:0.5}}>⚠️ DISCIPLINE FAILURES — {today()}</div>
      {failures.map((f,i)=>(
        <div key={i} style={{fontSize:12,color:C.text,padding:"6px 0",borderBottom:i<failures.length-1?`1px solid ${C.border}`:undefined,lineHeight:1.5}}>{f}</div>
      ))}
      <div style={{marginTop:10,fontSize:11,color:C.muted}}>You activated Discipline Mode. You knew what you signed up for. No sympathy. Fix it.</div>
    </Card>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
const DashTab = ({profile,foodLog,workouts,checkins,walks,hydration,recovery,prs,discipline}) => {
  const [coach,setCoach]=useState(null);
  const [loadingCoach,setLoadingCoach]=useState(false);

  const tdee=calcTDEE(profile);
  const goal=profile.calorieGoal||tdee||2200;
  const proteinGoal=profile.proteinGoal||Math.round((profile.weight||250)*1.1);
  const waterGoal=calcWaterGoalOz(profile,workouts.some(w=>w.date===today()));

  const todayKey = today();
  const todayFood = foodLog.filter(e=>e.date===todayKey);
  const grossCal  = todayFood.reduce((a,e)=>a+(+e.calories||0),0);
  const todayPro  = todayFood.reduce((a,e)=>a+(+e.protein||0),0);
  const burnedCal = calcDayBurn(workouts, todayKey, profile.weight);
  const netCal    = Math.max(0, grossCal - burnedCal);  // net = eaten - burned
  const totals    = { cal: grossCal, pro: todayPro, net: netCal, burned: burnedCal };

  const todayWater    = hydration[todayKey]||0;
  const walkedToday   = walks.some(w=>w.date===todayKey);
  const workedOutToday= workouts.some(w=>w.date===todayKey);

  // Penalty is based on NET calories vs goal
  const penalty = calPenalty(netCal, goal);
  const fatigue = calcFatigue(workouts, checkins);
  const trend   = weightTrend(checkins.slice(-6));

  const streak = (() => {
    let s=0, d=new Date();
    while(true){
      const ds=d.toISOString().slice(0,10);
      if(foodLog.some(f=>f.date===ds)){s++;d.setDate(d.getDate()-1);}else break;
    }
    return s;
  })();

  // 7-day averages — only include days that have at least 1 food entry
  const last14WithFood = foodLog.reduce((acc,f)=>{
    if(!acc[f.date]) acc[f.date]={cal:0,pro:0};
    acc[f.date].cal += (+f.calories||0);
    acc[f.date].pro += (+f.protein||0);
    return acc;
  },{});
  const daysWithFood = Object.values(last14WithFood);
  const avgCalories  = daysWithFood.length ? Math.round(daysWithFood.reduce((a,d)=>a+d.cal,0)/daysWithFood.length) : 0;
  const avgProtein   = daysWithFood.length ? Math.round(daysWithFood.reduce((a,d)=>a+d.pro,0)/daysWithFood.length) : 0;
  const overGoalToday = netCal > goal;
  const overBy = Math.max(0, netCal - goal);

  const runCoach = async () => {
    setLoadingCoach(true);
    try {
      const r = await getCutCoach({
        currentWeight:   checkins.at(-1)?.weight   || null,
        startWeight:     checkins[0]?.weight        || null,
        weeklyTrend:     trend ? +(trend*4).toFixed(1) : null,
        todayGrossCalories: grossCal,
        todayBurnedCalories: burnedCal,
        todayNetCalories: netCal,
        todayProtein:    todayPro,
        avgCalories7d:   avgCalories,
        avgProtein7d:    avgProtein,
        calorieGoal:     goal,
        proteinGoal,
        overGoalToday,
        overBy,
        fatigueScore:    +fatigue.toFixed(1),
        hydrationPct:    Math.round((todayWater/waterGoal)*100),
        recentSleep:     checkins.at(-1)?.sleep || null,
        workedOutToday,
        walkedToday,
        streak,
      });
      setCoach(r);
    } catch {
      setCoach({verdict:"Error", advice:"AI unavailable.", color:C.muted, recovery_note:"", overage_plan:""});
    }
    setLoadingCoach(false);
  };

  const week7=last7();
  const weekCals=week7.map(d=>({x:d,y:foodLog.filter(f=>f.date===d).reduce((a,f)=>a+f.calories,0)}));
  const weightHist=checkins.filter(c=>c.weight).map(c=>({x:c.date,y:parseFloat(c.weight)}));

  const hydPct=Math.round((todayWater/waterGoal)*100);

  return (
    <div>
      <ShamePanel
        todayCal={netCal} goal={goal}
        proteinEaten={todayPro} proteinGoal={proteinGoal}
        walkedToday={walkedToday} workedOut={workedOutToday}
        hydrationPct={hydPct} discipline={discipline}
      />

      <PenaltyAlert level={penalty} eaten={netCal} goal={goal} discipline={discipline}/>

      {/* Header stats */}
      <Card style={{marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {streak>0&&<Tag color={C.yellow}>🔥 {streak}d</Tag>}
            {workedOutToday&&<Tag color={C.accent}>💪 Trained</Tag>}
            {walkedToday&&<Tag color={C.blue}>🚶 Walked</Tag>}
            {fatigue>=7&&<Tag color={C.red} pulse>⚡ High Fatigue</Tag>}
          </div>
          <Stat label="Fatigue" value={fatigue.toFixed(1)} unit="/10" color={fatigue>=7?C.red:fatigue>=4?C.yellow:C.success} size={18}/>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:12}}>
          <Stat label="Eaten" value={fmt(grossCal)} color={C.accent} size={20}/>
          <Stat label="Burned" value={fmt(burnedCal)} color={C.success} size={20}/>
          <Stat label="Net Cal" value={fmt(netCal)} color={netCal>goal?C.red:C.accent} size={20}/>
          <Stat label="Protein" value={fmt(todayPro)} unit="g" color={C.blue} size={20}/>
        </div>
        {burnedCal>0&&<div style={{fontSize:11,color:C.success,marginBottom:8}}>💪 Workout burned ~{fmt(burnedCal)} kcal → net {fmt(netCal)} kcal</div>}
        <Bar value={netCal} max={goal} label="Net Calories" sub={`${fmt(netCal)} eaten − ${fmt(burnedCal)} burned = ${fmt(netCal)} net / ${fmt(goal)} goal`} flash={penalty>=2&&discipline}/>
        <Bar value={todayPro} max={proteinGoal} color={C.blue} label="Protein" sub={`${fmt(todayPro)}/${proteinGoal}g`}/>
        <Bar value={todayWater} max={waterGoal} color={C.blue} label="Hydration" sub={`${todayWater}/${waterGoal}oz`}/>
      </Card>

      {/* Cut Coach */}
      <Card style={{marginBottom:12}} glow={coach?.color}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:coach?12:0}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:C.text}}>⚡ Cut Coach AI</div>
            <div style={{fontSize:10,color:C.muted}}>Adaptive advice from your real data</div>
          </div>
          <Btn onClick={runCoach} disabled={loadingCoach} sm>{loadingCoach?"...":" Analyze"}</Btn>
        </div>
        {coach&&(
          <div style={{animation:"slideIn 0.3s ease"}}>
            <div style={{display:"flex",gap:8,marginBottom:8,flexWrap:"wrap"}}>
              <Tag color={coach.color}>{coach.verdict}</Tag>
              {coach.adjust_calories!==0&&<span style={{fontSize:11,color:C.muted}}>Adjust: <span style={{color:coach.adjust_calories>0?C.success:C.red,fontWeight:700}}>{coach.adjust_calories>0?"+":""}{coach.adjust_calories} kcal</span></span>}
            </div>
            <div style={{fontSize:13,color:C.text,lineHeight:1.65,marginBottom:8}}>{coach.advice}</div>
            {coach.recovery_note&&<div style={{fontSize:12,color:C.yellow,lineHeight:1.5,marginBottom:6,padding:"6px 10px",background:C.yellowD,borderRadius:8}}>{coach.recovery_note}</div>}
            {coach.overage_plan&&<div style={{fontSize:12,color:C.text,lineHeight:1.5,padding:"8px 10px",background:C.redD,borderRadius:8,border:"1px solid "+C.red+"44"}}>
              <span style={{color:C.red,fontWeight:700}}>Recovery Plan: </span>{coach.overage_plan}
            </div>}
          </div>
        )}
      </Card>

      {/* Charts */}
      <Card style={{marginBottom:12}}>
        <Sparkline data={weekCals} color={C.accent} h={56} label="7-Day Calories" fillColor={C.accent}/>
        <div style={{borderTop:`1px solid ${C.border}`,marginTop:12,paddingTop:12}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:4}}>
            <span style={{color:C.muted}}>Goal: <span style={{color:C.accent,fontWeight:600}}>{fmt(goal)} kcal</span></span>
            <span style={{color:C.muted}}>7d avg: <span style={{color:avgCalories>goal?C.red:C.success,fontWeight:600}}>{fmt(avgCalories)} kcal</span></span>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11}}>
            <span style={{color:C.muted}}>Today gross: {fmt(grossCal)} kcal</span>
            <span style={{color:C.success}}>Burned: {fmt(burnedCal)} kcal → Net: {fmt(netCal)}</span>
          </div>
        </div>
      </Card>

      {weightHist.length>=2&&(
        <Card style={{marginBottom:12}}>
          <Sparkline data={weightHist} color={C.blue} h={56} label="Weight Trend" fillColor={C.blue}/>
          {trend!==null&&(
            <div style={{fontSize:11,marginTop:8}}>
              <span style={{color:C.muted}}>Rate: </span>
              <span style={{color:trend<0?C.success:C.red,fontWeight:700}}>{trend<0?"":"+"}{ (trend*4).toFixed(1)} lb/mo</span>
              {trend<-3?" · ⚠️ Too aggressive":trend<=-0.5?" · ✅ On pace":" · 📉 Stalling — cut deeper or add cardio"}
            </div>
          )}
        </Card>
      )}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// VOICE LOG COMPONENT
// ══════════════════════════════════════════════════════════════════════════════
const VoiceLog = ({onLog, onClose}) => {
  const [phase, setPhase] = useState("idle"); // idle | recording | processing | result | error
  const [transcript, setTranscript] = useState("");
  const [editTranscript, setEditTranscript] = useState("");
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [supported, setSupported] = useState(true);
  const recogRef = useRef(null);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    const recog = new SR();
    recog.continuous = true;
    recog.interimResults = true;
    recog.lang = "en-US";
    let finalText = "";
    recog.onresult = (e) => {
      let interim = "";
      finalText = "";
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript + " ";
        else interim += e.results[i][0].transcript;
      }
      setTranscript((finalText + interim).trim());
    };
    recog.onerror = (e) => {
      setErrorMsg("Mic error: " + e.error + ". Try typing instead.");
      setPhase("error");
      setRecording(false);
    };
    recog.onend = () => {
      setRecording(false);
      if (finalText.trim()) {
        setTranscript(finalText.trim());
        setEditTranscript(finalText.trim());
      }
    };
    recogRef.current = recog;
  }, []);

  const startRecording = () => {
    if (!recogRef.current) return;
    setTranscript(""); setEditTranscript(""); setResult(null); setErrorMsg("");
    recogRef.current.start();
    setRecording(true); setPhase("recording");
  };

  const stopRecording = () => {
    recogRef.current?.stop();
    setRecording(false);
    setPhase("review");
  };

  const analyze = async (text) => {
    if (!text.trim()) return;
    setPhase("processing");
    try {
      const r = await analyzeTranscript(text);
      setResult(r); setPhase("result");
    } catch {
      setErrorMsg("Analysis failed. Check your input and try again.");
      setPhase("error");
    }
  };

  const MicroRow = ({label, value, unit, color=C.muted}) => (
    <div style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:`1px solid ${C.border}`}}>
      <span style={{fontSize:12,color:C.muted}}>{label}</span>
      <span style={{fontSize:12,fontWeight:600,color}}>{value}<span style={{fontSize:10,color:C.muted,marginLeft:2}}>{unit}</span></span>
    </div>
  );

  return (
    <Card style={{marginBottom:12,border:`1px solid ${C.accentM}`}} glow={C.accent}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:C.text}}>🎙 Voice Food Log</div>
          <div style={{fontSize:10,color:C.muted}}>Describe what you ate — AI calculates everything</div>
        </div>
        <button onClick={onClose} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:18,lineHeight:1}}>×</button>
      </div>

      {/* Not supported */}
      {!supported && phase==="idle" && (
        <div style={{marginBottom:10}}>
          <div style={{fontSize:12,color:C.yellow,padding:"7px 10px",background:C.yellowD,borderRadius:8,marginBottom:10}}>
            ⚠️ Voice not supported in this browser. Type your meal description below instead.
          </div>
          <textarea
            placeholder="e.g. I had two scrambled eggs, two strips of bacon, a cup of oatmeal with a tablespoon of peanut butter, and a glass of orange juice"
            value={editTranscript}
            onChange={e=>setEditTranscript(e.target.value)}
            style={{width:"100%",boxSizing:"border-box",background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 13px",color:C.text,fontSize:13,fontFamily:"inherit",outline:"none",minHeight:90,resize:"vertical"}}
          />
          <Btn onClick={()=>analyze(editTranscript)} style={{width:"100%",marginTop:8}} disabled={!editTranscript.trim()}>🔍 Analyze Description</Btn>
        </div>
      )}

      {/* Idle */}
      {supported && phase==="idle" && (
        <div style={{textAlign:"center",padding:"10px 0"}}>
          <div style={{fontSize:12,color:C.muted,marginBottom:14,lineHeight:1.6}}>
            Tap Record and describe your meal naturally.<br/>
            <span style={{color:C.text}}>"I had grilled chicken breast, about 6 oz, with a cup of brown rice and some broccoli"</span>
          </div>
          <Btn onClick={startRecording} style={{width:"100%",padding:"14px"}}>🎙 Start Recording</Btn>
        </div>
      )}

      {/* Recording */}
      {phase==="recording" && (
        <div>
          <div style={{textAlign:"center",marginBottom:12}}>
            <div style={{
              width:60,height:60,borderRadius:"50%",background:C.red+"22",border:`2px solid ${C.red}`,
              margin:"0 auto 10px",display:"flex",alignItems:"center",justifyContent:"center",
              animation:"pulse 1s ease-in-out infinite"
            }}>
              <span style={{fontSize:24}}>🎙</span>
            </div>
            <div style={{fontSize:12,color:C.red,fontWeight:700}}>RECORDING — speak clearly</div>
          </div>
          {transcript && (
            <div style={{background:C.surface,borderRadius:10,padding:"10px 13px",marginBottom:10,minHeight:50,fontSize:13,color:C.text,lineHeight:1.6}}>
              {transcript || <span style={{color:C.muted,fontStyle:"italic"}}>Listening...</span>}
            </div>
          )}
          {!transcript && (
            <div style={{background:C.surface,borderRadius:10,padding:"10px 13px",marginBottom:10,minHeight:50,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <span style={{color:C.muted,fontSize:12,fontStyle:"italic"}}>Listening... speak now</span>
            </div>
          )}
          <Btn onClick={stopRecording} variant="danger" style={{width:"100%"}}>⏹ Stop Recording</Btn>
        </div>
      )}

      {/* Review transcript */}
      {phase==="review" && (
        <div>
          <div style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:0.8,marginBottom:6}}>Transcribed — edit if needed</div>
          <textarea
            value={editTranscript||transcript}
            onChange={e=>setEditTranscript(e.target.value)}
            style={{width:"100%",boxSizing:"border-box",background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 13px",color:C.text,fontSize:13,fontFamily:"inherit",outline:"none",minHeight:80,resize:"vertical",marginBottom:10}}
          />
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={()=>analyze(editTranscript||transcript)} style={{flex:1}}>🔍 Analyze</Btn>
            <Btn onClick={startRecording} variant="ghost">Re-record</Btn>
          </div>
        </div>
      )}

      {/* Processing */}
      {phase==="processing" && (
        <div style={{textAlign:"center",padding:"20px 0"}}>
          <div style={{fontSize:24,marginBottom:8,animation:"pulse 1s ease-in-out infinite"}}>🧠</div>
          <div style={{fontSize:13,color:C.muted}}>Calculating nutrition...</div>
        </div>
      )}

      {/* Error */}
      {phase==="error" && (
        <div>
          <div style={{fontSize:12,color:C.red,padding:"8px 12px",background:C.redD,borderRadius:8,marginBottom:10}}>{errorMsg}</div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={()=>setPhase(supported?"idle":"idle")} variant="ghost" style={{flex:1}}>Try Again</Btn>
            <Btn onClick={onClose} variant="ghost">Cancel</Btn>
          </div>
        </div>
      )}

      {/* Result */}
      {phase==="result" && result && (
        <div style={{animation:"slideIn 0.3s ease"}}>
          <div style={{fontSize:15,fontWeight:700,color:C.accent,marginBottom:2}}>{result.name}</div>
          {result.notes && <div style={{fontSize:11,color:C.muted,marginBottom:12}}>{result.notes}</div>}

          {/* Main macros */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12}}>
            <Stat label="Cal" value={result.calories} size={18} color={C.accent}/>
            <Stat label="Protein" value={result.protein} unit="g" size={18} color={C.blue}/>
            <Stat label="Carbs" value={result.carbs} unit="g" size={18} color={C.yellow}/>
            <Stat label="Fat" value={result.fat} unit="g" size={18} color={C.purple}/>
          </div>

          {/* Micronutrients */}
          <div style={{background:C.surface,borderRadius:10,padding:"10px 13px",marginBottom:12}}>
            <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:0.8,marginBottom:8}}>Micronutrients</div>
            <MicroRow label="Fiber" value={result.fiber||0} unit="g" color={C.success}/>
            <MicroRow label="Sugar" value={result.sugar||0} unit="g" color={C.yellow}/>
            <MicroRow label="Saturated Fat" value={result.saturated_fat||0} unit="g" color={C.orange}/>
            <MicroRow label="Cholesterol" value={result.cholesterol||0} unit="mg" color={C.muted}/>
            <MicroRow label="Sodium" value={result.sodium||0} unit="mg" color={result.sodium>1500?C.red:C.muted}/>
          </div>

          {/* Item breakdown */}
          {result.items?.length > 0 && (
            <div style={{background:C.surface,borderRadius:10,padding:"10px 13px",marginBottom:12}}>
              <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:0.8,marginBottom:8}}>Item Breakdown</div>
              {result.items.map((item,i)=>(
                <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:i<result.items.length-1?`1px solid ${C.border}`:undefined}}>
                  <div>
                    <div style={{fontSize:12,color:C.text}}>{item.name}</div>
                    <div style={{fontSize:10,color:C.muted}}>{item.qty}</div>
                  </div>
                  <div style={{textAlign:"right",fontSize:11}}>
                    <span style={{color:C.accent,fontWeight:600}}>{item.calories} kcal</span>
                    <span style={{color:C.muted}}> · {item.protein}g P</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Transcript used */}
          <div style={{fontSize:10,color:C.muted,fontStyle:"italic",marginBottom:12,padding:"6px 10px",background:C.surface,borderRadius:8}}>
            "{editTranscript||transcript}"
          </div>

          <div style={{display:"flex",gap:8}}>
            <Btn onClick={()=>onLog(result)} style={{flex:1}}>✅ Log This Meal</Btn>
            <Btn onClick={()=>onLog({...result,_save:true})} variant="ghost" style={{flex:1}}>⭐ Log & Save</Btn>
            <Btn onClick={()=>setPhase(supported?"idle":"idle")} variant="ghost">Redo</Btn>
          </div>
        </div>
      )}
    </Card>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// FOOD TAB
// ══════════════════════════════════════════════════════════════════════════════
const FoodTab = ({profile,foodLog,setFoodLog,savedMeals,setSavedMeals,discipline}) => {
  const [phase,setPhase]=useState("idle");
  const [showVoice,setShowVoice]=useState(false);
  const [imgSrc,setImgSrc]=useState(null);
  const [imgB64,setImgB64]=useState(null);
  const [imgMime,setImgMime]=useState("image/jpeg");
  const [result,setResult]=useState(null);
  const [error,setError]=useState("");
  const [manual,setManual]=useState({name:"",calories:"",protein:"",carbs:"",fat:""});
  const [showSaved,setShowSaved]=useState(false);
  const [histDate,setHistDate]=useState(null);
  const fileRef=useRef(); const camRef=useRef();

  const goal=profile.calorieGoal||calcTDEE(profile)||2200;
  const proteinGoal=profile.proteinGoal||Math.round((profile.weight||250)*1.1);
  const todayEntries=foodLog.filter(e=>e.date===today());
  const totals=todayEntries.reduce((a,e)=>({cal:a.cal+(e.calories||0),pro:a.pro+(e.protein||0),carbs:a.carbs+(e.carbs||0),fat:a.fat+(e.fat||0)}),{cal:0,pro:0,carbs:0,fat:0});
  const penalty=calPenalty(totals.cal,goal);

  const handleFile=f=>{ if(!f)return; setImgMime(f.type||"image/jpeg"); const r=new FileReader(); r.onload=e=>{setImgSrc(e.target.result);setImgB64(e.target.result.split(",")[1]);setPhase("preview");}; r.readAsDataURL(f); };
  const analyze=async()=>{ setPhase("analyzing");setError(""); try{const r=await analyzeFood(imgB64,imgMime);setResult(r);setPhase("result");}catch{setError("Analysis failed.");setPhase("preview");} };
  const logEntry=(entry,saveIt=false)=>{
    const ne={...entry,date:today(),id:Date.now()};
    const nl=[ne,...foodLog]; setFoodLog(nl); save(KEYS.foodLog,nl);
    if(saveIt&&entry.name){const ex=savedMeals.some(m=>m.name.toLowerCase()===entry.name.toLowerCase());if(!ex){const u=[{...entry,id:Date.now()},...savedMeals];setSavedMeals(u);save(KEYS.savedMeals,u);}}
    setPhase("idle");setImgSrc(null);setResult(null);setManual({name:"",calories:"",protein:"",carbs:"",fat:""});
  };
  const del=id=>{ const nl=foodLog.filter(e=>e.id!==id);setFoodLog(nl);save(KEYS.foodLog,nl); };
  const delSaved=id=>{ const nl=savedMeals.filter(m=>m.id!==id);setSavedMeals(nl);save(KEYS.savedMeals,nl); };

  const pastDates=[...new Set(foodLog.filter(e=>e.date!==today()).map(e=>e.date))].slice(0,10);

  return (
    <div>
      <PenaltyAlert level={penalty} eaten={totals.cal} goal={goal} discipline={discipline}/>

      <Card style={{marginBottom:12}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:12}}>
          <Stat label="Cal" value={fmt(totals.cal)} color={totals.cal>goal?C.red:C.accent} size={20}/>
          <Stat label="Protein" value={fmt(totals.pro)} unit="g" color={C.blue} size={20}/>
          <Stat label="Carbs" value={fmt(totals.carbs)} unit="g" color={C.yellow} size={20}/>
          <Stat label="Fat" value={fmt(totals.fat)} unit="g" color={C.purple} size={20}/>
        </div>
        <Bar value={totals.cal} max={goal} label="Calories" sub={`${fmt(Math.max(0,goal-totals.cal))} remaining`} flash={discipline&&penalty>=2}/>
        <Bar value={totals.pro} max={proteinGoal} color={C.blue} label="Protein" sub={`${fmt(totals.pro)}/${proteinGoal}g`}/>
        {totals.cal>goal&&<div style={{fontSize:11,color:C.red,fontWeight:700,marginTop:4}}>🚨 {fmt(totals.cal-goal)} over goal{discipline?" — penalty logged":""}</div>}
      </Card>

      {phase==="idle"&&(
        <Card style={{marginBottom:12}}>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <Btn onClick={()=>camRef.current?.click()} style={{width:"100%"}}>📷 Camera</Btn>
            <Btn onClick={()=>fileRef.current?.click()} variant="ghost" style={{width:"100%"}}>🖼 Upload</Btn>
            <Btn onClick={()=>setPhase("manual")} variant="ghost" style={{width:"100%"}}>✏️ Manual</Btn>
            <Btn onClick={()=>{setShowVoice(true);setShowSaved(false);}} variant="ghost" style={{width:"100%"}}>🎙 Voice Log</Btn>
            <Btn onClick={()=>{setShowSaved(!showSaved);setShowVoice(false);}} variant="ghost" style={{width:"100%",gridColumn:"1/-1"}}>⭐ Saved Meals ({savedMeals.length})</Btn>
          </div>
          <input ref={camRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
          <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
        </Card>
      )}

      {/* Voice Logger */}
      {showVoice && phase==="idle" && (
        <VoiceLog
          onLog={(entry) => {
            const saveIt = entry._save;
            const clean = {...entry}; delete clean._save;
            logEntry(clean, saveIt);
            setShowVoice(false);
          }}
          onClose={() => setShowVoice(false)}
        />
      )}

      {showSaved&&phase==="idle"&&(
        <Card style={{marginBottom:12,border:`1px solid ${C.accentM}`}}>
          <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:10}}>⭐ Quick Log</div>
          {savedMeals.length===0&&<div style={{color:C.muted,fontSize:12,padding:"8px 0"}}>No saved meals. Log a meal and tap "Log & Save".</div>}
          {savedMeals.map(m=>(
            <div key={m.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:`1px solid ${C.border}`}}>
              <div onClick={()=>{logEntry(m);setShowSaved(false);}} style={{flex:1,cursor:"pointer"}}>
                <div style={{fontSize:13,fontWeight:600,color:C.accent}}>{m.name}</div>
                <div style={{fontSize:11,color:C.muted}}>{m.calories} kcal · {m.protein}g P</div>
              </div>
              <button onClick={()=>delSaved(m.id)} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:16,padding:"0 4px"}}>×</button>
            </div>
          ))}
          <Btn onClick={()=>setShowSaved(false)} variant="ghost" style={{width:"100%",marginTop:10}} sm>Close</Btn>
        </Card>
      )}

      {(phase==="preview"||phase==="analyzing")&&imgSrc&&(
        <Card style={{marginBottom:12}}>
          <img src={imgSrc} alt="" style={{width:"100%",borderRadius:10,maxHeight:220,objectFit:"cover",marginBottom:12}}/>
          {error&&<div style={{color:C.red,fontSize:12,marginBottom:8}}>{error}</div>}
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={analyze} disabled={phase==="analyzing"} style={{flex:1}}>{phase==="analyzing"?"⏳ Analyzing...":"🔍 AI Analyze"}</Btn>
            <Btn onClick={()=>{setPhase("idle");setImgSrc(null);}} variant="ghost">Cancel</Btn>
          </div>
        </Card>
      )}

      {phase==="result"&&result&&(
        <Card style={{marginBottom:12}} glow={C.accent}>
          <div style={{fontSize:15,fontWeight:700,color:C.accent,marginBottom:3}}>{result.name}</div>
          {result.notes&&<div style={{fontSize:11,color:C.muted,marginBottom:10}}>{result.notes}</div>}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12}}>
            <Stat label="Cal" value={result.calories} size={18}/>
            <Stat label="Protein" value={result.protein} unit="g" color={C.blue} size={18}/>
            <Stat label="Carbs" value={result.carbs} unit="g" color={C.yellow} size={18}/>
            <Stat label="Fat" value={result.fat} unit="g" color={C.purple} size={18}/>
          </div>
          {discipline&&totals.cal+result.calories>goal&&(
            <div style={{fontSize:11,color:C.red,padding:"6px 10px",background:C.redD,borderRadius:8,marginBottom:10}}>
              ⚠️ This meal will put you {fmt(totals.cal+result.calories-goal)} kcal over goal.
            </div>
          )}
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <Btn onClick={()=>logEntry(result,false)} style={{flex:1}}>✅ Log</Btn>
            <Btn onClick={()=>logEntry(result,true)} variant="ghost" style={{flex:1}}>⭐ Log & Save</Btn>
            <Btn onClick={()=>{setPhase("idle");setImgSrc(null);setResult(null);}} variant="ghost">Discard</Btn>
          </div>
        </Card>
      )}

      {phase==="manual"&&(
        <Card style={{marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:10}}>Manual Entry</div>
          <Inp label="Food Name" value={manual.name} onChange={e=>setManual(p=>({...p,name:e.target.value}))} placeholder="e.g. Chicken breast + rice"/>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <Inp label="Calories" type="number" value={manual.calories} onChange={e=>setManual(p=>({...p,calories:+e.target.value}))}/>
            <Inp label="Protein (g)" type="number" value={manual.protein} onChange={e=>setManual(p=>({...p,protein:+e.target.value}))}/>
            <Inp label="Carbs (g)" type="number" value={manual.carbs} onChange={e=>setManual(p=>({...p,carbs:+e.target.value}))}/>
            <Inp label="Fat (g)" type="number" value={manual.fat} onChange={e=>setManual(p=>({...p,fat:+e.target.value}))}/>
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={()=>{if(manual.name)logEntry(manual,false);}} style={{flex:1}}>Log</Btn>
            <Btn onClick={()=>{if(manual.name)logEntry(manual,true);}} variant="ghost" style={{flex:1}}>Log & Save</Btn>
            <Btn onClick={()=>setPhase("idle")} variant="ghost">Cancel</Btn>
          </div>
        </Card>
      )}

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:1}}>Today</div>
        <Btn onClick={()=>setHistDate(histDate?null:pastDates[0])} variant="ghost" sm>History</Btn>
      </div>
      {todayEntries.length===0&&<div style={{color:C.muted,fontSize:12,textAlign:"center",padding:"20px 0"}}>No meals logged</div>}
      {todayEntries.map(e=>(
        <Card key={e.id} style={{marginBottom:7,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:C.text}}>{e.name}</div>
            <div style={{fontSize:11,color:C.muted,marginTop:1}}>{e.calories} kcal · {e.protein}g P · {e.carbs}g C · {e.fat}g F</div>
          </div>
          <button onClick={()=>del(e.id)} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:16}}>×</button>
        </Card>
      ))}

      {histDate&&pastDates.map(d=>{
        const entries=foodLog.filter(e=>e.date===d);
        const dc=entries.reduce((a,e)=>a+(e.calories||0),0);
        return (
          <div key={d} style={{marginBottom:10}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
              <div style={{fontSize:11,color:C.muted,textTransform:"uppercase"}}>{fmtDate(d)}</div>
              <Tag color={dc>goal?C.red:C.accent}>{fmt(dc)} kcal</Tag>
            </div>
            {entries.map(e=><Card key={e.id} style={{marginBottom:5,padding:"8px 12px"}}><div style={{fontSize:12,color:C.text}}>{e.name} — {e.calories} kcal · {e.protein}g P</div></Card>)}
          </div>
        );
      })}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// WORKOUT + PR TRACKER
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// VOICE WORKOUT LOG
// ══════════════════════════════════════════════════════════════════════════════
const VoiceWorkoutLog = ({onLog, onClose}) => {
  const [phase, setPhase] = useState("idle");
  const [transcript, setTranscript] = useState("");
  const [editText, setEditText] = useState("");
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [supported, setSupported] = useState(true);
  const [recording, setRecording] = useState(false);
  const recogRef = useRef(null);

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    const recog = new SR();
    recog.continuous = true;
    recog.interimResults = true;
    recog.lang = "en-US";
    let finalText = "";
    recog.onresult = e => {
      finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript + " ";
        else interim += e.results[i][0].transcript;
      }
      setTranscript((finalText + interim).trim());
    };
    recog.onerror = e => { setErrorMsg("Mic error: " + e.error); setPhase("error"); setRecording(false); };
    recog.onend = () => { setRecording(false); if (finalText.trim()) { setTranscript(finalText.trim()); setEditText(finalText.trim()); } };
    recogRef.current = recog;
  }, []);

  const startRec = () => {
    setTranscript(""); setEditText(""); setResult(null); setErrorMsg("");
    recogRef.current?.start();
    setRecording(true); setPhase("recording");
  };

  const stopRec = () => {
    recogRef.current?.stop();
    setRecording(false);
    setPhase("review");
  };

  const analyze = async (text) => {
    if (!text.trim()) return;
    setPhase("processing");
    try {
      const r = await analyzeWorkoutTranscript(text);
      const hasExercises = r.exercises && r.exercises.length > 0;
      const hasCardio = r.cardio && r.cardio.length > 0;
      if (!hasExercises && !hasCardio) throw new Error("Nothing parsed — no cardio or exercises found");
      setResult(r);
      setPhase("result");
    } catch(e) {
      setErrorMsg("Could not parse. Try: '45 minutes of swimming' or '3 sets of 10 reps of 135lb bench press'.");
      setPhase("error");
    }
  };

  const confirmLog = () => {
    if (!result) return;
    onLog(result); // pass full parsed result — logVoiceWorkout handles lift/cardio/mixed
  };

  return (
    <Card style={{marginBottom:12, border:"1px solid "+C.accentM}} glow={C.accent}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:C.text}}>🎙 Voice Workout Log</div>
          <div style={{fontSize:10,color:C.muted}}>Describe your session — AI parses sets, reps & weight</div>
        </div>
        <button onClick={onClose} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:18}}>×</button>
      </div>

      {/* Type fallback */}
      {!supported && phase==="idle" && (
        <div style={{marginBottom:10}}>
          <div style={{fontSize:11,color:C.yellow,padding:"6px 10px",background:C.yellowD,borderRadius:8,marginBottom:10}}>
            ⚠️ Voice not supported. Type your workout below.
          </div>
          <textarea placeholder={"e.g. 3 sets of 10 reps of 40lb kettlebell rows, 3 sets of 8 reps of 135lb bench press"} value={editText} onChange={e=>setEditText(e.target.value)}
            style={{width:"100%",boxSizing:"border-box",background:C.surface,border:"1px solid "+C.border,borderRadius:10,padding:"10px 13px",color:C.text,fontSize:13,fontFamily:"inherit",outline:"none",minHeight:80,resize:"vertical"}}/>
          <Btn onClick={()=>analyze(editText)} style={{width:"100%",marginTop:8}} disabled={!editText.trim()}>Parse Workout</Btn>
        </div>
      )}

      {/* Idle */}
      {supported && phase==="idle" && (
        <div style={{textAlign:"center",padding:"8px 0"}}>
          <div style={{fontSize:12,color:C.muted,marginBottom:14,lineHeight:1.7}}>
            Example: <span style={{color:C.text}}>"3 sets of 10 reps of 40 pound kettlebell rows, 3 sets of 10 reps of 40 pound goblet squats, and 4 sets of 8 reps of 225 pound deadlifts"</span>
          </div>
          <Btn onClick={startRec} style={{width:"100%",padding:"13px"}}>🎙 Start Recording</Btn>
        </div>
      )}

      {/* Recording */}
      {phase==="recording" && (
        <div>
          <div style={{textAlign:"center",marginBottom:12}}>
            <div style={{width:56,height:56,borderRadius:"50%",background:C.red+"22",border:"2px solid "+C.red,
              margin:"0 auto 8px",display:"flex",alignItems:"center",justifyContent:"center",
              animation:"pulse 1s ease-in-out infinite"}}>
              <span style={{fontSize:22}}>🎙</span>
            </div>
            <div style={{fontSize:11,color:C.red,fontWeight:700,letterSpacing:0.5}}>RECORDING</div>
          </div>
          <div style={{background:C.surface,borderRadius:10,padding:"10px 13px",marginBottom:10,minHeight:50,fontSize:13,color:C.text,lineHeight:1.6}}>
            {transcript || <span style={{color:C.muted,fontStyle:"italic"}}>Listening... describe your workout</span>}
          </div>
          <Btn onClick={stopRec} variant="danger" style={{width:"100%"}}>⏹ Stop</Btn>
        </div>
      )}

      {/* Review */}
      {phase==="review" && (
        <div>
          <div style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:0.8,marginBottom:6}}>Transcribed — edit if needed</div>
          <textarea value={editText||transcript} onChange={e=>setEditText(e.target.value)}
            style={{width:"100%",boxSizing:"border-box",background:C.surface,border:"1px solid "+C.border,borderRadius:10,padding:"10px 13px",color:C.text,fontSize:13,fontFamily:"inherit",outline:"none",minHeight:70,resize:"vertical",marginBottom:10}}/>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={()=>analyze(editText||transcript)} style={{flex:1}}>Parse Workout</Btn>
            <Btn onClick={startRec} variant="ghost">Re-record</Btn>
          </div>
        </div>
      )}

      {/* Processing */}
      {phase==="processing" && (
        <div style={{textAlign:"center",padding:"20px 0"}}>
          <div style={{fontSize:22,marginBottom:8,animation:"pulse 1s ease-in-out infinite"}}>🧠</div>
          <div style={{fontSize:13,color:C.muted}}>Parsing your workout...</div>
        </div>
      )}

      {/* Error */}
      {phase==="error" && (
        <div>
          <div style={{fontSize:12,color:C.red,padding:"8px 12px",background:C.redD,borderRadius:8,marginBottom:10}}>{errorMsg}</div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={()=>setPhase(supported?"idle":"idle")} variant="ghost" style={{flex:1}}>Try Again</Btn>
            <Btn onClick={onClose} variant="ghost">Cancel</Btn>
          </div>
        </div>
      )}

      {/* Result */}
      {phase==="result" && result && (
        <div style={{animation:"slideIn 0.3s ease"}}>
          {result.summary && <div style={{fontSize:12,color:C.muted,marginBottom:10,fontStyle:"italic"}}>{result.summary}</div>}

          {/* Cardio section */}
          {(result.cardio||[]).length>0&&(
            <div style={{marginBottom:10}}>
              <div style={{fontSize:11,color:C.blue,textTransform:"uppercase",letterSpacing:0.8,fontWeight:700,marginBottom:6}}>🏊 Cardio</div>
              {result.cardio.map((c,i)=>(
                <div key={i} style={{background:C.surface,borderRadius:10,padding:"10px 12px",marginBottom:8}}>
                  <Inp label="Activity" value={c.activity||""} onChange={e=>setResult(p=>({...p,cardio:p.cardio.map((x,xi)=>xi===i?{...x,activity:e.target.value}:x)}))}/>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    <Inp label="Duration (min)" type="number" value={c.duration_minutes||""} onChange={e=>setResult(p=>({...p,cardio:p.cardio.map((x,xi)=>xi===i?{...x,duration_minutes:+e.target.value}:x)}))}/>
                    <Inp label="Distance (optional)" value={c.distance||""} onChange={e=>setResult(p=>({...p,cardio:p.cardio.map((x,xi)=>xi===i?{...x,distance:e.target.value}:x)}))}/>
                  </div>
                  <Inp label="Notes" value={c.notes||""} onChange={e=>setResult(p=>({...p,cardio:p.cardio.map((x,xi)=>xi===i?{...x,notes:e.target.value}:x)}))}/>
                  <div style={{fontSize:11,color:C.blue}}>Intensity: <Tag color={C.blue}>{c.intensity||"moderate"}</Tag></div>
                </div>
              ))}
            </div>
          )}

          {/* Lifting section */}
          {(result.exercises||[]).length>0&&(
            <div style={{marginBottom:10}}>
              <div style={{fontSize:11,color:C.accent,textTransform:"uppercase",letterSpacing:0.8,fontWeight:700,marginBottom:6}}>🏋️ Lifting</div>
              {result.exercises.map((ex,i)=>(
                <div key={i} style={{background:C.surface,borderRadius:10,padding:"10px 12px",marginBottom:8}}>
                  <Inp label="Exercise" value={ex.exercise||""} onChange={e=>setResult(p=>({...p,exercises:p.exercises.map((x,xi)=>xi===i?{...x,exercise:e.target.value}:x)}))}/>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                    <Inp label={"Weight ("+(ex.unit||"lb")+")"} type="number" value={ex.weight||""} onChange={e=>setResult(p=>({...p,exercises:p.exercises.map((x,xi)=>xi===i?{...x,weight:e.target.value}:x)}))}/>
                    <Inp label="Reps" type="number" value={ex.reps||""} onChange={e=>setResult(p=>({...p,exercises:p.exercises.map((x,xi)=>xi===i?{...x,reps:e.target.value}:x)}))}/>
                    <Inp label="Sets" type="number" value={ex.sets||""} onChange={e=>setResult(p=>({...p,exercises:p.exercises.map((x,xi)=>xi===i?{...x,sets:e.target.value}:x)}))}/>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{fontSize:10,color:C.muted,fontStyle:"italic",marginBottom:10,padding:"5px 10px",background:C.surface,borderRadius:8}}>
            "{editText||transcript}"
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={confirmLog} style={{flex:1}}>✅ Log Workout</Btn>
            <Btn onClick={startRec} variant="ghost">Re-record</Btn>
            <Btn onClick={onClose} variant="ghost">Cancel</Btn>
          </div>
        </div>
      )}
    </Card>
  );
};

const WorkoutTab = ({workouts,setWorkouts,prs,setPrs,checkins,discipline}) => {
  const [showForm,setShowForm]=useState(false);
  const [showVoiceW,setShowVoiceW]=useState(false);
  const [wType,setWType]=useState("lift");
  const [sets,setSets]=useState([{exercise:"",weight:"",reps:"",sets:""}]);
  const [cardio,setCardio]=useState({type:"walk",duration:"",notes:""});
  const [filterDate,setFilterDate]=useState(today());
  const [showPRs,setShowPRs]=useState(false);

  const fatigue=calcFatigue(workouts,checkins);
  const fatigueWarning=fatigue>=7;
  const types=[{value:"lift",label:"🏋️ Lifting"},{value:"cardio",label:"🚴 Cardio"},{value:"outdoor",label:"🌿 Outdoor/Gardening"},{value:"sport",label:"⚽ Sport/Other"}];

  const addSet=()=>setSets(p=>[...p,{exercise:"",weight:"",reps:"",sets:""}]);
  const updSet=(i,f,v)=>setSets(p=>p.map((s,idx)=>idx===i?{...s,[f]:v}:s));

  const logVoiceWorkout=(parsedResult)=>{
    const {workout_type, exercises=[], cardio=[], summary=""} = parsedResult;
    const entries = [];

    // Log each cardio activity as its own entry
    cardio.forEach(c=>{
      entries.push({
        id:Date.now()+Math.random(),
        date:today(),
        type:"cardio",
        cardioActivity: c.activity,
        duration: c.duration_minutes,
        notes: [c.activity, c.distance, c.notes].filter(Boolean).join(" · "),
        voiceNote: summary,
      });
    });

    // Log lifting exercises if any
    if (exercises.length > 0) {
      entries.push({
        id:Date.now()+Math.random(),
        date:today(),
        type:"lift",
        sets: exercises,
        voiceNote: summary,
      });
    }

    // If somehow empty (shouldn't happen), log as generic cardio
    if (entries.length===0) {
      entries.push({id:Date.now(),date:today(),type:"cardio",duration:30,notes:summary,voiceNote:summary});
    }

    const updated=[...entries,...workouts];
    setWorkouts(updated);save(KEYS.workouts,updated);

    // PR detection for lifts only
    const newPRs={...prs};
    exercises.filter(s=>s.exercise&&s.weight).forEach(s=>{
      const key=s.exercise.toLowerCase().trim();
      const w=parseFloat(s.weight);
      if(!newPRs[key]||w>newPRs[key].weight) newPRs[key]={weight:w,reps:s.reps,date:today(),exercise:s.exercise};
    });
    setPrs(newPRs);save(KEYS.prs,newPRs);
    setShowVoiceW(false);
  };

  const logWorkout=()=>{
    const entry={id:Date.now(),date:today(),type:wType,...(wType==="lift"?{sets:sets.filter(s=>s.exercise)}:cardio)};
    const updated=[entry,...workouts];
    setWorkouts(updated);save(KEYS.workouts,updated);

    // PR detection
    if(wType==="lift"){
      const newPRs={...prs};
      sets.filter(s=>s.exercise&&s.weight).forEach(s=>{
        const key=s.exercise.toLowerCase().trim();
        const w=parseFloat(s.weight);
        if(!newPRs[key]||w>newPRs[key].weight){
          newPRs[key]={weight:w,reps:s.reps,date:today(),exercise:s.exercise};
        }
      });
      setPrs(newPRs);save(KEYS.prs,newPRs);
    }

    setShowForm(false);setSets([{exercise:"",weight:"",reps:"",sets:""}]);
    setCardio({type:"walk",duration:"",notes:""});
  };

  const del=id=>{ const u=workouts.filter(w=>w.id!==id);setWorkouts(u);save(KEYS.workouts,u); };
  const filtered=workouts.filter(w=>w.date===filterDate);
  const tIcon={lift:"🏋️",cardio:"🚴",outdoor:"🌿",sport:"⚽"};
  const tColor={lift:C.accent,cardio:C.blue,outdoor:"#86efac",sport:C.yellow};

  const week7=last7();
  const weekW=week7.map(d=>workouts.filter(w=>w.date===d).length);

  // Check new PRs for today
  const todaySets=workouts.filter(w=>w.date===today()&&w.type==="lift").flatMap(w=>w.sets||[]);
  const newPRsToday=todaySets.filter(s=>{
    const key=s.exercise?.toLowerCase().trim();
    return key&&prs[key]?.date===today();
  });

  return (
    <div>
      {fatigueWarning&&(
        <Card style={{marginBottom:12,border:`1px solid ${C.red}55`,background:"#0f0508"}} glow={C.red}>
          <div style={{fontSize:13,fontWeight:700,color:C.red}}>⚡ HIGH FATIGUE WARNING — Score: {fatigue.toFixed(1)}/10</div>
          <div style={{fontSize:12,color:C.text,marginTop:6,lineHeight:1.6}}>
            3+ training days in a row detected. Going heavy today risks injury and stalls recovery.
            Consider: deload session, mobility work, or full rest day.
          </div>
          {discipline&&<div style={{fontSize:11,color:C.muted,marginTop:6}}>Discipline mode note: grinding through severe fatigue isn't toughness — it's how you pull something and spend 3 weeks on the couch. Embarrassing.</div>}
        </Card>
      )}

      {newPRsToday.length>0&&(
        <Card style={{marginBottom:12}} glow={C.yellow}>
          <div style={{fontSize:13,fontWeight:700,color:C.yellow,marginBottom:8}}>🏆 NEW PR{newPRsToday.length>1?"S":""} TODAY!</div>
          {newPRsToday.map((s,i)=>(
            <div key={i} style={{fontSize:12,color:C.text}}>{s.exercise}: {s.weight}lb × {s.reps} reps</div>
          ))}
        </Card>
      )}

      {/* Weekly grid */}
      <Card style={{marginBottom:12}}>
        <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>This Week</div>
        <div style={{display:"flex",gap:5,justifyContent:"space-between"}}>
          {week7.map((d,i)=>{
            const isToday=d===today();
            const count=weekW[i];
            return (
              <div key={d} style={{flex:1,textAlign:"center"}} onClick={()=>setFilterDate(d)}>
                <div style={{height:38,background:count>0?C.accentD:C.surface,border:`1px solid ${count>0?C.accentM:C.border}`,borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
                  <span style={{fontSize:count>0?15:11}}>{count>0?"💪":"·"}</span>
                </div>
                <div style={{fontSize:9,color:isToday?C.accent:C.muted,marginTop:3,fontWeight:isToday?700:400}}>
                  {new Date(d+"T12:00").toLocaleDateString("en-US",{weekday:"short"}).slice(0,2)}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{display:"flex",justifyContent:"space-between",marginTop:10,alignItems:"center"}}>
          <span style={{fontSize:11,color:C.muted}}>Fatigue: <span style={{color:fatigueWarning?C.red:C.accent,fontWeight:700}}>{fatigue.toFixed(1)}/10</span></span>
          <Btn onClick={()=>setShowPRs(!showPRs)} sm variant="ghost">🏆 PRs ({Object.keys(prs).length})</Btn>
        </div>
      </Card>

      {/* PR Board */}
      {showPRs&&(
        <Card style={{marginBottom:12,border:`1px solid ${C.yellow}44`}}>
          <div style={{fontSize:13,fontWeight:700,color:C.yellow,marginBottom:10}}>🏆 Personal Records</div>
          {Object.keys(prs).length===0&&<div style={{fontSize:12,color:C.muted}}>No PRs yet. Log lifting sessions to track them automatically.</div>}
          {Object.entries(prs).map(([k,v])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:`1px solid ${C.border}`}}>
              <div style={{fontSize:13,color:C.text,fontWeight:600}}>{v.exercise}</div>
              <div style={{textAlign:"right"}}>
                <span style={{fontSize:13,color:C.yellow,fontWeight:700,fontFamily:"'Space Mono',monospace"}}>{v.weight}lb</span>
                <span style={{fontSize:11,color:C.muted}}> × {v.reps} · {fmtDate(v.date)}</span>
              </div>
            </div>
          ))}
        </Card>
      )}

      <div style={{display:"flex",gap:8,marginBottom:12,alignItems:"center"}}>
        <input type="date" value={filterDate} onChange={e=>setFilterDate(e.target.value)}
          style={{flex:1,background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"9px 13px",color:C.text,fontSize:14,fontFamily:"inherit"}}/>
        <Btn onClick={()=>{setShowVoiceW(false);setShowForm(true);}}>+ Log</Btn>
        <Btn onClick={()=>{setShowForm(false);setShowVoiceW(v=>!v);}} variant="ghost">🎙 Voice</Btn>
      </div>

      {showVoiceW&&(
        <VoiceWorkoutLog
          onLog={(result)=>logVoiceWorkout(result)}
          onClose={()=>setShowVoiceW(false)}
        />
      )}

      {showForm&&(
        <Card style={{marginBottom:12}} glow={C.accent}>
          {fatigueWarning&&<div style={{fontSize:11,color:C.red,marginBottom:10,padding:"6px 10px",background:C.redD,borderRadius:8}}>⚠️ High fatigue. Consider lighter loads or shorter session.</div>}
          <Sel label="Type" value={wType} onChange={e=>setWType(e.target.value)} options={types}/>
          {wType==="lift"&&(
            <>
              <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",gap:6,marginBottom:5}}>
                {["Exercise","lbs","Reps","Sets"].map(h=><div key={h} style={{fontSize:9,color:C.muted,textTransform:"uppercase"}}>{h}</div>)}
              </div>
              {sets.map((s,i)=>(
                <div key={i} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",gap:5,marginBottom:5}}>
                  {["exercise","weight","reps","sets"].map((f,fi)=>(
                    <input key={f} type={fi===0?"text":"number"} placeholder={[s.exercise||"Deadlift","515","5","3"][fi]}
                      value={s[f]} onChange={e=>updSet(i,f,e.target.value)}
                      style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:7,padding:"7px 8px",color:C.text,fontSize:12,fontFamily:"inherit"}}/>
                  ))}
                </div>
              ))}
              <Btn onClick={addSet} variant="ghost" style={{width:"100%",marginBottom:10}} sm>+ Exercise</Btn>
            </>
          )}
          {wType!=="lift"&&(
            <>
              <Inp label="Duration (min)" type="number" value={cardio.duration} onChange={e=>setCardio(p=>({...p,duration:e.target.value}))}/>
              <Inp label="Notes" value={cardio.notes} onChange={e=>setCardio(p=>({...p,notes:e.target.value}))} placeholder="e.g. Mowed lawn, 45 min moderate"/>
            </>
          )}
          <div style={{display:"flex",gap:8}}>
            <Btn onClick={logWorkout} style={{flex:1}}>Save</Btn>
            <Btn onClick={()=>setShowForm(false)} variant="ghost">Cancel</Btn>
          </div>
        </Card>
      )}

      {filtered.length===0&&<div style={{color:C.muted,fontSize:12,textAlign:"center",padding:"28px 0"}}>No workouts on {filterDate===today()?"today":fmtDate(filterDate)}</div>}
      {filtered.map(w=>(
        <Card key={w.id} style={{marginBottom:10}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <span style={{fontSize:20}}>{tIcon[w.type]||"💪"}</span>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:tColor[w.type]||C.accent}}>{w.type.charAt(0).toUpperCase()+w.type.slice(1)}</div>
                {w.duration&&<div style={{fontSize:11,color:C.muted}}>{w.duration}min{w.notes?` · ${w.notes}`:""}</div>}
              </div>
            </div>
            <button onClick={()=>del(w.id)} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:16}}>×</button>
          </div>
          {/* Cardio detail */}
          {w.type==="cardio"&&w.cardioActivity&&(
            <div style={{marginTop:8,fontSize:12,color:C.blue}}>
              {w.cardioActivity} · {w.duration}min
              {w.notes&&w.notes!==w.cardioActivity&&<span style={{color:C.muted}}> · {w.notes}</span>}
            </div>
          )}
          {/* Lift sets table */}
          {w.sets?.length>0&&(
            <div style={{marginTop:10}}>
              <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",gap:3,marginBottom:5}}>
                {["Exercise","Weight","Reps","Sets"].map(h=><div key={h} style={{fontSize:9,color:C.muted,textTransform:"uppercase"}}>{h}</div>)}
              </div>
              {w.sets.map((s,i)=>{
                const isPR=prs[s.exercise?.toLowerCase().trim()]?.date===w.date;
                return (
                  <div key={i} style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",gap:3,marginBottom:4,alignItems:"center"}}>
                    <div style={{fontSize:12,color:isPR?C.yellow:C.text,fontWeight:isPR?700:400}}>{s.exercise}{isPR?" 🏆":""}</div>
                    <div style={{fontSize:12,color:C.muted}}>{s.weight}lb</div>
                    <div style={{fontSize:12,color:C.muted}}>{s.reps}</div>
                    <div style={{fontSize:12,color:C.muted}}>{s.sets}</div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// WALK TAB (GPS)
// ══════════════════════════════════════════════════════════════════════════════
const WalkTab = ({walks,setWalks,discipline}) => {
  const [tracking,setTracking]=useState(false);
  const [path,setPath]=useState([]);
  const [watchId,setWatchId]=useState(null);
  const [elapsed,setElapsed]=useState(0);
  const [error,setError]=useState("");
  const [selected,setSelected]=useState(null);
  const timerRef=useRef(); const canvasRef=useRef(); const histRef=useRef();

  const distKm=c=>{ let d=0; for(let i=1;i<c.length;i++){const R=6371,dLa=(c[i].lat-c[i-1].lat)*Math.PI/180,dLo=(c[i].lng-c[i-1].lng)*Math.PI/180,a=Math.sin(dLa/2)**2+Math.cos(c[i-1].lat*Math.PI/180)*Math.cos(c[i].lat*Math.PI/180)*Math.sin(dLo/2)**2;d+=R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));} return d; };

  const drawMap=(canvas,coords)=>{
    if(!canvas||coords.length<2)return;
    const ctx=canvas.getContext("2d"),W=canvas.width,H=canvas.height;
    ctx.clearRect(0,0,W,H); ctx.fillStyle=C.surface; ctx.fillRect(0,0,W,H);
    const lats=coords.map(c=>c.lat),lngs=coords.map(c=>c.lng);
    const minLa=Math.min(...lats),maxLa=Math.max(...lats),minLo=Math.min(...lngs),maxLo=Math.max(...lngs);
    const p=28,sx=(W-p*2)/(maxLo-minLo||.0001),sy=(H-p*2)/(maxLa-minLa||.0001);
    const tx=lo=>p+(lo-minLo)*sx,ty=la=>H-p-(la-minLa)*sy;
    ctx.strokeStyle=C.border; ctx.lineWidth=1;
    for(let i=0;i<=4;i++){ctx.beginPath();ctx.moveTo(p+i*(W-p*2)/4,0);ctx.lineTo(p+i*(W-p*2)/4,H);ctx.stroke();ctx.beginPath();ctx.moveTo(0,p+i*(H-p*2)/4);ctx.lineTo(W,p+i*(H-p*2)/4);ctx.stroke();}
    ctx.strokeStyle=C.accentM;ctx.lineWidth=8;ctx.lineCap="round";ctx.lineJoin="round";
    ctx.beginPath();ctx.moveTo(tx(coords[0].lng),ty(coords[0].lat));coords.forEach(c=>ctx.lineTo(tx(c.lng),ty(c.lat)));ctx.stroke();
    ctx.strokeStyle=C.accent;ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(tx(coords[0].lng),ty(coords[0].lat));coords.forEach(c=>ctx.lineTo(tx(c.lng),ty(c.lat)));ctx.stroke();
    ctx.fillStyle=C.success;ctx.beginPath();ctx.arc(tx(coords[0].lng),ty(coords[0].lat),7,0,Math.PI*2);ctx.fill();
    const last=coords[coords.length-1];
    ctx.fillStyle=C.red;ctx.beginPath();ctx.arc(tx(last.lng),ty(last.lat),7,0,Math.PI*2);ctx.fill();
  };

  useEffect(()=>{drawMap(canvasRef.current,path);},[path]);
  useEffect(()=>{if(selected)drawMap(histRef.current,selected.path);},[selected]);

  const start=()=>{
    if(!navigator.geolocation){setError("GPS not supported.");return;}
    setError("");setPath([]);setElapsed(0);setTracking(true);
    const st=Date.now();
    timerRef.current=setInterval(()=>setElapsed(Math.floor((Date.now()-st)/1000)),1000);
    const id=navigator.geolocation.watchPosition(pos=>setPath(p=>[...p,{lat:pos.coords.latitude,lng:pos.coords.longitude}]),e=>setError("GPS: "+e.message),{enableHighAccuracy:true,maximumAge:5000});
    setWatchId(id);
  };

  const stop=()=>{
    if(watchId!==null)navigator.geolocation.clearWatch(watchId);
    clearInterval(timerRef.current);setTracking(false);
    if(path.length>1){
      const dist=distKm(path);
      const e={id:Date.now(),date:today(),path,dist:dist.toFixed(2),duration:elapsed,steps:Math.round(dist*1312)};
      const u=[e,...walks];setWalks(u);save(KEYS.walks,u);
    }
  };

  const del=id=>{ const u=walks.filter(w=>w.id!==id);setWalks(u);save(KEYS.walks,u); };
  const ft=s=>`${Math.floor(s/60).toString().padStart(2,"0")}:${(s%60).toString().padStart(2,"0")}`;
  const dist=distKm(path);

  const noWalkToday=!walks.some(w=>w.date===today());
  const missedYesterday=!walks.some(w=>w.date===new Date(Date.now()-86400000).toISOString().slice(0,10));

  return (
    <div>
      {discipline&&noWalkToday&&hour()>12&&(
        <Card style={{marginBottom:12,border:`1px solid ${C.red}55`,background:"#0f0508"}} glow={C.red}>
          <div style={{fontSize:13,fontWeight:700,color:C.red}}>🚨 NO WALK LOGGED TODAY</div>
          <div style={{fontSize:12,color:C.text,marginTop:4,lineHeight:1.5}}>
            {missedYesterday?"Two days without a walk. This is unacceptable. Get your steps in NOW.":"It's past noon. Get outside. Even 20 minutes counts."}
          </div>
        </Card>
      )}

      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:12}}>
        <Stat label="Walks" value={walks.length} color={C.blue} size={20}/>
        <Stat label="Total Steps" value={fmt(walks.reduce((a,w)=>a+(w.steps||0),0))} color={C.yellow} size={20}/>
        <Stat label="Total km" value={walks.reduce((a,w)=>a+parseFloat(w.dist||0),0).toFixed(1)} color={C.accent} size={20}/>
      </div>

      {error&&<div style={{color:C.red,fontSize:12,marginBottom:10,padding:"8px 12px",background:C.redD,borderRadius:8}}>{error}</div>}

      <Card style={{marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:C.text}}>GPS Walk Tracker</div>
            <div style={{fontSize:10,color:C.muted}}>Keep screen on while walking</div>
          </div>
          {tracking?<Btn onClick={stop} variant="danger">⏹ Stop</Btn>:<Btn onClick={start}>▶ Start</Btn>}
        </div>
        {(tracking||path.length>0)&&(
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:12}}>
            <Stat label="Time" value={ft(elapsed)} color={C.blue} size={18}/>
            <Stat label="km" value={dist.toFixed(2)} color={C.accent} size={18}/>
            <Stat label="Steps" value={fmt(Math.round(dist*1312))} color={C.yellow} size={18}/>
          </div>
        )}
        {path.length>=2
          ?<canvas ref={canvasRef} width={560} height={200} style={{width:"100%",height:170,borderRadius:10,border:`1px solid ${C.border}`}}/>
          :<div style={{height:90,background:C.surface,borderRadius:10,border:`1px dashed ${C.border}`,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <span style={{color:C.muted,fontSize:12}}>Map appears after GPS locks</span>
          </div>
        }
      </Card>

      <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Walk History</div>
      {walks.length===0&&<div style={{color:C.muted,fontSize:12,textAlign:"center",padding:"24px 0"}}>No walks yet</div>}
      {walks.map(w=>(
        <Card key={w.id} style={{marginBottom:8,cursor:"pointer",border:selected?.id===w.id?`1px solid ${C.accentM}`:undefined}} onClick={()=>setSelected(selected?.id===w.id?null:w)}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:C.text}}>🚶 {fmtDate(w.date)}</div>
              <div style={{fontSize:11,color:C.muted,marginTop:2}}>{w.dist}km · {ft(w.duration)} · {fmt(w.steps)} steps</div>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <span style={{color:C.muted,fontSize:13}}>{selected?.id===w.id?"▲":"▼"}</span>
              <button onClick={e=>{e.stopPropagation();del(w.id);}} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:15}}>×</button>
            </div>
          </div>
          {selected?.id===w.id&&w.path?.length>=2&&(
            <canvas ref={histRef} width={560} height={180} style={{width:"100%",height:150,borderRadius:10,marginTop:10,border:`1px solid ${C.border}`}}/>
          )}
        </Card>
      ))}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// RECOVERY TAB (full page)
// ══════════════════════════════════════════════════════════════════════════════
const RecoveryTab = ({profile,hydration,setHydration,recovery,setRecovery,workouts,discipline}) => {
  const workedOut=workouts.some(w=>w.date===today());
  return (
    <div>
      <HydrationWidget profile={profile} hydration={hydration} setHydration={setHydration} workedOut={workedOut} discipline={discipline}/>
      <RecoveryWidget recovery={recovery} setRecovery={setRecovery}/>

      {/* Hydration history */}
      <Card style={{marginBottom:12}}>
        <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>7-Day Hydration</div>
        {(() => {
          const data=last7().map(d=>({x:d,y:hydration[d]||0}));
          const goalOz=calcWaterGoalOz(profile,false);
          return (
            <>
              <Sparkline data={data} color={C.blue} h={50} fillColor={C.blue}/>
              <div style={{fontSize:11,color:C.muted,marginTop:6}}>Daily goal: {goalOz}oz · Weekly total: {fmt(data.reduce((a,d)=>a+d.y,0))}oz</div>
            </>
          );
        })()}
      </Card>

      <Card>
        <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:10}}>💡 Hydration Science</div>
        {[
          {i:"📏",t:`At your size (${profile.weight||"—"}lb), your daily water goal is ~${calcWaterGoalOz(profile,false)}oz — calculated as 0.5oz per pound of bodyweight. This is significantly above the generic "8 glasses" recommendation, which ignores body size entirely.`},
          {i:"🔥",t:"Every 1% body weight lost to dehydration drops strength output by ~2% and fat oxidation slows measurably."},
          {i:"🏋️",t:"Add 16oz per workout session. Hot or humid conditions? Add another 8–12oz per hour of activity."},
          {i:"☕",t:"Caffeine has a mild diuretic effect — add 4–8oz water per cup of coffee."},
          {i:"🌙",t:"Aim for 60% of your goal done by 2pm. Late loading causes sleep disruption from nighttime bathroom trips."},
        ].map((r,i)=>(
          <div key={i} style={{display:"flex",gap:10,padding:"8px 0",borderBottom:i<4?`1px solid ${C.border}`:undefined}}>
            <span style={{fontSize:18}}>{r.i}</span>
            <span style={{fontSize:12,color:C.text,lineHeight:1.55}}>{r.t}</span>
          </div>
        ))}
      </Card>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// CHECK-IN TAB
// ══════════════════════════════════════════════════════════════════════════════
const CheckinTab = ({checkins,setCheckins,profile}) => {
  const todayCI=checkins.find(c=>c.date===today());
  const [form,setForm]=useState(todayCI||{date:today(),weight:"",waist:"",sleep:"",hunger:3,performance:3,notes:""});
  const [saved,setSaved]=useState(!!todayCI);

  const saveCI=()=>{
    const u=[...checkins.filter(c=>c.date!==today()),{...form,date:today()}].sort((a,b)=>a.date>b.date?1:-1);
    setCheckins(u);save(KEYS.checkins,u);setSaved(true);
  };

  const trend=weightTrend(checkins.slice(-6));
  const weightHist=checkins.filter(c=>c.weight).map(c=>({x:c.date,y:parseFloat(c.weight)}));
  const waistHist=checkins.filter(c=>c.waist).map(c=>({x:c.date,y:parseFloat(c.waist)}));

  const Emoji=({field,vals})=>(
    <div style={{display:"flex",gap:5}}>
      {vals.map(v=>(
        <button key={v.n} onClick={()=>setForm(p=>({...p,[field]:v.n}))} style={{
          flex:1,padding:"9px 0",borderRadius:9,border:`1px solid ${form[field]===v.n?v.c:C.border}`,
          background:form[field]===v.n?v.c+"22":C.surface,fontSize:16,cursor:"pointer",
          transition:"all 0.15s"
        }}>{v.e}</button>
      ))}
    </div>
  );

  return (
    <div>
      {weightHist.length>=2&&(
        <Card style={{marginBottom:12}}>
          <Sparkline data={weightHist} color={C.blue} h={56} label="Weight (lbs)" fillColor={C.blue}/>
          {trend!==null&&<div style={{fontSize:11,marginTop:8}}>
            <span style={{color:C.muted}}>Monthly rate: </span>
            <span style={{color:trend<0?C.success:C.red,fontWeight:700}}>{trend<0?"":"+"}{ (trend*4).toFixed(1)} lb/mo</span>
            {trend<-4?" · ⚠️ Too fast":trend<=-1?" · ✅ Aggressive & on pace":trend<=-0.5?" · ✅ On pace":" · 📉 Cut harder or add cardio"}
          </div>}
        </Card>
      )}
      {waistHist.length>=2&&(
        <Card style={{marginBottom:12}}>
          <Sparkline data={waistHist} color={C.purple} h={40} label="Waist (inches)" fillColor={C.purple}/>
        </Card>
      )}

      <Card style={{marginBottom:12}} glow={saved?C.success:undefined}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:700,color:C.text}}>Weekly Check-In</div>
          {saved&&<Tag color={C.success}>✅ Saved</Tag>}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <Inp label="Weight (lbs)" type="number" value={form.weight} onChange={e=>setForm(p=>({...p,weight:e.target.value}))} placeholder="321"/>
          <Inp label="Waist (in)" type="number" value={form.waist} onChange={e=>setForm(p=>({...p,waist:e.target.value}))} placeholder="48"/>
        </div>
        <Inp label="Sleep (hours)" type="number" step="0.5" value={form.sleep} onChange={e=>setForm(p=>({...p,sleep:e.target.value}))} placeholder="7.5"/>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:0.8,marginBottom:6}}>Hunger Level</div>
          <Emoji field="hunger" vals={[{n:1,e:"😌",c:C.success},{n:2,e:"🙂",c:C.accent},{n:3,e:"😐",c:C.yellow},{n:4,e:"😤",c:C.orange},{n:5,e:"🤤",c:C.red}]}/>
        </div>
        <div style={{marginBottom:12}}>
          <div style={{fontSize:11,color:C.muted,textTransform:"uppercase",letterSpacing:0.8,marginBottom:6}}>Training Performance</div>
          <Emoji field="performance" vals={[{n:1,e:"💀",c:C.red},{n:2,e:"😩",c:C.orange},{n:3,e:"😐",c:C.yellow},{n:4,e:"💪",c:C.accent},{n:5,e:"🔥",c:C.success}]}/>
        </div>
        <Inp label="Notes" value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} placeholder="How's the cut feeling?"/>
        <Btn onClick={saveCI} style={{width:"100%"}}>Save Check-In</Btn>
      </Card>

      <div style={{fontSize:10,color:C.muted,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>History</div>
      {checkins.length===0&&<div style={{color:C.muted,fontSize:12,textAlign:"center",padding:"20px 0"}}>No check-ins yet</div>}
      {[...checkins].reverse().map(c=>(
        <Card key={c.date} style={{marginBottom:7,padding:"10px 14px"}}>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <div style={{fontSize:12,fontWeight:600,color:C.accent}}>{fmtDate(c.date)}</div>
            <div style={{display:"flex",gap:6}}>
              {c.weight&&<Tag color={C.blue}>{c.weight}lb</Tag>}
              {c.waist&&<Tag color={C.purple}>{c.waist}"</Tag>}
            </div>
          </div>
          <div style={{fontSize:11,color:C.muted,marginTop:3}}>
            {c.sleep&&`💤 ${c.sleep}h`}{c.hunger&&` · Hunger ${c.hunger}/5`}{c.performance&&` · Perf ${c.performance}/5`}
          </div>
          {c.notes&&<div style={{fontSize:11,color:C.text,marginTop:3}}>{c.notes}</div>}
        </Card>
      ))}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// HEALTH TAB
// ══════════════════════════════════════════════════════════════════════════════
const HealthTab = ({profile,setProfile}) => {
  const [editing,setEditing]=useState(!profile.weight);
  const [draft,setDraft]=useState(profile);
  const save_p=()=>{setProfile(draft);save(KEYS.profile,draft);setEditing(false);};
  const bmi=calcBMI(draft),bmr=calcBMR(draft),tdee=calcTDEE(draft),cat=bmiCat(parseFloat(bmi));
  const waterGoal=calcWaterGoalOz(draft,false);
  return (
    <div>
      {editing?(
        <Card style={{marginBottom:12}} glow={C.accent}>
          <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:12}}>Your Profile</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <Inp label="Age" type="number" value={draft.age||""} onChange={e=>setDraft(p=>({...p,age:+e.target.value}))}/>
            <Sel label="Sex" value={draft.sex||"male"} onChange={e=>setDraft(p=>({...p,sex:e.target.value}))} options={[{value:"male",label:"Male"},{value:"female",label:"Female"}]}/>
            <Inp label='Height (in)' type="number" value={draft.height||""} onChange={e=>setDraft(p=>({...p,height:+e.target.value}))} placeholder="76 = 6'4&quot;"/>
            <Inp label="Weight (lbs)" type="number" value={draft.weight||""} onChange={e=>setDraft(p=>({...p,weight:+e.target.value}))}/>
            <Inp label="Cal Goal" type="number" value={draft.calorieGoal||""} onChange={e=>setDraft(p=>({...p,calorieGoal:+e.target.value}))} placeholder="Auto if blank"/>
            <Inp label="Protein Goal (g)" type="number" value={draft.proteinGoal||""} onChange={e=>setDraft(p=>({...p,proteinGoal:+e.target.value}))}/>
          </div>
          <Sel label="Activity Level" value={draft.activity||"moderate"} onChange={e=>setDraft(p=>({...p,activity:e.target.value}))} options={[
            {value:"sedentary",label:"Sedentary"},
            {value:"light",label:"Light (1–3x/week)"},
            {value:"moderate",label:"Moderate (3–5x/week)"},
            {value:"active",label:"Active (6–7x/week)"},
            {value:"veryActive",label:"Very Active (2x/day)"},
          ]}/>
          <Btn onClick={save_p} style={{width:"100%"}}>Save</Btn>
        </Card>
      ):(
        <Card style={{marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:C.text}}>Profile</div>
            <Btn onClick={()=>{setDraft(profile);setEditing(true);}} sm variant="ghost">Edit</Btn>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10}}>
            <Stat label="Age" value={profile.age||"—"} unit="yrs" size={20}/>
            <Stat label="Weight" value={profile.weight||"—"} unit="lbs" size={20}/>
            <Stat label="Height" value={profile.height?`${Math.floor(profile.height/12)}'${profile.height%12}"`:"—"} size={20}/>
            <Stat label="Water Goal" value={waterGoal} unit="oz/day" color={C.blue} size={20}/>
          </div>
        </Card>
      )}

      {profile.weight&&(
        <>
          <Card style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:700,color:C.text}}>BMI</div>
              <div style={{fontSize:24,fontWeight:900,color:cat.c,fontFamily:"'Space Mono',monospace"}}>{bmi}</div>
            </div>
            <div style={{height:10,background:C.border,borderRadius:99,overflow:"hidden",position:"relative",marginBottom:7}}>
              {[["#60a5fa",0,18.5],["#34d399",18.5,25],["#fbbf24",25,30],["#f87171",30,40]].map(([c,s,e])=>(
                <div key={s} style={{position:"absolute",left:`${(s/40)*100}%`,width:`${((e-s)/40)*100}%`,height:"100%",background:c}}/>
              ))}
              <div style={{position:"absolute",top:-3,width:16,height:16,background:cat.c,borderRadius:"50%",border:"2px solid "+C.bg,left:`calc(${Math.min(98,(parseFloat(bmi)/40)*100)}% - 8px)`}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.muted,marginBottom:6}}><span>Under</span><span>Normal</span><span>Over</span><span>Obese</span></div>
            <Tag color={cat.c}>{cat.l}</Tag>
          </Card>

          <Card style={{marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:12}}>Calorie Targets</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
              {[{l:"Aggressive",v:Math.round(tdee*0.65),c:C.red},{l:"Moderate",v:Math.round(tdee*0.80),c:C.accent},{l:"Maintenance",v:tdee,c:C.blue}].map(t=>(
                <div key={t.l} style={{textAlign:"center",padding:"10px 6px",background:t.c+"18",borderRadius:10,border:`1px solid ${t.c}33`}}>
                  <div style={{fontSize:17,fontWeight:900,color:t.c,fontFamily:"'Space Mono',monospace"}}>{fmt(t.v)}</div>
                  <div style={{fontSize:9,color:C.muted,marginTop:3,textTransform:"uppercase"}}>{t.l}</div>
                </div>
              ))}
            </div>
            <div style={{fontSize:11,color:C.muted,marginTop:10}}>BMR: {fmt(bmr)} · TDEE: {fmt(tdee)} kcal · Water: {waterGoal}oz/day</div>
          </Card>

          <Card>
            <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:10}}>Metabolic Boosters</div>
            {[
              {i:"💪",t:"4x/week lifting preserves muscle while cutting — without it, up to 40% of weight lost can be lean mass"},
              {i:"🚶",t:"12,000+ steps adds 400–600 kcal burned without recovery cost"},
              {i:"🥩",t:"1g protein/lb protects muscle. At your weight, that's a non-negotiable priority"},
              {i:"😴",t:"7–9h sleep: poor sleep cuts fat oxidation by 55% and spikes cortisol"},
              {i:"🌡️",t:"Cold showers activate brown fat, slightly boosting BMR and norepinephrine"},
              {i:"⚡",t:"Break sitting every 45 min — NEAT accounts for up to 350 kcal/day variation"},
              {i:"🫀",t:"Zone 2 cardio 3x/week improves mitochondrial density and fat oxidation"},
              {i:"🥗",t:"30–40g fiber/day improves insulin sensitivity and keeps hunger manageable"},
            ].map((r,i)=>(
              <div key={i} style={{display:"flex",gap:10,padding:"7px 0",borderBottom:i<7?`1px solid ${C.border}`:undefined}}>
                <span style={{fontSize:17}}>{r.i}</span>
                <span style={{fontSize:12,color:C.text,lineHeight:1.55}}>{r.t}</span>
              </div>
            ))}
          </Card>
        </>
      )}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// DATA TAB
// ══════════════════════════════════════════════════════════════════════════════
const DataTab = ({profile,foodLog,workouts,walks,checkins,savedMeals,hydration,recovery,prs,onImport}) => {
  const [msg,setMsg]=useState("");
  const [importing,setImporting]=useState(false);

  const exportData=()=>{
    const data={exportedAt:new Date().toISOString(),version:"3.0",profile,foodLog,workouts,walks,checkins,savedMeals,hydration,recovery,prs,
      summary:{foodEntries:foodLog.length,workouts:workouts.length,walks:walks.length,checkins:checkins.length,savedMeals:savedMeals.length,prs:Object.keys(prs).length}
    };
    try {
      const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;
      a.download=`fitelations-${today()}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); },100);
      setMsg("✅ Export downloaded!");
      setTimeout(()=>setMsg(""),3000);
    } catch(e) {
      setMsg("❌ Export failed: "+e.message);
    }
  };

  const processFile = (file) => {
    if (!file) return;
    if (!file.name.endsWith(".json") && file.type !== "application/json") {
      setMsg("❌ Please select a .json file exported from Fitelations.");
      return;
    }
    setImporting(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const d = JSON.parse(text);
        if (!d.version) throw new Error("Missing version field — not a Fitelations export");
        onImport(d);
        setMsg("✅ Imported! " + (d.summary ? `${d.summary.foodEntries||0} meals, ${d.summary.workouts||0} workouts, ${d.summary.checkins||0} check-ins restored.` : "Data restored."));
      } catch(err) {
        setMsg("❌ Could not read file: " + err.message + ". Make sure you uploaded a Fitelations export JSON.");
      }
      setImporting(false);
    };
    reader.onerror = () => { setMsg("❌ File read error. Try again."); setImporting(false); };
    reader.readAsText(file);
  };

  const stats=[
    {l:"Food entries",v:foodLog.length,c:C.accent},
    {l:"Workouts",v:workouts.length,c:C.blue},
    {l:"Walks",v:walks.length,c:C.yellow},
    {l:"Check-ins",v:checkins.length,c:C.purple},
    {l:"Saved meals",v:savedMeals.length,c:C.success},
    {l:"PRs tracked",v:Object.keys(prs).length,c:C.orange},
  ];

  return (
    <div>
      <Card style={{marginBottom:12}}>
        <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:12}}>Data Summary</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
          {stats.map(s=>(
            <div key={s.l} style={{padding:"10px",background:C.surface,borderRadius:10,border:"1px solid "+C.border,textAlign:"center"}}>
              <div style={{fontSize:20,fontWeight:900,color:s.c,fontFamily:"'Space Mono',monospace"}}>{s.v}</div>
              <div style={{fontSize:9,color:C.muted,marginTop:3,textTransform:"uppercase"}}>{s.l}</div>
            </div>
          ))}
        </div>
      </Card>

      {msg&&(
        <div style={{fontSize:12,padding:"10px 14px",borderRadius:10,marginBottom:12,lineHeight:1.5,
          background:msg.startsWith("✅")?C.success+"22":C.red+"22",
          color:msg.startsWith("✅")?C.success:C.red,
          border:"1px solid "+(msg.startsWith("✅")?C.success+"44":C.red+"44")}}>
          {msg}
        </div>
      )}

      <Card style={{marginBottom:12}}>
        <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:6}}>⬇️ Export Data</div>
        <div style={{fontSize:12,color:C.muted,marginBottom:12,lineHeight:1.5}}>Downloads all your data as a JSON file. Save it to iCloud or Google Drive as a weekly backup. Import on any device to restore everything.</div>
        <Btn onClick={exportData} style={{width:"100%"}}>Export Data</Btn>
      </Card>

      <Card style={{marginBottom:12}}>
        <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:6}}>⬆️ Import Data</div>
        <div style={{fontSize:12,color:C.muted,marginBottom:12,lineHeight:1.5}}>Select a Fitelations export JSON to restore your data. Existing entries are kept — nothing is overwritten.</div>
        <label style={{display:"block",width:"100%",boxSizing:"border-box"}}>
          <div style={{
            width:"100%",padding:"11px 20px",borderRadius:10,border:"1px solid "+C.accentM,
            background:"transparent",color:C.accent,fontWeight:700,fontSize:13,
            cursor:"pointer",textAlign:"center",fontFamily:"inherit",
            transition:"all 0.2s"
          }}>
            {importing ? "⏳ Importing..." : "⬆️ Choose JSON File"}
          </div>
          <input
            type="file"
            accept=".json,application/json"
            style={{position:"absolute",left:"-9999px",opacity:0,width:1,height:1}}
            onChange={e=>{ if(e.target.files[0]) processFile(e.target.files[0]); e.target.value=""; }}
          />
        </label>
        <div style={{fontSize:11,color:C.muted,marginTop:8,textAlign:"center"}}>
          Tap the button above → select your fitelations-[date].json file
        </div>
      </Card>

      {/* How storage works */}
      <Card style={{marginBottom:12,border:"1px solid "+C.border}}>
        <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:12}}>📖 How Data Storage Works</div>
        {[
          {
            icon:"💾",
            title:"Auto-saves instantly",
            body:"Every meal, workout, walk, and check-in saves automatically to your browser's local storage the moment you log it. There is no manual save button — if you logged it, it's saved."
          },
          {
            icon:"📸",
            title:"Exports are snapshots, not sync files",
            body:"Each export creates a new dated file (fitelations-2026-05-19.json) capturing everything at that moment. It does not auto-update. Every time you export, you get a fresh snapshot. Keep the most recent one."
          },
          {
            icon:"⚠️",
            title:"Data lives on this device and browser only",
            body:"Your data is stored in this specific browser on this specific device. Switching from Safari to Chrome, clearing your browser history, or uninstalling the app will erase everything. Your export file is your only backup."
          },
          {
            icon:"📱",
            title:"Moving to a new device",
            body:"Export on your old device → save the file to iCloud or Google Drive → open Fitelations on your new device → import the file. All your history, meals, workouts, and PRs will be restored."
          },
          {
            icon:"🔄",
            title:"Using two devices",
            body:"Fitelations does not sync automatically between devices. To keep two devices in sync: export from device A → import on device B. Do this whenever you want to transfer your latest data."
          },
          {
            icon:"📅",
            title:"Day tracking accuracy",
            body:"Every entry is date-stamped using your device's local clock. Daily totals, charts, and the Coach all filter by exact date. As long as your device clock is correct, your daily data is accurate."
          },
        ].map((item,i)=>(
          <div key={i} style={{
            display:"flex",gap:12,padding:"10px 0",
            borderBottom:i<5?"1px solid "+C.border:undefined
          }}>
            <span style={{fontSize:20,flexShrink:0,marginTop:1}}>{item.icon}</span>
            <div>
              <div style={{fontSize:12,fontWeight:700,color:C.text,marginBottom:3}}>{item.title}</div>
              <div style={{fontSize:12,color:C.muted,lineHeight:1.6}}>{item.body}</div>
            </div>
          </div>
        ))}
      </Card>

      <Card style={{border:"1px solid "+C.blue+"44",background:C.blueD}}>
        <div style={{fontSize:12,fontWeight:700,color:C.blue,marginBottom:6}}>💡 Recommended Routine</div>
        <div style={{fontSize:12,color:C.text,lineHeight:1.7}}>
          <div style={{marginBottom:4}}>📅 <strong>Daily:</strong> Just use the app — everything saves automatically.</div>
          <div style={{marginBottom:4}}>📤 <strong>Weekly:</strong> Tap Export Data → save the file to iCloud / Google Drive.</div>
          <div style={{marginBottom:4}}>🔁 <strong>New device:</strong> Import your latest export file to restore everything.</div>
          <div>🚨 <strong>Before clearing browser:</strong> Always export first or your data is gone permanently.</div>
        </div>
      </Card>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS TAB
// ══════════════════════════════════════════════════════════════════════════════
const SettingsTab = ({onReplayTutorial}) => {
  const [cfg, setCfg] = useState(loadAI);
  const [testMsg, setTestMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const [showAnthKey, setShowAnthKey] = useState(false);
  const [showGemKey, setShowGemKey] = useState(false);

  const update = (field, val) => setCfg(p => ({...p, [field]:val}));
  const persist = () => { saveAI(cfg); setTestMsg("Saved!"); setTimeout(()=>setTestMsg(""),2500); };

  const testConn = async () => {
    setTesting(true); setTestMsg("");
    try {
      const r = await aiText("Reply with exactly the word: OK");
      setTestMsg(r.includes("OK") ? "Connected!" : "Connected but odd response: " + r.slice(0,60));
    } catch(e) { setTestMsg("Error: " + e.message); }
    setTesting(false);
  };

  const geminiModels = [
    {value:"gemini-3.1-flash-lite", label:"Gemini 3.1 Flash-Lite", desc:"Fast, cheap, great for food logging"},
    {value:"gemini-3.1-pro-preview", label:"Gemini 3.1 Pro", desc:"Most powerful, best reasoning"},
  ];

  const PCard = ({id, title, badge, children}) => (
    <div onClick={()=>update("provider",id)} style={{
      padding:16, borderRadius:12, cursor:"pointer", marginBottom:10,
      border:"2px solid "+(cfg.provider===id ? C.accent : C.border),
      background: cfg.provider===id ? C.accentD : C.surface, transition:"all 0.2s"
    }}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:cfg.provider===id?12:0}}>
        <div style={{width:18,height:18,borderRadius:"50%",border:"2px solid "+(cfg.provider===id?C.accent:C.muted),
          background:cfg.provider===id?C.accent:"transparent",flexShrink:0}}/>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:cfg.provider===id?C.accent:C.text}}>{title}</div>
          <Tag color={id==="anthropic"?C.accent:C.blue}>{badge}</Tag>
        </div>
      </div>
      {cfg.provider===id && children}
    </div>
  );

  const KField = ({label, field, show, toggle, ph}) => (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:11,color:C.muted,marginBottom:5,textTransform:"uppercase",letterSpacing:0.7}}>{label}</div>
      <div style={{display:"flex",gap:6}}>
        <input type={show?"text":"password"} value={cfg[field]} onChange={e=>update(field,e.target.value)} placeholder={ph}
          style={{flex:1,background:C.card,border:"1px solid "+C.border,borderRadius:9,padding:"9px 12px",color:C.text,fontSize:13,fontFamily:"inherit",outline:"none"}}/>
        <button onClick={e=>{e.stopPropagation();toggle();}} style={{background:C.card,border:"1px solid "+C.border,borderRadius:9,padding:"0 12px",color:C.muted,cursor:"pointer",fontSize:12}}>
          {show?"Hide":"Show"}
        </button>
      </div>
    </div>
  );

  return (
    <div>
      <Card style={{marginBottom:12}}>
        <div style={{fontSize:14,fontWeight:700,color:C.text,marginBottom:4}}>AI Provider</div>
        <div style={{fontSize:12,color:C.muted,marginBottom:14,lineHeight:1.5}}>
          Fitelations uses AI for food photo analysis, voice logging, and Cut Coach advice.
          Inside Claude.ai, Anthropic works with no key. Self-hosting requires your own key.
        </div>

        <PCard id="anthropic" title="Anthropic Claude" badge="Default">
          <KField label="API Key (optional inside Claude.ai)" field="anthropicKey"
            show={showAnthKey} toggle={()=>setShowAnthKey(p=>!p)} ph="sk-ant-... (blank = use Claude.ai passthrough)"/>
          <div style={{fontSize:11,color:C.muted}}>Model: <span style={{color:C.accent,fontWeight:600}}>claude-sonnet-4-20250514</span> · console.anthropic.com</div>
        </PCard>

        <PCard id="gemini" title="Google Gemini 3.1" badge="Flash-Lite or Pro">
          <KField label="Gemini API Key" field="geminiKey"
            show={showGemKey} toggle={()=>setShowGemKey(p=>!p)} ph="AIza... — aistudio.google.com"/>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:11,color:C.muted,marginBottom:6,textTransform:"uppercase",letterSpacing:0.7}}>Select Model</div>
            {geminiModels.map(m=>(
              <div key={m.value} onClick={e=>{e.stopPropagation();update("geminiModel",m.value);}} style={{
                display:"flex",gap:8,padding:"9px 10px",borderRadius:9,cursor:"pointer",marginBottom:6,
                border:"1px solid "+(cfg.geminiModel===m.value?C.blue:C.border),
                background:cfg.geminiModel===m.value?C.blueD:C.card
              }}>
                <div style={{width:14,height:14,borderRadius:"50%",flexShrink:0,marginTop:2,
                  border:"2px solid "+(cfg.geminiModel===m.value?C.blue:C.muted),
                  background:cfg.geminiModel===m.value?C.blue:"transparent"}}/>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:cfg.geminiModel===m.value?C.blue:C.text}}>{m.label}</div>
                  <div style={{fontSize:11,color:C.muted}}>{m.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{fontSize:11,color:C.muted}}>Free tier available · aistudio.google.com</div>
        </PCard>
      </Card>

      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <Btn onClick={persist} style={{flex:1}}>Save Settings</Btn>
        <Btn onClick={testConn} variant="ghost" disabled={testing} style={{flex:1}}>{testing?"Testing...":"Test Connection"}</Btn>
      </div>

      {testMsg&&(
        <div style={{padding:"10px 14px",borderRadius:10,marginBottom:12,fontSize:13,
          background:testMsg.startsWith("C")||testMsg.startsWith("S")?C.success+"22":C.red+"22",
          color:testMsg.startsWith("C")||testMsg.startsWith("S")?C.success:C.red}}>
          {testMsg.startsWith("C")||testMsg.startsWith("S")?"✅ ":"❌ "}{testMsg}
        </div>
      )}

      <Card style={{marginBottom:12}}>
        <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:6}}>📖 Tutorial</div>
        <div style={{fontSize:12,color:C.muted,marginBottom:12,lineHeight:1.5}}>New to Fitelations or want a refresher? Replay the full feature walkthrough.</div>
        <Btn onClick={()=>{ if(typeof onReplayTutorial==="function") onReplayTutorial(); }} variant="ghost" style={{width:"100%"}}>📖 Replay Tutorial</Btn>
      </Card>

      <Card>
        <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:10}}>Model Comparison</div>
        {[
          {l:"Claude Sonnet 4",t:"Anthropic default",n:"Best for food photo analysis & coaching. Strongest vision."},
          {l:"Gemini 3.1 Flash-Lite",t:"Fast + cheap",n:"Best price/performance. Excellent for voice logging & quick macros. Very low latency."},
          {l:"Gemini 3.1 Pro",t:"Most powerful",n:"Highest reasoning quality. Best Cut Coach analysis. Slightly slower."},
        ].map((r,i)=>(
          <div key={i} style={{padding:"10px 0",borderBottom:i<2?"1px solid "+C.border:undefined}}>
            <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
              <span style={{fontSize:12,fontWeight:700,color:C.text}}>{r.l}</span>
              <Tag color={C.muted}>{r.t}</Tag>
            </div>
            <div style={{fontSize:12,color:C.muted,lineHeight:1.5}}>{r.n}</div>
          </div>
        ))}
      </Card>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// SUB-NAV PILL BAR — used inside merged tabs
// ══════════════════════════════════════════════════════════════════════════════
const SubNav = ({tabs, active, onChange, accent=null}) => {
  const col = accent || C.accent;
  return (
    <div style={{display:"flex",gap:6,marginBottom:16,overflowX:"auto",paddingBottom:2}}>
      {tabs.map(t=>(
        <button key={t.id} onClick={()=>onChange(t.id)} style={{
          flexShrink:0, padding:"7px 14px", borderRadius:99, border:"none",
          fontWeight:700, fontSize:11, cursor:"pointer", fontFamily:"inherit",
          letterSpacing:0.4, textTransform:"uppercase", transition:"all 0.18s",
          background: active===t.id ? col : C.surface,
          color: active===t.id ? (col===C.accent?"#000":col==="white"?"#000":"#fff") : C.muted,
          boxShadow: active===t.id ? `0 0 12px ${col}44` : "none",
        }}>{t.icon} {t.label}</button>
      ))}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// MERGED TAB: COACH  (Dashboard + Check-In)
// ══════════════════════════════════════════════════════════════════════════════
const CoachMerged = (props) => {
  const [sub, setSub] = useState("coach");
  const subTabs = [{id:"coach",icon:"⚡",label:"Coach"},{id:"checkin",icon:"📋",label:"Check-In"}];
  return (
    <div>
      <SubNav tabs={subTabs} active={sub} onChange={setSub}/>
      {sub==="coach"   && <DashTab {...props}/>}
      {sub==="checkin" && <CheckinTab checkins={props.checkins} setCheckins={props.setCheckins} profile={props.profile}/>}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// MERGED TAB: TRAIN  (Workout + Walk)
// ══════════════════════════════════════════════════════════════════════════════
const TrainMerged = (props) => {
  const [sub, setSub] = useState("lift");
  const subTabs = [{id:"lift",icon:"🏋️",label:"Lift"},{id:"walk",icon:"🗺",label:"Walk"}];
  return (
    <div>
      <SubNav tabs={subTabs} active={sub} onChange={setSub}/>
      {sub==="lift" && <WorkoutTab workouts={props.workouts} setWorkouts={props.setWorkouts} prs={props.prs} setPrs={props.setPrs} checkins={props.checkins} discipline={props.discipline}/>}
      {sub==="walk" && <WalkTab walks={props.walks} setWalks={props.setWalks} discipline={props.discipline}/>}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// MERGED TAB: BODY  (Health profile + Recovery + Hydration)
// ══════════════════════════════════════════════════════════════════════════════
const BodyMerged = (props) => {
  const [sub, setSub] = useState("health");
  const subTabs = [{id:"health",icon:"📊",label:"Health"},{id:"recovery",icon:"💧",label:"Recovery"}];
  return (
    <div>
      <SubNav tabs={subTabs} active={sub} onChange={setSub}/>
      {sub==="health"   && <HealthTab profile={props.profile} setProfile={props.setProfile}/>}
      {sub==="recovery" && <RecoveryTab profile={props.profile} hydration={props.hydration} setHydration={props.setHydration} recovery={props.recovery} setRecovery={props.setRecovery} workouts={props.workouts} discipline={props.discipline}/>}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// MERGED TAB: SETTINGS  (AI Settings + Data export/import)
// ══════════════════════════════════════════════════════════════════════════════
const SettingsMerged = (props) => {
  const [sub, setSub] = useState("ai");
  const subTabs = [{id:"ai",icon:"⚙️",label:"AI"},{id:"data",icon:"💾",label:"Data"}];
  return (
    <div>
      <SubNav tabs={subTabs} active={sub} onChange={setSub}/>
      {sub==="ai"   && <SettingsTab onReplayTutorial={props.onReplayTutorial}/>}
      {sub==="data" && <DataTab {...props}/>}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
// ROOT APP
// ══════════════════════════════════════════════════════════════════════════════
// TUTORIAL SYSTEM
// ══════════════════════════════════════════════════════════════════════════════
const TUTORIAL_KEY = "fitel_tutorial_done";
const TUTORIAL_STEPS = [
  {id:"welcome",tab:null,icon:"💪",title:"Welcome to Fitelations",body:"Your all-in-one AI-powered fat loss coach. This tutorial walks you through every feature so you hit the ground running. Takes about 3 minutes.",tip:null},
  {id:"profile",tab:"body",icon:"📊",title:"Step 1 — Set Up Your Profile",body:"Tap Body → Health → Edit and enter your age, height, weight, sex, and activity level. Fitelations uses this to calculate your TDEE, personalized water goal, BMI, and calorie targets.",tip:"💡 Your water goal is 0.5 oz × your bodyweight in pounds. At 328 lb that's ~164 oz/day."},
  {id:"food_photo",tab:"food",icon:"📷",title:"Step 2 — Log Food by Photo",body:"Tap Food → Camera or Upload. Take a photo of your meal. The AI instantly returns calories, protein, carbs, fat, and fiber. Every value is editable before you log — if the AI is off, just correct it.",tip:"💡 Tap Log & Save to store the meal in your quick-access library for future one-tap logging."},
  {id:"food_voice",tab:"food",icon:"🎙",title:"Step 3 — Log Food by Voice",body:'Forgot to take a photo? Tap Voice Log and describe your meal: "Two scrambled eggs, a cup of oatmeal with a tablespoon of peanut butter, and a glass of OJ." The AI parses every item and gives a full macro + micronutrient breakdown.',tip:"💡 Edit the transcript before analyzing if it mishears something."},
  {id:"food_saved",tab:"food",icon:"⭐",title:"Step 4 — Saved Meals",body:'Any meal logged with "Log & Save" appears in your Saved Meals library. Next time you eat the same thing, tap ⭐ and log it in one tap. No re-scanning, no re-typing.',tip:"💡 Build your library over the first week — by day 7 most daily meals will be one tap."},
  {id:"train_lift",tab:"train",icon:"🏋️",title:"Step 5 — Log Your Lifts",body:"Train tab → + Log to record a session. Enter exercise, weight, reps, and sets. PRs are tracked automatically — every time you hit a new personal best, it's flagged with a 🏆 and saved to your PR board.",tip:"💡 Workout calories are calculated using MET values and subtracted from your net calorie total automatically."},
  {id:"train_voice",tab:"train",icon:"🎙",title:"Step 6 — Voice Workout Logging",body:'Tap 🎙 Voice in the Train tab and describe your session: "3 sets of 10 reps of 40 pound kettlebell rows, 3 sets of 10 goblet squats at 40 pounds." Every exercise is parsed into a structured, editable log.',tip:"💡 Works great post-workout when your hands are sweaty or you're still catching your breath."},
  {id:"train_walk",tab:"train",icon:"🗺",title:"Step 7 — GPS Walk Tracker",body:"Train → Walk → Start. Your route is drawn live on a map as you move. Distance, time, and estimated steps are shown in real time. Routes are saved to history with full map replay.",tip:"💡 Keep the screen on while walking. GPS requires HTTPS — works perfectly on your Vercel deployment."},
  {id:"coach",tab:"coach",icon:"⚡",title:"Step 8 — The Cut Coach",body:"The Coach tab shows net calories (eaten minus workout burn), protein, and hydration at a glance. Tap Analyze for AI advice based on your real trends — weight, 7-day averages, sleep, fatigue, and more.",tip:"💡 If you're over your calorie goal, the Coach gives a specific Recovery Plan — e.g. walk 40 min or skip the evening snack."},
  {id:"checkin",tab:"coach",icon:"📋",title:"Step 9 — Weekly Check-Ins",body:"Coach → Check-In. Log weight, waist, sleep, hunger, and training performance once a week. This is how the app tracks whether your cut is on pace, too fast, or stalling — and how the Coach improves over time.",tip:"💡 Log your first check-in today with your current weight. It becomes the baseline for everything."},
  {id:"recovery",tab:"body",icon:"💧",title:"Step 10 — Hydration & Recovery",body:"Body → Recovery. Log water with quick-add buttons (8oz, 16oz, 32oz). Track sleep quality, soreness, stress level, and environment. High fatigue or severe soreness triggers automatic advice to back off or deload.",tip:"💡 Water goal auto-increases by 16oz on workout days. Hot/humid environment adds another prompt."},
  {id:"discipline",tab:"coach",icon:"🔴",title:"Step 11 — Discipline Mode",body:"Toggle Discipline Mode in the header for zero-tolerance accountability. The app turns red. Alerts fire for: going over net calories, missing protein, skipping walks, and being underhydrated. No excuses.",tip:"💡 Best for hard 4–6 week cut blocks. Turn off on planned rest or refeed days."},
  {id:"settings",tab:"more",icon:"⚙️",title:"Step 12 — API & Data Settings",body:"Settings → AI: choose Anthropic Claude (works free inside Claude.ai) or Gemini 3.1 Flash-Lite / Pro (free key at aistudio.google.com). Settings → Data: export everything as JSON to back up or move to another device.",tip:"💡 Tap Test Connection after entering your key to confirm it's working before you start logging."},
  {id:"netcal",tab:"coach",icon:"🧮",title:"How Net Calories Work",body:"Fitelations tracks NET calories: eaten minus workout burn. Eat 2,800 kcal, burn 400 lifting → net is 2,400. Your goal is compared against net. Working out gives you more room to eat without blowing your deficit.",tip:"💡 Burn estimates use MET values: lifting ≈ 5, cardio ≈ 7, outdoor work ≈ 4, sport ≈ 6."},
  {id:"done",tab:null,icon:"🎉",title:"You're Ready.",body:"That covers everything. Start by setting your profile in Body → Health, log your first meal, then hit your first check-in. The app gets smarter the more you use it. Let's get to work.",tip:null},
];

const TutorialOverlay = ({onFinish, onSkip, goToTab}) => {
  const [step, setStep] = useState(0);
  const cur = TUTORIAL_STEPS[step];
  const total = TUTORIAL_STEPS.length;
  const isLast = step === total - 1;
  const pct = Math.round((step / (total - 1)) * 100);

  const go = (delta) => {
    const next = step + delta;
    if (next < 0 || next >= total) return;
    if (TUTORIAL_STEPS[next].tab) goToTab(TUTORIAL_STEPS[next].tab);
    setStep(next);
  };

  useEffect(() => { if (cur.tab) goToTab(cur.tab); }, []);

  return (
    <div style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(7,9,13,0.88)",backdropFilter:"blur(6px)",display:"flex",alignItems:"flex-end",justifyContent:"center",padding:"0 0 calc(env(safe-area-inset-bottom) + 82px)"}}>
      <div style={{width:"100%",maxWidth:480,background:C.card,border:"1px solid "+C.border,borderRadius:"20px 20px 0 0",padding:"22px 18px 18px",maxHeight:"68vh",overflowY:"auto",boxShadow:"0 -8px 40px rgba(0,0,0,0.7)"}}>
        {/* Progress */}
        <div style={{height:3,background:C.border,borderRadius:99,marginBottom:18,overflow:"hidden"}}>
          <div style={{width:pct+"%",height:"100%",background:C.accent,borderRadius:99,transition:"width 0.4s cubic-bezier(.4,0,.2,1)"}}/>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <Tag color={C.accent}>{step+1} / {total}</Tag>
          <button onClick={onSkip} style={{background:"none",border:"1px solid "+C.border,borderRadius:8,color:C.muted,fontSize:11,padding:"4px 12px",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>Exit Tutorial</button>
        </div>
        {/* Icon + title */}
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
          <div style={{width:50,height:50,borderRadius:14,background:C.accentD,border:"1px solid "+C.accentM,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>{cur.icon}</div>
          <div style={{fontSize:16,fontWeight:800,color:C.text,lineHeight:1.3}}>{cur.title}</div>
        </div>
        {/* Body */}
        <div style={{fontSize:13,color:C.text,lineHeight:1.7,marginBottom:cur.tip?12:18}}>{cur.body}</div>
        {/* Tip */}
        {cur.tip&&<div style={{fontSize:12,color:C.text,lineHeight:1.6,padding:"9px 13px",background:C.blueD,border:"1px solid "+C.blue+"44",borderRadius:10,marginBottom:18}}>{cur.tip}</div>}
        {/* Nav buttons */}
        <div style={{display:"flex",gap:8}}>
          {step>0&&<Btn onClick={()=>go(-1)} variant="ghost" style={{flex:1}}>← Back</Btn>}
          {isLast
            ?<Btn onClick={onFinish} style={{flex:2,padding:"13px"}}>🚀 Let's Go!</Btn>
            :<Btn onClick={()=>go(1)} style={{flex:step===0?2:1,padding:"13px"}}>{step===0?"Start Tutorial →":"Next →"}</Btn>
          }
        </div>
        {cur.tab&&<div style={{textAlign:"center",marginTop:10,fontSize:10,color:C.muted}}>👆 App behind shows the relevant section</div>}
      </div>
    </div>
  );
};

const WelcomeScreen = ({onTutorial, onSkip}) => (
  <div style={{position:"fixed",inset:0,zIndex:9998,background:C.bg,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>
    <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,700;9..40,900&family=Space+Mono:wght@700&display=swap" rel="stylesheet"/>
    <GlobalStyle/>
    <div style={{width:86,height:86,borderRadius:24,background:C.accentD,border:"2px solid "+C.accentM,display:"flex",alignItems:"center",justifyContent:"center",fontSize:42,marginBottom:22,boxShadow:"0 0 40px "+C.accent+"33"}}>💪</div>
    <div style={{fontSize:30,fontWeight:900,color:C.accent,fontFamily:"'Space Mono',monospace",letterSpacing:-1,marginBottom:4}}>FITELATIONS</div>
    <div style={{fontSize:12,color:C.muted,marginBottom:6,letterSpacing:0.5}}>Fit · Revelation · Results</div>
    <div style={{fontSize:13,color:C.text,textAlign:"center",lineHeight:1.7,maxWidth:300,marginBottom:32}}>Your AI-powered aggressive fat loss and fitness coach. Track food, workouts, walks, hydration, and recovery — all in one place.</div>
    <div style={{display:"flex",flexWrap:"wrap",gap:7,justifyContent:"center",marginBottom:36}}>
      {["📷 AI Food Photo","🎙 Voice Logging","🏆 PR Tracking","💧 Hydration","🗺 GPS Walks","⚡ Cut Coach","🔴 Discipline Mode","💾 Export Data"].map(f=>(
        <span key={f} style={{background:C.surface,border:"1px solid "+C.border,borderRadius:99,padding:"4px 11px",fontSize:11,color:C.muted,fontWeight:600}}>{f}</span>
      ))}
    </div>
    <div style={{width:"100%",maxWidth:320,display:"flex",flexDirection:"column",gap:10}}>
      <Btn onClick={onTutorial} style={{width:"100%",padding:"14px",fontSize:14}}>📖 Show Me How It Works</Btn>
      <Btn onClick={onSkip} variant="ghost" style={{width:"100%",padding:"12px"}}>Skip — Take Me to the App</Btn>
    </div>
    <div style={{marginTop:16,fontSize:10,color:C.muted,textAlign:"center"}}>Tutorial takes ~3 min · Replay anytime in Settings</div>
  </div>
);

// ══════════════════════════════════════════════════════════════════════════════
// ROOT APP
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [tab,setTab]=useState("coach");
  const [profile,setProfile]=useState(()=>load(KEYS.profile,{}));
  const [foodLog,setFoodLog]=useState(()=>load(KEYS.foodLog,[]));
  const [workouts,setWorkouts]=useState(()=>load(KEYS.workouts,[]));
  const [walks,setWalks]=useState(()=>load(KEYS.walks,[]));
  const [checkins,setCheckins]=useState(()=>load(KEYS.checkins,[]));
  const [savedMeals,setSavedMeals]=useState(()=>load(KEYS.savedMeals,[]));
  const [hydration,setHydration]=useState(()=>load(KEYS.hydration,{}));
  const [recovery,setRecovery]=useState(()=>load(KEYS.recovery,{}));
  const [prs,setPrs]=useState(()=>load(KEYS.prs,{}));
  const [discipline,setDiscipline]=useState(()=>load(KEYS.discipline,false));

  const [appState,setAppState]=useState(()=>localStorage.getItem(TUTORIAL_KEY)?"app":"welcome");

  const finishTutorial=()=>{ localStorage.setItem(TUTORIAL_KEY,"1"); setAppState("app"); setTab("body"); };
  const skipTutorial=()=>{ localStorage.setItem(TUTORIAL_KEY,"1"); setAppState("app"); };
  const replayTutorial=()=>setAppState("tutorial");

  const toggleDiscipline=()=>{ const v=!discipline; setDiscipline(v); save(KEYS.discipline,v); };

  const handleImport=(d)=>{
    const merge=(curr,incoming,keyFn)=>[...incoming,...curr.filter(e=>!incoming.some(i=>keyFn(i)===keyFn(e)))];
    if(d.profile){setProfile(d.profile);save(KEYS.profile,d.profile);}
    if(d.foodLog){const m=merge(foodLog,d.foodLog,e=>e.id);setFoodLog(m);save(KEYS.foodLog,m);}
    if(d.workouts){const m=merge(workouts,d.workouts,e=>e.id);setWorkouts(m);save(KEYS.workouts,m);}
    if(d.walks){const m=merge(walks,d.walks,e=>e.id);setWalks(m);save(KEYS.walks,m);}
    if(d.checkins){const m=[...d.checkins,...checkins.filter(e=>!d.checkins.some(i=>i.date===e.date))].sort((a,b)=>a.date>b.date?1:-1);setCheckins(m);save(KEYS.checkins,m);}
    if(d.savedMeals){const m=merge(savedMeals,d.savedMeals,e=>e.id);setSavedMeals(m);save(KEYS.savedMeals,m);}
    if(d.hydration){const m={...hydration,...d.hydration};setHydration(m);save(KEYS.hydration,m);}
    if(d.recovery){const m={...recovery,...d.recovery};setRecovery(m);save(KEYS.recovery,m);}
    if(d.prs){const m={...prs,...d.prs};setPrs(m);save(KEYS.prs,m);}
  };

  const goal=profile.calorieGoal||calcTDEE(profile)||2200;
  const todayCal=foodLog.filter(e=>e.date===today()).reduce((a,e)=>a+(+e.calories||0),0);
  const todayBurned=calcDayBurn(workouts,today(),profile.weight);
  const todayNet=Math.max(0,todayCal-todayBurned);
  const calPct=Math.min(120,Math.round((todayNet/goal)*100));
  const waterGoal=calcWaterGoalOz(profile,workouts.some(w=>w.date===today()));
  const todayWater=hydration[today()]||0;
  const waterPct=Math.min(100,Math.round((todayWater/waterGoal)*100));

  const tabs=[
    {id:"coach",icon:"⚡",label:"Coach"},
    {id:"food",icon:"🍽",label:"Food"},
    {id:"train",icon:"💪",label:"Train"},
    {id:"body",icon:"📊",label:"Body"},
    {id:"more",icon:"⚙️",label:"Settings"},
  ];

  const sharedProps={
    profile,setProfile,foodLog,setFoodLog,workouts,setWorkouts,
    walks,setWalks,checkins,setCheckins,savedMeals,setSavedMeals,
    hydration,setHydration,recovery,setRecovery,prs,setPrs,
    discipline,onImport:handleImport,onReplayTutorial:replayTutorial
  };

  return (
    <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:"'DM Sans','Segoe UI',sans-serif",maxWidth:480,margin:"0 auto",paddingBottom:80}}>
      <GlobalStyle/>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,600;9..40,700;9..40,800;9..40,900&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet"/>

      {appState==="welcome"&&<WelcomeScreen onTutorial={()=>setAppState("tutorial")} onSkip={skipTutorial}/>}
      {appState==="tutorial"&&<TutorialOverlay onFinish={finishTutorial} onSkip={skipTutorial} goToTab={setTab}/>}

      {/* Header */}
      <div style={{padding:"14px 16px 12px",position:"sticky",top:0,zIndex:100,background:`${C.bg}f0`,backdropFilter:"blur(20px)",borderBottom:"1px solid "+C.border}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div>
            <div style={{fontSize:20,fontWeight:900,color:discipline?C.red:C.accent,fontFamily:"'Space Mono',monospace",letterSpacing:-0.5,transition:"color 0.3s"}}>FITELATIONS{discipline?" 🔴":""}</div>
            <div style={{fontSize:9,color:C.muted,letterSpacing:1.5}}>{new Date().toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"}).toUpperCase()}</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:12,fontWeight:700,color:calPct>100?C.red:C.text}}>{fmt(todayNet)}/{fmt(goal)} kcal net</div>
            <div style={{display:"flex",gap:4,marginTop:4,justifyContent:"flex-end"}}>
              <div style={{width:70,height:4,background:C.border,borderRadius:99,overflow:"hidden"}}>
                <div style={{width:`${Math.min(100,calPct)}%`,height:"100%",background:calPct>100?C.red:C.accent,borderRadius:99,transition:"width 0.4s"}}/>
              </div>
              <div style={{width:40,height:4,background:C.border,borderRadius:99,overflow:"hidden"}}>
                <div style={{width:`${waterPct}%`,height:"100%",background:C.blue,borderRadius:99,transition:"width 0.4s"}}/>
              </div>
            </div>
            <div style={{fontSize:8,color:C.muted,marginTop:2}}>cal · water</div>
          </div>
        </div>
        <DisciplineBanner active={discipline} onToggle={toggleDiscipline}/>
      </div>

      {/* Content */}
      <div style={{padding:"12px 12px 0"}}>
        {tab==="coach"&&<CoachMerged {...sharedProps}/>}
        {tab==="food"&&<FoodTab profile={profile} foodLog={foodLog} setFoodLog={setFoodLog} savedMeals={savedMeals} setSavedMeals={setSavedMeals} discipline={discipline}/>}
        {tab==="train"&&<TrainMerged {...sharedProps}/>}
        {tab==="body"&&<BodyMerged {...sharedProps}/>}
        {tab==="more"&&<SettingsMerged profile={profile} foodLog={foodLog} workouts={workouts} walks={walks} checkins={checkins} savedMeals={savedMeals} hydration={hydration} recovery={recovery} prs={prs} onImport={handleImport} onReplayTutorial={replayTutorial}/>}
      </div>

      {/* Bottom Nav */}
      <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:480,background:`${C.surface}f8`,backdropFilter:"blur(20px)",borderTop:"1px solid "+C.border,display:"flex",padding:"6px 0 calc(6px + env(safe-area-inset-bottom))"}}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{flex:1,background:"none",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:2,padding:"4px 0",transition:"all 0.2s",minWidth:0}}>
            <span style={{fontSize:18,filter:tab===t.id?"none":"grayscale(1) opacity(0.35)"}}>{t.icon}</span>
            <span style={{fontSize:9,fontWeight:700,color:tab===t.id?discipline?C.red:C.accent:C.muted,letterSpacing:0.4,textTransform:"uppercase",whiteSpace:"nowrap"}}>{t.label}</span>
            {tab===t.id&&<div style={{width:16,height:2,background:discipline?C.red:C.accent,borderRadius:99}}/>}
          </button>
        ))}
      </div>
    </div>
  );
}
