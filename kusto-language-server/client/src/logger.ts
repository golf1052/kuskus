import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Kuskus");
  }
  return outputChannel;
}

function timestamp(): string {
  return new Date().toISOString();
}

function write(level: string, message: string): void {
  getChannel().appendLine(`[${timestamp()}][${level}] ${message}`);
}

export function log(message: string): void {
  write("INFO", message);
}

export function logWarn(message: string): void {
  write("WARN", message);
}

export function logError(message: string): void {
  write("ERROR", message);
}

/**
 * Verbose diagnostic logging. Only written to the output channel when the
 * `kuskusLanguageServer.verboseLogging` setting is enabled.
 *
 * Use this for high-frequency, low-signal events (e.g. per-request token cache
 * hits) that would otherwise flood the log during normal use. Enabling the
 * setting lets a user capture a detailed trace when reproducing a token-refresh
 * or connection failure.
 */
export function logDebug(message: string): void {
  if (isVerboseLoggingEnabled()) {
    write("DEBUG", message);
  }
}

function isVerboseLoggingEnabled(): boolean {
  try {
    return vscode.workspace
      .getConfiguration("kuskusLanguageServer")
      .get<boolean>("verboseLogging", false);
  } catch {
    // Configuration is unavailable outside a running extension host (e.g. in
    // unit tests). Default to quiet.
    return false;
  }
}

/** Reveals the Kuskus output channel so the user can inspect recent logs. */
export function showOutputChannel(): void {
  getChannel().show(true);
}

export function dispose(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}
