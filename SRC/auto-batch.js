

export async function main(ns) {
  ns.disableLog("sleep");
  ns.disableLog("getServerMaxRam");
  ns.disableLog("getServerUsedRam");
  ns.disableLog("scp");

  // parse args
  const argTarget = ns.args[0] ? String(ns.args[0]) : "";
  let hackFraction = Number(ns.args[1]) || 0.01;
  const leadMs = Number(ns.args[2]) || 3000;
  const epsMs = Number(ns.args[3]) || 200;
  const reserveGB = Number(ns.args[4]) || 4;

  // validate hackFraction
  if (!isFinite(hackFraction) || hackFraction <= 0) hackFraction = 0.001;
  if (hackFraction >= 1) hackFraction = 0.5; // absurd, but clamp down
  hackFraction = Math.max(0.0001, Math.min(0.9, hackFraction)); // sane clamp

  const WORKERS = {
    hack: "remote-hack.js",
    grow: "remote-grow.js",
    weaken: "remote-weaken.js"
  };

  // ensure worker scripts exist on home
  for (const s of Object.values(WORKERS)) {
    if (!ns.fileExists(s, "home")) {
      ns.tprint(`Missing worker '${s}' on home. Upload it and re-run.`);
      return;
    }
  }

  // gather all reachable servers
  function gatherAllServers() {
    const visited = new Set();
    const queue = ["home"];
    while (queue.length) {
      const s = queue.shift();
      if (visited.has(s)) continue;
      visited.add(s);
      try {
        for (const n of ns.scan(s)) {
          if (!visited.has(n)) queue.push(n);
        }
      } catch (e) { /* ignore scan errors */ }
    }
    return Array.from(visited);
  }

  // pick best target if none provided
  function pickBestTarget() {
    const servers = gatherAllServers();
    const myHack = ns.getHackingLevel();
    let best = null;
    let bestMoney = 0;
    for (const s of servers) {
      try {
        if (s === "home") continue;
        const maxMoney = ns.getServerMaxMoney(s);
        const req = ns.getServerRequiredHackingLevel(s);
        if (!maxMoney || maxMoney <= 0) continue;
        if (req > myHack) continue;
        if (maxMoney > bestMoney) {
          bestMoney = maxMoney;
          best = s;
        }
      } catch (e) {
        // ignore servers we can't query
      }
    }
    return best;
  }

  // resolve target
  let target = argTarget;
  if (!target) {
    target = pickBestTarget();
    if (!target) {
      ns.tprint("No suitable hackable target found (no server with maxMoney>0 and reqHacking <= your level).");
      return;
    }
    ns.tprint(`Auto-selected target: ${target} (maxMoney=${ns.getServerMaxMoney(target)})`);
  } else {
    ns.tprint(`Using provided target: ${target}`);
  }

  // copy workers to purchased servers (best-effort)
  const purchased = ns.getPurchasedServers();
  const candidateHosts = ["home", ...purchased];
  for (const host of candidateHosts) {
    if (host === "home") continue;
    for (const script of Object.values(WORKERS)) {
      try { await ns.scp(script, host); } catch (e) { /* ignore scp errors */ }
    }
  }

  // helper: compute threads for a single batch (analyzer-based) with explicit fallbacks & warnings
  function computeBatchThreads(tgt, hackFrac) {
    let usedFallback = false;
    let perHack = 0;
    try { perHack = ns.hackAnalyze(tgt); } catch (e) { perHack = 0; usedFallback = true; }
    let hackThreads = perHack > 0 ? Math.max(1, Math.ceil(hackFrac / perHack)) : Math.max(1, Math.ceil(hackFrac * 100));
    if (perHack === 0) ns.print("WARN: hackAnalyze returned 0 or threw; using fallback for hackThreads.");

    const factor = 1 / (1 - hackFrac);
    let growThreads = 1;
    try { growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(tgt, factor))); } catch (e) { growThreads = Math.max(1, Math.ceil((factor - 1) * 100)); usedFallback = true; ns.print("WARN: growthAnalyze failed; using fallback for growThreads."); }

    let secIncHack = 0;
    try { secIncHack = ns.hackAnalyzeSecurity(hackThreads); } catch (e) { secIncHack = 0.002 * hackThreads; usedFallback = true; ns.print("WARN: hackAnalyzeSecurity failed; using fallback secIncHack."); }
    let secIncGrow = 0;
    try { secIncGrow = ns.growthAnalyzeSecurity(growThreads); } catch (e) { secIncGrow = 0.004 * growThreads; usedFallback = true; ns.print("WARN: growthAnalyzeSecurity failed; using fallback secIncGrow."); }
    let weakenPerThread = 0.05;
    try { weakenPerThread = ns.weakenAnalyze(1); } catch (e) { weakenPerThread = 0.05; usedFallback = true; ns.print("WARN: weakenAnalyze failed; using fallback weakenPerThread."); }

    const weakenThreadsForHack = Math.max(1, Math.ceil(secIncHack / weakenPerThread));
    const weakenThreadsForGrow = Math.max(1, Math.ceil(secIncGrow / weakenPerThread));

    return { hackThreads, growThreads, weakenThreadsForHack, weakenThreadsForGrow, usedFallback };
  }

  // helper: split-launch threads across available hosts; logs exec failures & does one small retry
  function launchThreadsSplit(script, threadsNeeded, delayMs, hostsInfo, ramPerThread) {
    let left = threadsNeeded;
    const launches = [];
    hostsInfo.sort((a, b) => b.freeRam - a.freeRam);
    for (const h of hostsInfo) {
      if (left <= 0) break;
      const can = Math.floor(h.freeRam / ramPerThread);
      if (can <= 0) continue;
      const take = Math.min(can, left);
      const pid = ns.exec(script, h.host, take, target, Math.max(0, Math.round(delayMs)));
      if (pid > 0) {
        launches.push({ host: h.host, threads: take, pid });
        h.freeRam -= take * ramPerThread;
        left -= take;
      } else {
        ns.print(`exec FAILED: ${script} x${take} on ${h.host} (pid=0). Host may not have root or enough instantaneous RAM.`);
        // try a very small retry (one-shot) after a tiny sleep to allow transient frees (best-effort)
        try {
          // local sleep is synchronous here; keep it very short
          // NOTE: we do not await huge sleeps here; it's only a micro-retry
          const retryPid = ns.exec(script, h.host, Math.max(1, Math.min(take, 1)), target, Math.max(0, Math.round(delayMs)));
          if (retryPid > 0) {
            ns.print(`exec RETRY success: ${script} x1 on ${h.host} (pid ${retryPid})`);
            launches.push({ host: h.host, threads: 1, pid: retryPid });
            h.freeRam -= 1 * ramPerThread;
            left -= 1;
          }
        } catch (e) { /* ignore retry errors */ }
      }
    }
    return { launches, remaining: left };
  }

  // get script RAMs (from home)
  const ramHack = ns.getScriptRam(WORKERS.hack, "home");
  const ramGrow = ns.getScriptRam(WORKERS.grow, "home");
  const ramWeaken = ns.getScriptRam(WORKERS.weaken, "home");

  ns.tprint(`auto-batch: starting target=${target} hackFrac=${hackFraction} leadMs=${leadMs} epsMs=${epsMs} reserveGB=${reserveGB}`);
  ns.print(`Worker RAM/threads: hackRam=${ramHack}GB growRam=${ramGrow}GB weakenRam=${ramWeaken}GB`);

  const tickMs = 2000;

  while (true) {
    try {
      const tinfo = computeBatchThreads(target, hackFraction);
      const { hackThreads, growThreads, weakenThreadsForHack, weakenThreadsForGrow, usedFallback } = tinfo;

      const tH = Math.ceil(ns.getHackTime(target));
      const tG = Math.ceil(ns.getGrowTime(target));
      const tW = Math.ceil(ns.getWeakenTime(target));

      const ramPerBatch = hackThreads * ramHack + growThreads * ramGrow + (weakenThreadsForHack + weakenThreadsForGrow) * ramWeaken;
      if (!isFinite(ramPerBatch) || ramPerBatch <= 0) {
        ns.tprint("Computed invalid ramPerBatch — aborting to avoid runaway behavior.");
        return;
      }

      // build host free-ram map for hosts we can use
      const hostsInfo = [];
      for (const h of candidateHosts) {
        try {
          const max = ns.getServerMaxRam(h);
          const used = ns.getServerUsedRam(h);
          const free = Math.max(0, max - used - reserveGB);
          if (free > 0) hostsInfo.push({ host: h, freeRam: free, max });
          else ns.print(`Host ${h} ignored: free ${Math.max(0, max - used).toFixed(3)}GB <= reserveGB ${reserveGB}GB`);
        } catch (e) { ns.print(`Could not query host ${h}: ${e}`); }
      }

      const totalFreeRam = hostsInfo.reduce((s, x) => s + x.freeRam, 0);
      const fitBatches = Math.floor(totalFreeRam / ramPerBatch);
      if (fitBatches <= 0) {
        ns.print(`Not enough free RAM to schedule a batch. Need ${ramPerBatch.toFixed(3)} GB per batch; free ${totalFreeRam.toFixed(3)} GB`);
        await ns.sleep(tickMs);
        continue;
      }

      const spacingMs = Math.max(100, Math.floor(tW / Math.max(1, fitBatches)));
      const baseFinish = Date.now() + leadMs;

      ns.print(`Scheduling ${fitBatches} batch(es). ramPerBatch=${ramPerBatch.toFixed(3)} GB tH=${tH} tG=${tG} tW=${tW} spacingMs=${spacingMs} usedFallback=${usedFallback}`);

      // mutable copy for launching
      const launchHostInfo = hostsInfo.map(h => ({ host: h.host, freeRam: h.freeRam }));

      for (let i = 0; i < fitBatches; i++) {
        const T = baseFinish + i * spacingMs;
        const hackFinish = T - 3 * epsMs;
        const weakenHackFinish = T - 2 * epsMs;
        const growFinish = T - epsMs;
        const weakenGrowFinish = T;

        const nowMs = Date.now();
        const startHackDelay = Math.max(0, Math.round(hackFinish - tH - nowMs));
        const startWeakenHackDelay = Math.max(0, Math.round(weakenHackFinish - tW - nowMs));
        const startGrowDelay = Math.max(0, Math.round(growFinish - tG - nowMs));
        const startWeakenGrowDelay = Math.max(0, Math.round(weakenGrowFinish - tW - nowMs));

        const launchPlan = [
          { script: WORKERS.hack, threads: hackThreads, delay: startHackDelay, ramPerThread: ramHack },
          { script: WORKERS.weaken, threads: weakenThreadsForHack, delay: startWeakenHackDelay, ramPerThread: ramWeaken },
          { script: WORKERS.grow, threads: growThreads, delay: startGrowDelay, ramPerThread: ramGrow },
          { script: WORKERS.weaken, threads: weakenThreadsForGrow, delay: startWeakenGrowDelay, ramPerThread: ramWeaken },
        ];

        let batchFailed = false;
        for (const item of launchPlan) {
          if (item.threads <= 0) continue;
          const res = launchThreadsSplit(item.script, item.threads, item.delay, launchHostInfo, item.ramPerThread);
          if (res.remaining > 0) {
            ns.print(`Could not fully launch ${item.script} (remaining threads ${res.remaining}) for batch #${i+1}. Marking batch as partial and moving on.`);
            batchFailed = true;
            break; // don't try to continue launching other parts of this batch
          } else {
            for (const l of res.launches) ns.print(`Launched ${item.script} x${l.threads} on ${l.host} (pid ${l.pid}) delay=${item.delay}ms`);
          }
        }
        if (batchFailed) {
          // continue to next batch — partial batches are ignored to avoid inconsistent states
          continue;
        }
      }

      await ns.sleep(tickMs);
    } catch (err) {
      ns.print("Unexpected error in auto-batch main loop: " + err);
      await ns.sleep(2000);
    }
  } // end while
}
