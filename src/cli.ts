#!/usr/bin/env node

const original = process.emitWarning;
process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  if (text.includes("SQLite is an experimental")) return;
  return Reflect.apply(original, process, [warning, ...args]) as void;
}) as typeof process.emitWarning;

const { main } = await import("./main.js");

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "School Pulse failed");
  process.exitCode = 1;
});
