/** auto-batch.js
 * Preps all targets, then run at most ONE HWGW batch per target in descending maxMoney.
 *
 * Usage:
 *   run auto-batch.js [hackFraction=0.01] [leadMs=3000] [epsMs=200] [homeReserveGB=4]
 */

export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");
  ns.disableLog("scp");

  // -------------------- Config --------------------
  let hackFraction = Number(ns.args[0]) || 0.01;
  const leadMs      = Number(ns.args[1]) || 3000;
  const epsMs       = Number(ns.args[2]) || 200;
  const homeReserve = Number(ns.args[3]) || 4;

  if (!isFinite(hackFraction) || hackFraction <= 0) hackFraction = 0.01;
  hackFraction = Math.max(0.0001, Math.min(0.5, hackFraction));

  const WORKERS = {
    hack:   "remote-hack.js",
    grow:   "remote-grow.js",
    weaken: "remote-weaken.js",
  };

  for (const s of Object.values(WORKERS)) {
    if (!ns.fileExists(s, "home")) {
      ns.tprint(`Missing worker '${s}' on home. Upload it and re-run.`);
      return;
    }
  }

  // Hosts we can launch on
  const purchased = ns.getPurchasedServers();
  const candidateHosts = ["home", ...purchased];
  for (const h of candidateHosts) {
    if (h === "home") continue;
    for (const s of Object.values(WORKERS)) { try { await ns.scp(s, h); } catch {} }
  }

  // -------------------- Utilities --------------------
  function bfsServers() {
    const seen = new Set(), out = [], q = ["home"];
    while (q.length) {
      const cur = q.shift();
      if (seen.has(cur)) continue;
      seen.add(cur); out.push(cur);
      try { for (const n of ns.scan(cur)) if (!seen.has(n)) q.push(n); } catch {}
    }
    return out;
  }
  function haveProgram(name) { return ns.fileExists(name, "home"); }
  function tryRoot(host) {
    if (ns.hasRootAccess(host)) return true;
    try { if (haveProgram("BruteSSH.exe"))  ns.brutessh(host); }   catch {}
    try { if (haveProgram("FTPCrack.exe"))  ns.ftpcrack(host); }   catch {}
    try { if (haveProgram("relaySMTP.exe")) ns.relaysmtp(host); }  catch {}
    try { if (haveProgram("HTTPWorm.exe"))  ns.httpworm(host); }   catch {}
    try { if (haveProgram("SQLInject.exe")) ns.sqlinject(host); }  catch {}
    try { ns.nuke(host); } catch {}
    return ns.hasRootAccess(host);
  }
  function candidateTargetsSorted() {
    const servers = bfsServers();
    const myHack = ns.getHackingLevel();
    const c = [];
    for (const s of servers) {
      if (s === "home") continue;
      try {
        const maxMoney = ns.getServerMaxMoney(s);
        if (!maxMoney || maxMoney <= 0) continue;
        if (ns.getServerRequiredHackingLevel(s) > myHack) continue;
        if (!tryRoot(s)) continue;
        c.push({ host: s, maxMoney });
      } catch {}
    }
    c.sort((a,b) => b.maxMoney - a.maxMoney);
    return c;
  }
  function buildHostInfo() {
    const list = [];
    for (const h of candidateHosts) {
      try {
        const max = ns.getServerMaxRam(h);
        const used = ns.getServerUsedRam(h);
        const reserve = (h === "home") ? homeReserve : 0;
        const free = Math.max(0, max - used - reserve);
        if (free > 0) list.push({ host: h, freeRam: free, max });
      } catch {}
    }
    return list;
  }
  function allocateThreadsAcrossHosts(hostInfo, threadsNeeded, ramPerThread) {
    const allocations = []; // {host, threads}
    let left = threadsNeeded;
    hostInfo.sort((a,b) => b.freeRam - a.freeRam);
    for (const h of hostInfo) {
      if (left <= 0) break;
      const can = Math.floor(h.freeRam / ramPerThread);
      if (can <= 0) continue;
      const take = Math.min(can, left);
      allocations.push({ host: h.host, threads: take });
      h.freeRam -= take * ramPerThread;
      left -= take;
    }
    return { allocations, remaining: left };
  }
  function execAllocations(script, allocations, target) {
    for (const a of allocations) {
      if (a.threads <= 0) continue;
      const pid = ns.exec(script, a.host, a.threads, target);
      if (pid <= 0) ns.print(`exec FAILED: ${script} x${a.threads} @ ${a.host}`);
    }
  }

  // -------------------- RAM and Batch Math --------------------
  const ramHack   = ns.getScriptRam(WORKERS.hack, "home");
  const ramGrow   = ns.getScriptRam(WORKERS.grow, "home");
  const ramWeaken = ns.getScriptRam(WORKERS.weaken, "home");

  function computeBatchThreads(tgt, frac) {
    const maxMoney = Math.max(1, ns.getServerMaxMoney(tgt));
    const moneyToSteal = Math.max(1, Math.floor(maxMoney * frac));
    let hackThreads = 1;
    try {
      const t = Math.ceil(ns.hackAnalyzeThreads(tgt, moneyToSteal));
      hackThreads = Math.max(1, isFinite(t) ? t : 1);
    } catch {
      let per = 0; try { per = ns.hackAnalyze(tgt); } catch {}
      hackThreads = Math.max(1, per > 0 ? Math.ceil(frac / per) : Math.ceil(frac * 100));
    }
    const factor = 1 / (1 - frac);
    let growThreads = 1;
    try {
      growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(tgt, factor)));
      growThreads = Math.ceil(growThreads * 1.02);
    } catch {
      growThreads = Math.max(1, Math.ceil((factor - 1) * 100));
    }

    let wPer = 0.05; try { wPer = ns.weakenAnalyze(1); } catch {}
    let secH = 0, secG = 0;
    try { secH = ns.hackAnalyzeSecurity(hackThreads); } catch { secH = 0.002 * hackThreads; }
    try { secG = ns.growthAnalyzeSecurity(growThreads); } catch { secG = 0.004 * growThreads; }
    const wHack = Math.max(1, Math.ceil(secH / wPer));
    const wGrow = Math.max(1, Math.ceil(secG / wPer));

    return { hackThreads, growThreads, wHackThreads: wHack, wGrowThreads: wGrow };
  }

  function needsPrep(tgt) {
    const minSec  = ns.getServerMinSecurityLevel(tgt);
    const curSec  = ns.getServerSecurityLevel(tgt);
    const maxMon  = Math.max(1, ns.getServerMaxMoney(tgt));
    const curMon  = ns.getServerMoneyAvailable(tgt);
    return {
      secBad:   curSec  > minSec + 0.25,
      moneyBad: curMon  < 0.98 * maxMon,
      minSec, curSec, maxMon, curMon
    };
  }

  // -------------------- Global State: Reservations & Events --------------------
  let hostInfo = buildHostInfo();  // live free RAM (after applying reservations)
  const reservations = [];         // { releaseTime, perHostReserved:[{host, gb}], target, type }
  const events = [];               // { time, script, allocations:[{host,threads}], target }
  const inFlightBatches = new Map(); // target -> count (we cap to 1)

  function clearExpiredReservations(now = Date.now()) {
    for (let i = reservations.length - 1; i >= 0; i--) {
      if (reservations[i].releaseTime <= now) {
        for (const r of reservations[i].perHostReserved) {
          const h = hostInfo.find(x => x.host === r.host);
          if (h) h.freeRam += r.gb;
        }
        // decrement in-flight when a batch finishes
        if (reservations[i].type === "batch") {
          const t = reservations[i].target;
          inFlightBatches.set(t, Math.max(0, (inFlightBatches.get(t) || 0) - 1));
        }
        reservations.splice(i, 1);
      }
    }
  }
  function rebuildHostInfoMinusReservations() {
    hostInfo = buildHostInfo();
    for (const res of reservations) {
      for (const r of res.perHostReserved) {
        const h = hostInfo.find(x => x.host === r.host);
        if (h) h.freeRam = Math.max(0, h.freeRam - r.gb);
      }
    }
  }
  function queueEvents(evs) {
    for (const ev of evs) events.push(ev);
    events.sort((a,b) => a.time - b.time);
  }
  function commitReservation(perHostAllocArrays, ramPerThreadArray, releaseTime, note, target, type) {
    const sum = new Map();
    for (let i = 0; i < perHostAllocArrays.length; i++) {
      const allocs = perHostAllocArrays[i];
      const ramPT  = ramPerThreadArray[i];
      for (const a of allocs) {
        const gb = a.threads * ramPT;
        sum.set(a.host, (sum.get(a.host) || 0) + gb);
      }
    }
    for (const [host, gb] of sum.entries()) {
      const h = hostInfo.find(x => x.host === host);
      if (h) h.freeRam = Math.max(0, h.freeRam - gb);
    }
    reservations.push({
      releaseTime,
      perHostReserved: Array.from(sum.entries()).map(([host, gb]) => ({ host, gb })),
      note, target, type
    });
  }

  // -------------------- Schedulers (no sleeps; only queue events + reserve) --------------------
  function schedulePrepForTarget(tgt) {
    const st = needsPrep(tgt);
    if (!st.secBad && !st.moneyBad) return false; // nothing to do

    const tG = Math.ceil(ns.getGrowTime(tgt));
    const tW = Math.ceil(ns.getWeakenTime(tgt));
    let wPer = 0.05; try { wPer = ns.weakenAnalyze(1); } catch {}

    let wMin = 0;
    if (st.secBad) wMin = Math.ceil(Math.max(0, st.curSec - st.minSec) / wPer);

    let gT = 0, wG = 0;
    if (st.moneyBad) {
      const mult = Math.min(10000, Math.max(1.01, st.maxMon / Math.max(1, st.curMon)));
      try { gT = Math.max(1, Math.ceil(ns.growthAnalyze(tgt, mult))); }
      catch { gT = Math.max(1, Math.ceil((mult - 1) * 100)); }
      gT = Math.ceil(gT * 1.02);
      let secG = 0; try { secG = ns.growthAnalyzeSecurity(gT); } catch { secG = 0.004 * gT; }
      wG = Math.max(1, Math.ceil(secG / wPer));
    }

    // Try to allocate fully; if not enough RAM, skip and try another target
    const poolA = hostInfo.map(h => ({...h}));
    const poolB = hostInfo.map(h => ({...h}));
    const growAlloc  = (gT   > 0) ? allocateThreadsAcrossHosts(poolA, gT,   ramGrow)   : { allocations:[], remaining:0 };
    const wGrowAlloc = (wG   > 0) ? allocateThreadsAcrossHosts(poolA, wG,   ramWeaken) : { allocations:[], remaining:0 };
    const wMinAlloc  = (wMin > 0) ? allocateThreadsAcrossHosts(poolB, wMin, ramWeaken) : { allocations:[], remaining:0 };
    if (growAlloc.remaining > 0 || wGrowAlloc.remaining > 0 || wMinAlloc.remaining > 0) return false;

    const now = Date.now();
    const baseFinish = now + 3000;
    const weakenGrowFinish = baseFinish + tW;
    const growFinish       = weakenGrowFinish - epsMs;

    const evs = [];
    if (gT > 0) {
      evs.push({ time: growFinish - tG,       script: WORKERS.grow,   allocations: growAlloc.allocations,   target: tgt });
      evs.push({ time: weakenGrowFinish - tW, script: WORKERS.weaken, allocations: wGrowAlloc.allocations,  target: tgt });
    }
    if (wMin > 0) {
      evs.push({ time: now,                   script: WORKERS.weaken, allocations: wMinAlloc.allocations,   target: tgt });
    }

    const releaseTime = Math.max(
      ...evs.map(e => (e.script === WORKERS.weaken ? e.time + tW : e.time + (e.script === WORKERS.grow ? tG : 0)))
    ) + 500;

    commitReservation(
      [growAlloc.allocations, wGrowAlloc.allocations, wMinAlloc.allocations],
      [ramGrow,               ramWeaken,             ramWeaken],
      releaseTime,
      `prep ${tgt}`,
      tgt,
      "prep"
    );
    queueEvents(evs);
    ns.print(`Prep scheduled for ${tgt}`);
    return true;
  }

  function scheduleOneBatchForTarget(tgt, frac) {
    if ((inFlightBatches.get(tgt) || 0) >= 1) return false; // one in-flight batch per target

    const tH = Math.ceil(ns.getHackTime(tgt));
    const tG = Math.ceil(ns.getGrowTime(tgt));
    const tW = Math.ceil(ns.getWeakenTime(tgt));

    const { hackThreads, growThreads, wHackThreads, wGrowThreads } = computeBatchThreads(tgt, frac);

    const temp = hostInfo.map(h => ({...h}));
    const hackAlloc  = allocateThreadsAcrossHosts(temp, hackThreads,  ramHack);
    if (hackAlloc.remaining > 0) return false;
    const wHackAlloc = allocateThreadsAcrossHosts(temp, wHackThreads, ramWeaken);
    if (wHackAlloc.remaining > 0) return false;
    const growAlloc  = allocateThreadsAcrossHosts(temp, growThreads,  ramGrow);
    if (growAlloc.remaining > 0) return false;
    const wGrowAlloc = allocateThreadsAcrossHosts(temp, wGrowThreads, ramWeaken);
    if (wGrowAlloc.remaining > 0) return false;

    const now = Date.now();
    const T = now + leadMs;

    const hackFinish  = T - 3 * epsMs;
    const wHackFinish = T - 2 * epsMs;
    const growFinish  = T - 1 * epsMs;
    const wGrowFinish = T;

    const evs = [
      { time: hackFinish  - tH, script: WORKERS.hack,   allocations: hackAlloc.allocations,   target: tgt },
      { time: wHackFinish - tW, script: WORKERS.weaken, allocations: wHackAlloc.allocations, target: tgt },
      { time: growFinish  - tG, script: WORKERS.grow,   allocations: growAlloc.allocations,  target: tgt },
      { time: wGrowFinish - tW, script: WORKERS.weaken, allocations: wGrowAlloc.allocations, target: tgt },
    ];

    const releaseTime = wGrowFinish + 1000;
    commitReservation(
      [hackAlloc.allocations, wHackAlloc.allocations, growAlloc.allocations, wGrowAlloc.allocations],
      [ramHack,               ramWeaken,             ramGrow,               ramWeaken],
      releaseTime,
      `batch ${tgt}`,
      tgt,
      "batch"
    );
    inFlightBatches.set(tgt, (inFlightBatches.get(tgt) || 0) + 1);
    queueEvents(evs);
    ns.print(`Scheduled ONE batch for ${tgt}`);
    return true;
  }

  // -------------------- Main Loop (single sleeper dispatcher) --------------------
  ns.tprint(`auto-batch: prep-all then one-batch-per-target (desc maxMoney). hackFrac=${hackFraction} reserveHOME=${homeReserve}GB`);
  ns.print (`Script RAM: hack=${ramHack}GB grow=${ramGrow}GB weaken=${ramWeaken}GB`);

  // Phase control
  let preppingPhase = true;

  while (true) {
    try {
      // Release any finished reservations and rebuild free-RAM view
      clearExpiredReservations();
      rebuildHostInfoMinusReservations();

      const targets = candidateTargetsSorted();
      if (targets.length === 0) {
        ns.print("No hackable targets. Sleeping.");
        await ns.sleep(1000);
        continue;
      }

      if (preppingPhase) {
        // Try to schedule prep for ALL targets (descending maxMoney)
        let scheduledSomething = false;
        for (const c of targets) {
          const st = needsPrep(c.host);
          if (st.secBad || st.moneyBad) {
            const ok = schedulePrepForTarget(c.host);
            if (ok) scheduledSomething = true;
          }
        }
        if (!scheduledSomething) {
          // Nothing to prep (everyone good) -> move to batching phase
          preppingPhase = false;
          ns.print("All targets prepped → entering batching phase.");
        }
      } else {
        // Batching phase: walk descending maxMoney, schedule at most one batch per target
        for (const c of targets) {
          const st = needsPrep(c.host);
          if (st.secBad || st.moneyBad) {
            // If a target slipped out of prepped state, schedule its prep again
            schedulePrepForTarget(c.host);
            continue;
          }
          // Try to schedule one batch
          scheduleOneBatchForTarget(c.host, hackFraction);
        }
      }

      // Dispatcher: if we have events, wait until the next one, execute all due, loop.
      if (events.length === 0) {
        await ns.sleep(250); // nothing queued; short nap
        continue;
      }
      const next = events[0];
      const wait = Math.max(0, Math.round(next.time - Date.now()));
      if (wait > 0) await ns.sleep(wait);
      const now = Date.now();
      while (events.length && events[0].time <= now) {
        const ev = events.shift();
        execAllocations(ev.script, ev.allocations, ev.target);
      }

    } catch (e) {
      ns.print("auto-batch error: " + e);
      await ns.sleep(1000);
    }
  }
}
