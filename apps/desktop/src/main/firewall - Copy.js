'use strict';

const { exec } = require('child_process');

const RULE_NAME = 'DWM Web Remote';

/**
 * Check whether the inbound firewall rule exists and is enabled.
 * Calls back with (err, isActive).
 */
function checkRule(callback) {
  const cmd = `powershell -NoProfile -Command "` +
    `$r = Get-NetFirewallRule -DisplayName '${RULE_NAME}' -ErrorAction SilentlyContinue; ` +
    `if ($r) { $r.Enabled } else { 'Missing' }"`;
  exec(cmd, (err, stdout) => {
    if (err) return callback(null, false);
    callback(null, stdout.trim() === 'True');
  });
}

/**
 * Create (or replace) an inbound TCP rule for the given port.
 * Also removes any auto-created block rules for node/electron executables.
 * Runs elevated via Start-Process -Verb RunAs, which triggers a UAC prompt.
 * Calls back with (err).
 */
function openPort(port, execPath, callback) {
  if (typeof execPath === 'function') { callback = execPath; execPath = null; }

  const appPath = (execPath || process.execPath).replace(/\\/g, '\\\\');

  // Build the PowerShell block to run elevated
  const script = [
    `$ErrorActionPreference='SilentlyContinue'`,
    // Remove existing DWM rule
    `Get-NetFirewallRule -DisplayName '${RULE_NAME}' | Remove-NetFirewallRule`,
    // Remove Windows auto-generated block rules for Electron/node executables
    `Get-NetFirewallRule -Direction Inbound -Action Block | Where-Object { $_.DisplayName -like '*Electron*' -or $_.DisplayName -like '*node*' -or ((Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $_ -ErrorAction SilentlyContinue).Program -eq '${appPath}') } | Remove-NetFirewallRule`,
    // Create new allow-by-port rule
    `New-NetFirewallRule -DisplayName '${RULE_NAME}' -Direction Inbound -Protocol TCP` +
      ` -LocalPort ${port} -Action Allow -Profile Any` +
      ` -Description 'Dibby Wemo Manager Web Remote (port ${port})'`,
    // Create allow-by-application rule to handle Windows app-level blocking
    `New-NetFirewallRule -DisplayName '${RULE_NAME} (App)' -Direction Inbound -Program '${appPath}'` +
      ` -Action Allow -Profile Any` +
      ` -Description 'Dibby Wemo Manager Web Remote — app rule'`,
    // Ensure Private/Domain profiles don't have "Block all inbound" override set
    `Set-NetFirewallProfile -Profile Private,Domain,Public -AllowInboundRules True`,
  ].join('; ');

  // Base64-encode to avoid shell-quoting issues
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  const elevateCmd = `powershell -NoProfile -Command ` +
    `"Start-Process powershell -ArgumentList '-NoProfile -EncodedCommand ${encoded}' -Verb RunAs -Wait"`;

  exec(elevateCmd, callback);
}

/**
 * Delete the inbound firewall rule (elevated).
 * Calls back with (err).
 */
function deleteRule(callback) {
  const script = `$ErrorActionPreference='SilentlyContinue'; Get-NetFirewallRule -DisplayName '${RULE_NAME}' | Remove-NetFirewallRule; Get-NetFirewallRule -DisplayName '${RULE_NAME} (App)' | Remove-NetFirewallRule`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const elevateCmd = `powershell -NoProfile -Command ` +
    `"Start-Process powershell -ArgumentList '-NoProfile -EncodedCommand ${encoded}' -Verb RunAs -Wait"`;
  exec(elevateCmd, callback);
}

module.exports = { checkRule, openPort, deleteRule, RULE_NAME };
