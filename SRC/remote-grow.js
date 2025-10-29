export async function main(ns){ const t=ns.args[0]; if(!t){ns.tprint("grow: missing target"); return;} await ns.grow(t); }
