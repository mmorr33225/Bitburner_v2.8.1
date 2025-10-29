export async function main(ns){ const t=ns.args[0]; if(!t){ns.tprint("weaken: missing target"); return;} await ns.weaken(t); }
