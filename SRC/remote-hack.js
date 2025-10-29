export async function main(ns){ const t=ns.args[0]; if(!t){ns.tprint("hack: missing target"); return;} await ns.hack(t); }
