/** auto-batch.js (multi-batch, strict-prep, kill-on-drift, auto-tuned utilization)
 * - Reserves 10 GB on home
 * - Auto-tunes hack % and concurrent batch count each cycle to target ~95% RAM use
 * - Multi-batch with safe cadence: H→W1→G→W2; next batch's H never finishes before previous W2
 * - Grow sized from estimated hacked amount (+2% overprovision), weakens rounded up
 * - If end-of-set is not PREPPED, kills all pending/running H/G/W for target, corrects, and reschedules fresh
 */

////////////////////
// Tuning knobs  //
////////////////////
const HOME_RAM_RESERVE_GB   = 10;

const SCHED_BUFFER_MS       = 300;   // spacing between finishes inside a batch
const CADENCE_MULTIPLIER    = 4;     // cadence = 4*buffer so H(i+1) finishes after W2(i)
const SLACK                 = 1.05;  // +5% thread slack to absorb rounding
const GROW_OVERPROVISION    = 1.02;  // +2% extra grow threads to avoid underfill
const PREP_SEC_TOLERANCE    = 0.001;
const PREP_MONEY_TOLERANCE  = 0.999; // strict for prep & end-of-set

// Auto-tuner targets
const TARGET_UTILIZATION    = 0.95;  // aim to use ~95% of free RAM
const UTIL_HEADROOM         = 0.98;  // internal safety when checking “fits”
const PCT_MIN               = 0.002; // 0.2% lower bound on hack fraction
const PCT_MAX               = 0.20;  // 20% upper bound 
const MAX_BATCHES_CAP       = 9999999;     

const WORKERS = ["remote-hack.js", "remote-grow.js", "remote-weaken.js"];

////////////////////
// Utils/helpers  //
////////////////////
function formatMs(ms){ return (ms/1000).toFixed(3)+"s"; }
function getOwnedHosts(ns){ return ["home"].concat(ns.getPurchasedServers()); }
function sum(obj){ return Object.values(obj).reduce((a,b)=>a+b,0); }

function gatherAllServers(ns, start){
  const q=[start], seen=new Set([start]), out=[];
  while(q.length){
    const s=q.shift(); out.push(s);
    for(const n of ns.scan(s)){ if(!seen.has(n)){ seen.add(n); q.push(n); } }
  }
  return out;
}

async function scpToAll(ns, files, hosts){
  for(const h of hosts){
    for(const f of files){
      if(!ns.fileExists(f,h)){
        try { await ns.scp(f,h); } catch(_) {}
      }
    }
  }
}

function availableRamByHost(ns, hosts){
  const map={};
  for(const h of hosts){
    const max=ns.getServerMaxRam(h), used=ns.getServerUsedRam(h);
    let avail=Math.max(0, max-used);
    if(h==="home") avail=Math.max(0, avail - HOME_RAM_RESERVE_GB);
    map[h]=avail;
  }
  return map;
}

async function allocateAndRun(ns, hosts, script, target, threads, startDelayMs=0){
  let remaining = threads;
  const ramPerThread = ns.getScriptRam(script,"home");
  for(const h of hosts){
    if(remaining<=0) break;
    const max=ns.getServerMaxRam(h), used=ns.getServerUsedRam(h);
    let avail=Math.max(0, max-used);
    if(h==="home") avail=Math.max(0, avail - HOME_RAM_RESERVE_GB);
    const canThreads = Math.floor(avail / ramPerThread);
    if(canThreads<=0) continue;
    const take = Math.min(canThreads, remaining);
    try{ if(!ns.fileExists(script,h)) await ns.scp(script,h); }catch(_){}
    const pid = ns.exec(script, h, take, target, startDelayMs);
    if(pid!==0) remaining -= take;
    await ns.sleep(5);
  }
  if(remaining>0){
    ns.tprint(`Warning: could not allocate ${remaining}/${threads} threads for ${script}.`);
  }
  return (threads!==remaining);
}

