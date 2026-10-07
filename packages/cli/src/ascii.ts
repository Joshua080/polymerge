/**
 * Plain-ASCII output, for consoles whose font has no arrows, check marks or dashes (the classic
 * Windows console host behind cmd.exe and Windows PowerShell). Everything polymerge writes to
 * stdout / stderr passes through `toAscii` when it is on; bytes (a model written to stdout) pass
 * untouched. Replacements never introduce a double quote or a backslash, so JSON output stays
 * valid JSON.
 */

const MAP: Record<string, string> = {
  '→': '->',
  '←': '<-',
  '↔': '<->',
  '↦': '->',
  '⇒': '=>',
  '⇔': '<=>',
  '↳': '->',
  '—': '-',
  '–': '-',
  '−': '-',
  '·': '|',
  '×': 'x',
  '…': '...',
  '≥': '>=',
  '≤': '<=',
  '≈': '~',
  '≳': '>~',
  '≠': '!=',
  '±': '+/-',
  '°': ' deg',
  '²': '^2',
  '³': '^3',
  '¹': '^1',
  '⁰': '^0',
  '⁶': '^6',
  '⁹': '^9',
  '⁻': '^-',
  'ⁿ': '^n',
  'ᵀ': '^T',
  '½': '1/2',
  '¼': '1/4',
  'Ø': 'D',
  'Δ': 'd',
  'δ': 'd',
  'ε': 'eps',
  'Σ': 'sum',
  'σ': 'sigma',
  'θ': 'theta',
  'τ': 'tau',
  'π': 'pi',
  'ω': 'omega',
  'α': 'alpha',
  'Φ': 'Phi',
  '√': 'sqrt',
  '∘': 'o',
  '✓': 'ok',
  '✔': 'ok',
  '✗': 'x',
  '•': '*',
  '⚠': '!',
  '§': 'S',
  '’': "'",
  '‘': "'",
  '“': "'",
  '”': "'",
  'å': 'a',
  'ö': 'o',
  ' ': ' ',
};

/** The text with every non-ASCII character spelled in ASCII ('?' for anything unknown). */
export function toAscii(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x00-\x7f]/gu, (ch) => MAP[ch] ?? (/\p{M}/u.test(ch) ? '' : '?'));
}

/**
 * Whether to write plain ASCII: `--ascii` / `--unicode` decide, then POLYMERGE_ASCII (1 / 0);
 * otherwise only on a Windows console that is not a modern terminal (Windows Terminal, VS Code,
 * ConEmu), and only when output goes to that console.
 */
export function wantsAscii(flags: { ascii?: boolean; unicode?: boolean }, env: NodeJS.ProcessEnv = process.env, platform = process.platform, isTTY = process.stdout.isTTY === true): boolean {
  if (flags.unicode) return false;
  if (flags.ascii) return true;
  if (env.POLYMERGE_ASCII === '1') return true;
  if (env.POLYMERGE_ASCII === '0') return false;
  return platform === 'win32' && isTTY && !env.WT_SESSION && !env.TERM_PROGRAM && !env.ConEmuANSI;
}

/** Route stdout and stderr through toAscii for the rest of the process. */
export function installAsciiOutput(): void {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => write(typeof chunk === 'string' ? toAscii(chunk) : chunk, ...rest)) as typeof stream.write;
  }
}
