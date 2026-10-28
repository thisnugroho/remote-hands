export const OUTPUT_LIMIT = 64 * 1024;
export type OutputTail = { bytes: Buffer; total: number };

export function appendOutput(tail: OutputTail, chunk: Buffer, limit = OUTPUT_LIMIT): OutputTail {
  const bytes = chunk.length >= limit ? chunk.subarray(chunk.length - limit) : Buffer.concat([tail.bytes, chunk]);
  return { bytes: bytes.subarray(Math.max(0, bytes.length - limit)), total: tail.total + chunk.length };
}

export function truncateOutput(tail: OutputTail): string {
  let start = 0;
  while (start < tail.bytes.length && (tail.bytes[start] & 0xc0) === 0x80) start++;
  const omitted = tail.total - tail.bytes.length + start;
  const text = tail.bytes.subarray(start).toString("utf8");
  return omitted > 0 ? `[truncated ${omitted} bytes]\n${text}` : text;
}

export type CommandResult = {
  code: number | null;
  stdout: OutputTail;
  stderr: OutputTail;
  problem: string | null;
};

export function formatCommandResult(result: CommandResult): string {
  return [
    `exit ${result.code ?? -1}`,
    ...(result.problem === null ? [] : [result.problem]),
    "stdout:", truncateOutput(result.stdout),
    "stderr:", truncateOutput(result.stderr),
  ].join("\n");
}