function computeBatchPlan(ns, target, hackPct, moneyNow, maxMoney){
  const SL = SLACK;

  // Hack threads aiming for hackPct*max
  const desiredSteal = Math.max(1, Math.floor(hackPct * maxMoney));
  let hackThreads=1;
  try {
    if (ns.hackAnalyzeThreads) hackThreads = Math.max(1, Math.ceil(ns.hackAnalyzeThreads(target, desiredSteal)));
    else hackThreads = Math.max(1, Math.ceil(hackPct / Math.max(1e-9, ns.hackAnalyze(target))));
  } catch(_) {
    hackThreads = Math.max(1, Math.ceil(hackPct / Math.max(1e-9, ns.hackAnalyze(target))));
  }
  hackThreads = Math.ceil(hackThreads * SL);

  // Estimated hacked amount (assume success; worst-case for grow)
  const perThreadFrac = Math.max(0, ns.hackAnalyze(target));
  const hackedFrac    = Math.min(0.99, perThreadFrac * hackThreads);
  const hackedAmount  = Math.floor(moneyNow * hackedFrac);

  // Weaken for hack
  let hackSec=0;
  try { hackSec = ns.hackAnalyzeSecurity ? ns.hackAnalyzeSecurity(hackThreads) : 0.002 * hackThreads; }
  catch(_) { hackSec = 0.002 * hackThreads; }
  const weakenForHack = Math.ceil(hackSec / 0.05);

  // Grow to max (slightly overprovisioned)
  const afterHackMoney = Math.max(1, moneyNow - hackedAmount);
  let growThreads = 0;
  if (afterHackMoney < maxMoney * PREP_MONEY_TOLERANCE) {
    const mult = maxMoney / afterHackMoney;
    try { growThreads = Math.ceil(ns.growthAnalyze(target, mult) * GROW_OVERPROVISION); }
    catch(_) { growThreads = Math.ceil(Math.log(mult) * 10 * GROW_OVERPROVISION); }
  }
  growThreads = Math.ceil(growThreads * SL);

  // Weaken for grow
  let growSec=0;
  try { growSec = ns.growthAnalyzeSecurity ? ns.growthAnalyzeSecurity(growThreads) : 0.004 * growThreads; }
  catch(_) { growSec = 0.004 * growThreads; }
  const weakenForGrow = Math.ceil(growSec / 0.05);

  return { hackThreads, weakenForHack, growThreads, weakenForGrow };
}

function ramForPlan(ns, plan){
  const ramHack   = ns.getScriptRam("remote-hack.js","home");
  const ramGrow   = ns.getScriptRam("remote-grow.js","home");
  const ramWeaken = ns.getScriptRam("remote-weaken.js","home");
  return plan.hackThreads*ramHack + plan.growThreads*ramGrow + (plan.weakenForHack+plan.weakenForGrow)*ramWeaken;
}

/** Kill any queued/running hack/grow/weaken for this target across all owned hosts. */
async function killAllTargetJobs(ns, hosts, target){
  const scripts = new Set(["remote-hack.js","remote-grow.js","remote-weaken.js"]);
  let killed = 0;
  for (const h of hosts){
    try{
      const procs = ns.ps(h);
      for (const p of procs){
        if (scripts.has(p.filename) && p.args && p.args[0] === target){
          if (ns.kill(p.pid)) killed++;
        }
      }
    }catch(_){}
    await ns.sleep(1);
  }
  if (killed > 0) ns.tprint(`Killed ${killed} pending/running jobs for ${target}.`);
  return killed;
}

/** Auto-tune hackPct & batch count to hit TARGET_UTILIZATION of current RAM. */
function autotuneBatches(ns, target, availRam){
  let lo = PCT_MIN, hi = PCT_MAX;
  let best = null;

  for (let iter = 0; iter < 18; iter++) {
    const mid = (lo + hi) / 2;
    const moneyNow = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);

    let plan = computeBatchPlan(ns, target, mid, moneyNow, maxMoney);
    let perBatch = ramForPlan(ns, plan);
    if (perBatch <= 0 || !isFinite(perBatch)) {
      lo = Math.max(mid, lo + 1e-6);
      continue;
    }

    let batches = Math.max(1, Math.floor((availRam * TARGET_UTILIZATION) / perBatch));
    batches = Math.min(batches, MAX_BATCHES_CAP);

    if (perBatch > availRam * UTIL_HEADROOM) {
      hi = mid; // pct too big
      continue;
    }

    const used = batches * perBatch;
    const util = used / Math.max(1, availRam);

    if (!best || util > best.util) {
      best = { pct: mid, plan, perBatch, batches, util };
    }

    if (util > TARGET_UTILIZATION) hi = mid; else lo = mid;
  }

  if (!best) {
    const pct = Math.max(PCT_MIN, Math.min(PCT_MAX, 0.04)); // fallback center
    const moneyNow = ns.getServerMoneyAvailable(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const plan = computeBatchPlan(ns, target, pct, moneyNow, maxMoney);
    const perBatch = ramForPlan(ns, plan);
    let batches = Math.max(1, Math.floor((availRam * TARGET_UTILIZATION) / Math.max(1e-9, perBatch)));
    batches = Math.min(batches, MAX_BATCHES_CAP);
    return { pct, plan, perBatch, batches, util: (batches*perBatch)/Math.max(1,availRam) };
  }

  return best;
}

////////////////////
// Main loop     //
////////////////////
export async function main(ns){
  ns.disableLog("sleep");
  ns.disableLog("getServerUsedRam");
  ns.disableLog("scp");
  ns.disableLog("exec");

  for(const w of WORKERS){
    if(!ns.fileExists(w,"home")){
      ns.tprint(`ERROR: missing ${w} on home.`); return;
    }
  }

  ns.tprint(`auto-batch: starting. Reserving ${HOME_RAM_RESERVE_GB} GB on home.`);

  while(true){
    // --- choose best target ---
    const servers = gatherAllServers(ns,"home");
    const me = ns.getHackingLevel();
    const candidates=[];
    for(const s of servers){
      try{
        if(!ns.hasRootAccess(s)) continue;
        if(ns.getServerRequiredHackingLevel(s) > me) continue;
        const maxMoney = ns.getServerMaxMoney(s);
        if(!maxMoney || maxMoney < 1e5) continue;
        const T = ns.getHackTime(s);
        let perThreadFrac=0;
        try{ perThreadFrac = ns.hackAnalyze(s); }catch(_){ perThreadFrac=0.002; }
        const score = (perThreadFrac * maxMoney) / Math.max(1, T);
        candidates.push({s, score});
      }catch(_){}
    }
    if(candidates.length===0){
      ns.tprint("auto-batch: no hackable servers with money. Exiting.");
      return;
    }
    candidates.sort((a,b)=>b.score-a.score);
    const target = candidates[0].s;
    ns.tprint(`auto-batch: chosen target ${target} (score ${candidates[0].score.toFixed(2)})`);

    // --- strict PREP ---
    let loop=0;
    while(true){
      loop++;
      const sec   = ns.getServerSecurityLevel(target);
      const min   = ns.getServerMinSecurityLevel(target);
      const money = ns.getServerMoneyAvailable(target);
      const maxM  = ns.getServerMaxMoney(target);
      ns.tprint(`Prep #${loop}: sec=${sec.toFixed(3)} (min=${min.toFixed(3)}) money=${Math.floor(money)}/${Math.floor(maxM)}`);

      const secOk   = (sec <= min + PREP_SEC_TOLERANCE);
      const moneyOk = (money >= maxM * PREP_MONEY_TOLERANCE);
      if(secOk && moneyOk){ ns.tprint("Target prepped."); break; }

      await scpToAll(ns, WORKERS, getOwnedHosts(ns));

      if(!secOk){
        const need = Math.ceil((sec - min) / 0.05);
        ns.tprint(`Prep: weaken → min (threads=${need})`);
        await allocateAndRun(ns, getOwnedHosts(ns), "remote-weaken.js", target, need);
        await ns.sleep(ns.getWeakenTime(target) + 200);
      }

      if(!moneyOk){
        // RAM-aware grow wave + matched weaken
        const hosts = getOwnedHosts(ns);
        const ramGrow = ns.getScriptRam("remote-grow.js","home");
        let growCap=0;
        for(const h of hosts){
          const max=ns.getServerMaxRam(h), used=ns.getServerUsedRam(h);
          let avail=Math.max(0, max-used);
          if(h==="home") avail=Math.max(0, avail - HOME_RAM_RESERVE_GB);
          growCap += Math.floor(avail / ramGrow);
        }
        let desired=0;
        try { desired = Math.ceil(ns.growthAnalyze(target, maxM / Math.max(1, ns.getServerMoneyAvailable(target)))); }
        catch(_){ desired = 1000; }
        const growNow = Math.max(1, Math.min(desired, growCap));
        ns.tprint(`Prep: grow wave (threads=${growNow}, cap=${growCap}, desired=${desired})`);
        await allocateAndRun(ns, hosts, "remote-grow.js", target, growNow);
        await ns.sleep(ns.getGrowTime(target) + 200);

        let gSec=0;
        try { gSec = ns.growthAnalyzeSecurity ? ns.growthAnalyzeSecurity(growNow) : 0.004*growNow; }
        catch(_){ gSec = 0.004*growNow; }
        const wNeed = Math.ceil(gSec/0.05);
        if(wNeed>0){
          ns.tprint(`Prep: post-grow weaken (threads=${wNeed})`);
          await allocateAndRun(ns, hosts, "remote-weaken.js", target, wNeed);
          await ns.sleep(ns.getWeakenTime(target) + 200);
        }
      }
      await ns.sleep(100);
    }

    // --- MULTI-BATCH plan (auto-tuned) ---
    await scpToAll(ns, WORKERS, getOwnedHosts(ns));

    const hosts = getOwnedHosts(ns);
    const avail = sum(availableRamByHost(ns, hosts));

    // Auto-tune hackPct & batch count for current RAM
    let tuned = autotuneBatches(ns, target, avail);

    // Ensure at least one batch fits under UTIL_HEADROOM
    if (tuned.perBatch > avail * UTIL_HEADROOM) {
      ns.tprint("auto-batch: cannot fit even a tiny single batch. Exiting.");
      return;
    }

    ns.tprint(`Plan: hackPct=${(tuned.pct*100).toFixed(2)}%, per-batch RAM≈${tuned.perBatch.toFixed(2)} GB, launching ${tuned.batches} batch(es) (~${(tuned.util*100).toFixed(1)}% util).`);

    // Timing base
    const now = Date.now();
    const Th = ns.getHackTime(target);
    const Tg = ns.getGrowTime(target);
    const Tw = ns.getWeakenTime(target);

    const baseMargin  = 2000;
    const baseFinish0 = now + baseMargin + Math.max(Th, Tg, Tw);
    const CADENCE     = CADENCE_MULTIPLIER * SCHED_BUFFER_MS;

    // Build all jobs
    const jobs = [];
    for (let i=0; i<tuned.batches; i++){
      const baseFinish = baseFinish0 + i*CADENCE;

      const finishH  = baseFinish - 3*SCHED_BUFFER_MS;
      const finishW1 = baseFinish - 2*SCHED_BUFFER_MS;
      const finishG  = baseFinish - 1*SCHED_BUFFER_MS;
      const finishW2 = baseFinish;

      const startH  = Math.max(0, finishH  - Th);
      const startW1 = Math.max(0, finishW1 - Tw);
      const startG  = Math.max(0, finishG  - Tg);
      const startW2 = Math.max(0, finishW2 - Tw);

      const delayH  = Math.max(0, startH  - now);
      const delayW1 = Math.max(0, startW1 - now);
      const delayG  = Math.max(0, startG  - now);
      const delayW2 = Math.max(0, startW2 - now);

      jobs.push({script:"remote-hack.js",   threads:tuned.plan.hackThreads,    delay:delayH});
      jobs.push({script:"remote-weaken.js", threads:tuned.plan.weakenForHack,  delay:delayW1});
      jobs.push({script:"remote-grow.js",   threads:tuned.plan.growThreads,    delay:delayG});
      jobs.push({script:"remote-weaken.js", threads:tuned.plan.weakenForGrow,  delay:delayW2});
    }

    // Final RAM re-check across all jobs (RAM might have changed since calc)
    const ramHack   = ns.getScriptRam("remote-hack.js","home");
    const ramGrow   = ns.getScriptRam("remote-grow.js","home");
    const ramWeaken = ns.getScriptRam("remote-weaken.js","home");

    let totalRamNeed=0;
    for(const j of jobs){
      const r = (j.script==="remote-hack.js")?ramHack:(j.script==="remote-grow.js")?ramGrow:ramWeaken;
      totalRamNeed += r * j.threads;
    }
    const availNow = sum(availableRamByHost(ns, hosts));
    if (totalRamNeed > availNow * UTIL_HEADROOM) {
      // shrink batch count proportionally
      const shrink = Math.max(1, Math.ceil(totalRamNeed / (availNow * UTIL_HEADROOM)));
      const newCount = Math.max(1, Math.floor((jobs.length/4) / shrink));
      ns.tprint(`RAM re-check: shrinking batch count ${(jobs.length/4)}→${newCount}`);
      jobs.length = newCount*4;
    }

    ns.tprint(`Launching ${jobs.length/4} batch(es)…`);
    for(const j of jobs){
      if(j.threads<=0) continue;
      await allocateAndRun(ns, hosts, j.script, target, j.threads, j.delay);
    }

    // Wait for last batch’s W2
    const lastBase = baseFinish0 + ((jobs.length/4) - 1) * CADENCE;
    const lastFinishW2 = lastBase;
    const waitMs = Math.max(0, (lastFinishW2 + 1000) - Date.now());
    ns.tprint(`Waiting for batch set to finish (~${formatMs(waitMs)})`);
    await ns.sleep(waitMs + 50);

    // ---- End-of-set verification (STRICT) ----
    const secAfter   = ns.getServerSecurityLevel(target);
    const minSec     = ns.getServerMinSecurityLevel(target);
    const moneyAfter = ns.getServerMoneyAvailable(target);
    const maxM       = ns.getServerMaxMoney(target);

    ns.tprint(`End-of-set check: sec=${secAfter.toFixed(3)} vs min=${minSec.toFixed(3)}, money=${Math.floor(moneyAfter)}/${Math.floor(maxM)}`);

    const preppedOK = (secAfter <= minSec + PREP_SEC_TOLERANCE) && (moneyAfter >= maxM * PREP_MONEY_TOLERANCE);

    if (!preppedOK){
      ns.tprint(`Drift detected: aborting all queued H/G/W for ${target} and re-prepping…`);
      await killAllTargetJobs(ns, hosts, target);

      // Fast corrective prep (strict)
      const secNow = ns.getServerSecurityLevel(target);
      const secDiff = Math.max(0, secNow - minSec);
      if (secDiff > 0){
        const w = Math.ceil(secDiff / 0.05);
        ns.tprint(`Corrective weaken → min (threads=${w})`);
        await allocateAndRun(ns, hosts, "remote-weaken.js", target, w);
        await ns.sleep(ns.getWeakenTime(target) + 100);
      }

      const moneyNow = ns.getServerMoneyAvailable(target);
      if (moneyNow < maxM * PREP_MONEY_TOLERANCE){
        const ramGrow = ns.getScriptRam("remote-grow.js","home");
        let cap=0;
        for(const h of hosts){
          const max=ns.getServerMaxRam(h), used=ns.getServerUsedRam(h);
          let avail=Math.max(0, max-used);
          if(h==="home") avail=Math.max(0, avail - HOME_RAM_RESERVE_GB);
          cap += Math.floor(avail / ramGrow);
        }
        const g = Math.max(1, Math.min(cap, 20000));
        ns.tprint(`Corrective grow wave (threads=${g})`);
        await allocateAndRun(ns, hosts, "remote-grow.js", target, g);
        await ns.sleep(ns.getGrowTime(target) + 100);

        let gSec=0;
        try { gSec = ns.growthAnalyzeSecurity ? ns.growthAnalyzeSecurity(g) : 0.004*g; }
        catch(_){ gSec = 0.004*g; }
        const wNeed = Math.ceil(gSec / 0.05);
        if (wNeed > 0){
          ns.tprint(`Corrective post-grow weaken (threads=${wNeed})`);
          await allocateAndRun(ns, hosts, "remote-weaken.js", target, wNeed);
          await ns.sleep(ns.getWeakenTime(target) + 100);
        }
      }

      // Re-check strict; if still not prepped, loop around to prep again before scheduling
      const s2 = ns.getServerSecurityLevel(target);
      const m2 = ns.getServerMoneyAvailable(target);
      if (s2 > minSec + PREP_SEC_TOLERANCE || m2 < maxM * PREP_MONEY_TOLERANCE){
        ns.tprint(`Still not prepped (sec=${s2.toFixed(3)}, money=${Math.floor(m2)}). Looping corrective again…`);
        continue; // back to while(true): will prep then plan again
      }

      ns.tprint("Corrective complete. Re-scheduling fresh batches…");
    }

    await ns.sleep(100);
  }
}

