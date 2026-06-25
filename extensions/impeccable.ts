import { type ChildProcessByStdio, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import {
  agentCommands,
  extensionCommandDescriptions,
  fallbackAgentCommandDescriptions,
  helpText,
  unknownCommandText,
} from './ui-helpers.ts';

export default function impeccableExtension(pi: ExtensionAPI) {
  const { z } = pi.zod;
  let ctxRef: ExtensionContext | undefined;
  const live: LiveState = { active: false, delivery: 'steer' };
  const pinnedCommandNames = new Set<string>();

  pi.on('resources_discover', (event) => {
    const skillRoot = locateSkill(event.cwd);
    return skillRoot ? { skillPaths: [skillRoot] } : undefined;
  });

  pi.on('session_start', (_event, ctx) => {
    ctxRef = ctx;
    registerPinnedCommands(pi, pinnedCommandNames, ctx.cwd);
    if (live.active) startIndicator(live, ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    const wasActive = live.active || !!live.poll;
    const cwd = live.cwd ?? ctx.cwd;
    const skillRoot = live.skillRoot ?? locateSkill(cwd);

    live.active = false;
    live.pausedFor = undefined;
    killPoll(live);
    clearTransientStatus(ctx);
    stopIndicator(live, ctx);
    ctxRef = undefined;

    if (wasActive && skillRoot) {
      await runNode(
        script(skillRoot, 'live-server.mjs'),
        ['stop'],
        cwd,
        undefined,
        30_000,
      );
    }
  });

  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') return;
    if (
      !/^\s*(stop|exit)\s+(impeccable\s+)?live(\s+mode)?\s*$/i.test(event.text)
    )
      return;
    await stopLive(pi, live, ctx);
    return { handled: true };
  });

  pi.on('tool_call', (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const command = String(
      (event.input as { command?: unknown })?.command ?? '',
    );
    if (!isForegroundLivePoll(command)) return;

    const skillRoot = locateSkill(ctx.cwd);
    if (skillRoot) {
      live.active = true;
      live.cwd = ctx.cwd;
      live.skillRoot = skillRoot;
      startPoll(pi, live, ctxRef ?? ctx);
      ctx.ui.notify('Moved Impeccable live polling to the background.', 'info');
    }

    return {
      block: true,
      reason:
        'Impeccable live polling is managed by the omp-impeccable extension in the background. Do not run live-poll.mjs as a foreground bash tool.',
    };
  });

  pi.registerCommand('impeccable', {
    description:
      'Run Impeccable design commands; live mode runs in the background',
    getArgumentCompletions: (prefix) => completions(prefix, ctxRef?.cwd),
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const tokens = tokenize(args);
      const head = tokens[0] ?? '';

      if (!head || head === 'help' || args.trim() === '--help')
        return display(pi, helpText());
      if (head === 'install') return installOrUpdate(pi, live, ctx, 'install');
      if (head === 'update') return installOrUpdate(pi, live, ctx, 'update');

      if (head === 'live') {
        const sub = tokens[1] ?? '';
        if (sub === 'stop') return stopLive(pi, live, ctx);
        if (sub === 'status') return showLiveStatus(pi, live, ctx);
        return startLive(pi, live, ctx, tokens.slice(1));
      }
      if (head === 'stop') return stopLive(pi, live, ctx);
      if (head === 'status') return showLiveStatus(pi, live, ctx);

      if (head === 'pin')
        return pinCommand(pi, pinnedCommandNames, ctx, tokens.slice(1));
      if (head === 'unpin') return unpinCommand(pi, ctx, tokens.slice(1));
      if (head === 'hooks') return explainHooksCommand(pi, ctx);

      if (!isAgentCommand(head))
        return notifyOrDisplay(pi, ctx, unknownCommandText(head), 'warning');
      showTransientStatus(ctx, `${head} queued`);
      const skillRoot = await ensureSkill(pi, ctx);
      if (!skillRoot) return;
      sendExtensionPrompt(pi, ctx, commandPrompt(args, skillRoot), 'followUp');
    },
  });

  registerPinnedCommands(pi, pinnedCommandNames, process.cwd(), {
    checkConflicts: false,
  });

  pi.registerTool({
    name: 'impeccable_live_reply',
    label: 'Impeccable Live Reply',
    description:
      'Reply to an Impeccable live event after handling generate, steer, or manual Apply work.',
    parameters: z.object({
      id: z.string().describe('Live event id.'),
      status: z
        .enum(['done', 'partial', 'steer_done', 'error'])
        .describe('Live reply status.'),
      file: z
        .string()
        .describe('Changed file path, relative to project root.')
        .optional(),
      message: z
        .string()
        .describe('Short browser/user-facing note or error reason.')
        .optional(),
      data: z.any().describe('Manual Apply JSON payload.').optional(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const skillRoot = live.skillRoot ?? locateSkill(ctx.cwd);
      if (!skillRoot)
        throw new Error(
          'Impeccable skill is not installed. Run /impeccable install first.',
        );
      const argv = ['--reply', params.id, params.status];
      if (params.file) argv.push('--file', params.file);
      if (params.data !== undefined)
        argv.push('--data', JSON.stringify(params.data));
      if (params.message) argv.push(params.message);

      const result = await runNode(
        script(skillRoot, 'live-poll.mjs'),
        argv,
        ctx.cwd,
        signal,
        30_000,
      );
      if (result.code !== 0)
        throw new Error(result.stderr || result.stdout || 'live reply failed');

      live.active = true;
      live.cwd = ctx.cwd;
      live.skillRoot = skillRoot;
      live.pausedFor = undefined;
      startPoll(pi, live, ctxRef ?? ctx);
      return {
        content: [
          {
            type: 'text',
            text: 'Replied to Impeccable live and resumed polling.',
          },
        ],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: 'impeccable_live_complete',
    label: 'Impeccable Live Complete',
    description:
      'Mark Impeccable live accept/carbonize cleanup complete and resume background polling.',
    parameters: z.object({
      id: z.string().describe('Live event/session id.'),
      discarded: z
        .boolean()
        .describe('Set only for discard completion recovery.')
        .optional(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const skillRoot = live.skillRoot ?? locateSkill(ctx.cwd);
      if (!skillRoot)
        throw new Error(
          'Impeccable skill is not installed. Run /impeccable install first.',
        );
      const argv = ['--id', params.id];
      if (params.discarded) argv.push('--discarded');
      const result = await runNode(
        script(skillRoot, 'live-complete.mjs'),
        argv,
        ctx.cwd,
        signal,
        30_000,
      );
      if (result.code !== 0)
        throw new Error(
          result.stderr || result.stdout || 'live complete failed',
        );

      live.active = true;
      live.cwd = ctx.cwd;
      live.skillRoot = skillRoot;
      live.pausedFor = undefined;
      startPoll(pi, live, ctxRef ?? ctx);
      return {
        content: [
          {
            type: 'text',
            text: 'Completed Impeccable live cleanup and resumed polling.',
          },
        ],
        details: result,
      };
    },
  });
}

async function startLive(
  pi: ExtensionAPI,
  live: LiveState,
  ctx: ExtensionContext,
  tokens: string[],
) {
  if (live.poll)
    return ctx.ui.notify('Impeccable live is already polling.', 'info');
  showTransientStatus(ctx, 'live starting');

  const skillRoot = await ensureSkill(pi, ctx);
  if (!skillRoot) return;

  live.delivery = readDelivery(tokens) ?? 'steer';
  live.cwd = ctx.cwd;
  live.skillRoot = skillRoot;
  const boot = await runNode(
    script(skillRoot, 'live.mjs'),
    [],
    ctx.cwd,
    undefined,
    25_000,
  );
  if (boot.code !== 0)
    return display(
      pi,
      `Impeccable live failed:\n\n${boot.stderr || boot.stdout}`,
    );

  const parsed = parseJson(boot.stdout) as { ok?: boolean } | null;
  if (!parsed?.ok) {
    display(
      pi,
      `Impeccable live needs setup:\n\n${JSON.stringify(parsed ?? boot.stdout, null, 2)}`,
    );
    showTransientStatus(ctx, 'live setup queued');
    sendExtensionPrompt(pi, ctx, commandPrompt('live', skillRoot), 'followUp');
    return;
  }

  live.active = true;
  live.pausedFor = undefined;
  clearTransientStatus(ctx);
  startIndicator(live, ctx);
  ctx.ui.notify(
    'Impeccable live started. Say stop live or /impeccable stop to stop.',
    'info',
  );
  startPoll(pi, live, ctx);
}

async function stopLive(
  pi: ExtensionAPI,
  live: LiveState,
  ctx: ExtensionContext,
) {
  showTransientStatus(ctx, 'live stopping');
  killPoll(live);
  live.active = false;
  live.pausedFor = undefined;
  const skillRoot = live.skillRoot ?? locateSkill(ctx.cwd);
  if (!skillRoot) {
    stopIndicator(live, ctx);
    return notifyOrDisplay(
      pi,
      ctx,
      'Impeccable skill is not installed.',
      'warning',
    );
  }
  const stopped = await runNode(
    script(skillRoot, 'live-server.mjs'),
    ['stop'],
    ctx.cwd,
    undefined,
    30_000,
  );
  clearTransientStatus(ctx);
  stopIndicator(live, ctx);
  if (stopped.code === 0) {
    notifyOrDisplay(pi, ctx, 'Impeccable live stopped.', 'info');
  } else {
    display(
      pi,
      `Impeccable stop failed:\n\n${stopped.stderr || stopped.stdout}`,
    );
  }
}

async function showLiveStatus(
  pi: ExtensionAPI,
  live: LiveState,
  ctx: ExtensionContext,
) {
  const skillRoot = locateSkill(ctx.cwd);
  if (!skillRoot)
    return notifyOrDisplay(
      pi,
      ctx,
      'Impeccable skill is not installed. Run /impeccable install.',
      'warning',
    );
  const status = await runNode(
    script(skillRoot, 'live-status.mjs'),
    [],
    ctx.cwd,
    undefined,
    15_000,
  );
  const output = status.stdout.trim() || status.stderr.trim();
  const message =
    status.code === 0
      ? summarizeLiveStatus(output)
      : output || 'No Impeccable live status.';
  notifyOrDisplay(pi, ctx, message, status.code === 0 ? 'info' : 'warning');
  if (live.active) renderIndicator(live, ctx);
}

async function installOrUpdate(
  pi: ExtensionAPI,
  live: LiveState,
  ctx: ExtensionContext,
  action: 'install' | 'update',
) {
  showTransientStatus(ctx, `${action} started`);
  const installed = await installProjectOmpSkill(ctx.cwd);

  clearTransientStatus(ctx);
  if (live.active) renderIndicator(live, ctx);
  else stopIndicator(live, ctx);
  if (installed.result.code !== 0 || !installed.skillRoot) {
    const message =
      installed.result.code !== 0
        ? installed.result.stderr ||
          installed.result.stdout ||
          `impeccable ${action} failed`
        : `.omp/skills/impeccable was not found after staging the upstream Codex install`;
    return notifyOrDisplay(pi, ctx, message, 'error');
  }
  notifyOrDisplay(pi, ctx, `Impeccable ${action} complete.`, 'info');
}

async function ensureSkill(pi: ExtensionAPI, ctx: ExtensionContext) {
  const projectSkill = ensureProjectOmpSkill(ctx.cwd);
  if (projectSkill) return projectSkill;
  display(
    pi,
    'Impeccable is not installed for this project. Installing latest upstream Codex skill into .omp/skills/impeccable...',
  );
  const installed = await installProjectOmpSkill(ctx.cwd);
  if (installed.result.code !== 0) {
    display(
      pi,
      `Impeccable install failed:\n\n${installed.result.stderr || installed.result.stdout}`,
    );
    return null;
  }
  if (!installed.skillRoot) {
    display(
      pi,
      `Impeccable install ran, but .omp/skills/impeccable was not found after staging the upstream Codex install. Output:\n\n${installed.result.stdout}`,
    );
    return null;
  }
  return installed.skillRoot;
}

function startPoll(pi: ExtensionAPI, live: LiveState, ctx: ExtensionContext) {
  if (!live.active || !live.skillRoot) return;
  startIndicator(live, ctx);
  if (live.poll) return;
  const cwd = live.cwd ?? ctx.cwd;
  const child = spawn(
    process.execPath,
    [script(live.skillRoot, 'live-poll.mjs')],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  live.poll = child;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  child.on('close', (code) => {
    if (live.poll !== child) return;
    live.poll = undefined;
    if (!live.active) return;
    if (code !== 0) {
      live.pausedFor = 'poll-error';
      renderIndicator(live, ctx);
      display(pi, `Impeccable live poll failed:\n\n${stderr || stdout}`);
      ctx.ui.notify(
        'Impeccable live poll failed; run /impeccable live to resume.',
        'warning',
      );
      return;
    }
    const event = asLiveEvent(parseJson(stdout));
    if (!event) {
      live.pausedFor = 'parse-error';
      renderIndicator(live, ctx);
      display(
        pi,
        `Could not parse Impeccable live event:\n\n${stdout}\n${stderr}`,
      );
      return;
    }
    handleLiveEvent(pi, live, ctx, event, stderr);
  });
}

function handleLiveEvent(
  pi: ExtensionAPI,
  live: LiveState,
  ctx: ExtensionContext,
  event: LiveEventData,
  stderr: string,
) {
  live.lastEvent = event;
  if (event.type === 'timeout') return startPoll(pi, live, ctx);
  if (event.type === 'exit') {
    live.active = false;
    stopIndicator(live, ctx);
    ctx.ui.notify('Impeccable live exited.', 'info');
    return;
  }
  if (event.type === 'prefetch') return startPoll(pi, live, ctx);

  const needsAgent =
    agentReplyEvents.has(event.type) ||
    event?._acceptResult?.carbonize === true ||
    event?._completionAck?.ok === false;
  if (!needsAgent) {
    ctx.ui.notify(`Impeccable live: ${event.type}`, 'info');
    return startPoll(pi, live, ctx);
  }

  const skillRoot = live.skillRoot;
  if (!skillRoot) return;
  live.pausedFor = event.id ?? event.type;
  sendLiveEvent(
    pi,
    ctx,
    liveEventPrompt(event, stderr, skillRoot),
    event,
    live.delivery,
  );
}

function liveEventPrompt(
  event: LiveEventData,
  stderr: string,
  skillRoot: string,
) {
  const isCarbonize =
    event?._acceptResult?.carbonize === true ||
    event?._completionAck?.ok === false;
  const next = isCarbonize
    ? `After cleanup, call impeccable_live_complete with id ${JSON.stringify(event.id)}. Do not poll manually.`
    : `After handling the event, call impeccable_live_reply with id ${JSON.stringify(event.id)} and the correct status. Do not reply with bash.`;
  return [
    'Impeccable live event arrived from the background poll.',
    pathContract(skillRoot),
    `Read the live reference if it is not already loaded: ${join(skillRoot, 'reference', 'live.md')}`,
    stderr.trim() ? `Poll stderr:\n${stderr.trim()}` : '',
    'Event JSON:',
    `\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``,
    next,
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function pinCommand(
  pi: ExtensionAPI,
  pinnedCommandNames: Set<string>,
  ctx: ExtensionContext,
  tokens: string[],
) {
  const command = tokens[0] ?? '';
  if (!command) {
    return display(pi, 'Usage: /impeccable pin <upstream-command>');
  }
  if (!isSafeCommandName(command) || !isAgentCommand(command)) {
    return notifyOrDisplay(
      pi,
      ctx,
      `Cannot pin ${command || 'empty command'}; choose an upstream Impeccable command.`,
      'warning',
    );
  }
  const file = pinnedCommandPath(ctx.cwd, command);
  if (hasCommandFileConflict(ctx.cwd, command)) {
    return notifyOrDisplay(
      pi,
      ctx,
      `Cannot overwrite existing OMP command file: ${file}`,
      'warning',
    );
  }
  if (hasCommandConflict(pi, ctx.cwd, command, pinnedCommandNames)) {
    return notifyOrDisplay(
      pi,
      ctx,
      `Cannot pin /${command}; an OMP slash command with that name already exists.`,
      'warning',
    );
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, pinnedCommandContent(command));
  registerPinnedCommand(pi, pinnedCommandNames, command);
  return notifyOrDisplay(
    pi,
    ctx,
    `Pinned /${command} to /impeccable ${command} in .omp/commands/${command}.md.`,
  );
}

function unpinCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  tokens: string[],
) {
  const command = tokens[0] ?? '';
  if (!command) {
    return display(pi, 'Usage: /impeccable unpin <upstream-command>');
  }
  if (!isSafeCommandName(command)) {
    return notifyOrDisplay(
      pi,
      ctx,
      `Invalid pinned command: ${command}`,
      'warning',
    );
  }

  const file = pinnedCommandPath(ctx.cwd, command);
  if (!existsSync(file)) {
    return notifyOrDisplay(pi, ctx, `/${command} is not pinned.`, 'info');
  }
  if (!isPinnedCommandFile(file, command)) {
    return notifyOrDisplay(
      pi,
      ctx,
      `Refusing to remove non-omp-impeccable command file: ${file}`,
      'warning',
    );
  }

  rmSync(file);
  return notifyOrDisplay(
    pi,
    ctx,
    `Removed .omp/commands/${command}.md. Reload OMP to remove /${command} from autocomplete.`,
  );
}

function explainHooksCommand(pi: ExtensionAPI, ctx: ExtensionContext) {
  return notifyOrDisplay(
    pi,
    ctx,
    'The upstream /impeccable hooks command installs provider-specific hook manifests. omp-impeccable does not install those; use /impeccable live for OMP-native design feedback.',
    'info',
  );
}

function registerPinnedCommands(
  pi: ExtensionAPI,
  pinnedCommandNames: Set<string>,
  cwd: string,
  { checkConflicts = true }: { checkConflicts?: boolean } = {},
) {
  for (const command of pinnedCommands(cwd)) {
    if (
      checkConflicts &&
      hasCommandConflict(pi, cwd, command, pinnedCommandNames)
    )
      continue;
    registerPinnedCommand(pi, pinnedCommandNames, command);
  }
}

function registerPinnedCommand(
  pi: ExtensionAPI,
  pinnedCommandNames: Set<string>,
  command: string,
) {
  if (pinnedCommandNames.has(command)) return;
  pinnedCommandNames.add(command);
  pi.registerCommand(command, {
    description: pinnedCommandDescription(command),
    handler: async (args, ctx) => {
      if (!isPinnedCommand(ctx.cwd, command)) {
        return notifyOrDisplay(
          pi,
          ctx,
          `/${command} is not pinned in this project. Run /impeccable pin ${command} to restore it.`,
          'warning',
        );
      }
      showTransientStatus(ctx, `${command} queued`);
      const skillRoot = await ensureSkill(pi, ctx);
      if (!skillRoot) return;
      const invocation = [command, args.trim()].filter(Boolean).join(' ');
      sendExtensionPrompt(
        pi,
        ctx,
        commandPrompt(invocation, skillRoot),
        'followUp',
      );
    },
  });
}

function pinnedCommandDescription(command: string) {
  return `Run /impeccable ${command} through omp-impeccable`;
}

function pinnedCommands(cwd: string) {
  const commandsDir = join(projectRoot(cwd), '.omp', 'commands');
  try {
    return readdirSync(commandsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -'.md'.length))
      .filter(
        (command) =>
          isSafeCommandName(command) &&
          isPinnedCommandFile(join(commandsDir, `${command}.md`), command),
      );
  } catch {
    return [];
  }
}

function hasCommandConflict(
  pi: ExtensionAPI,
  cwd: string,
  command: string,
  pinnedCommandNames: ReadonlySet<string>,
) {
  const hasRegisteredPinnedCommand = pinnedCommandNames.has(command);
  const hasManagedPinnedFile = isPinnedCommand(cwd, command);
  const knownPinnedCommand = hasRegisteredPinnedCommand || hasManagedPinnedFile;
  if (hasCommandFileConflict(cwd, command)) return true;

  const commandFile = pinnedCommandPath(cwd, command);
  const commands = pi.getCommands();
  return commands.some((candidate) => {
    if (candidate.name !== command) return false;
    if (!knownPinnedCommand) return true;
    if (
      candidate.source === 'extension' &&
      hasRegisteredPinnedCommand &&
      candidate.description === pinnedCommandDescription(command)
    )
      return false;
    if (
      candidate.source === 'prompt' &&
      candidate.path &&
      hasManagedPinnedFile &&
      resolve(candidate.path) === resolve(commandFile)
    )
      return false;
    return true;
  });
}

function hasCommandFileConflict(cwd: string, command: string) {
  const file = pinnedCommandPath(cwd, command);
  return existsSync(file) && !isPinnedCommandFile(file, command);
}

function isPinnedCommand(cwd: string, command: string) {
  return (
    isSafeCommandName(command) &&
    isPinnedCommandFile(pinnedCommandPath(cwd, command), command)
  );
}

function isPinnedCommandFile(file: string, command: string) {
  try {
    const content = readFileSync(file, 'utf8');
    return (
      content.includes('managed-by: omp-impeccable') &&
      content.includes(`impeccable-command: ${command}`)
    );
  } catch {
    return false;
  }
}

function pinnedCommandPath(cwd: string, command: string) {
  return join(projectRoot(cwd), '.omp', 'commands', `${command}.md`);
}

function isSafeCommandName(command: string) {
  if (command.length === 0 || command.length > 63) return false;
  if (!isLowerAsciiLetter(command.charCodeAt(0))) return false;

  for (let index = 1; index < command.length; index += 1) {
    const charCode = command.charCodeAt(index);
    if (
      !isLowerAsciiLetter(charCode) &&
      !isAsciiDigit(charCode) &&
      command[index] !== '_' &&
      command[index] !== '-'
    ) {
      return false;
    }
  }

  return true;
}

function isLowerAsciiLetter(charCode: number) {
  return charCode >= 97 && charCode <= 122;
}

function isAsciiDigit(charCode: number) {
  return charCode >= 48 && charCode <= 57;
}

function pinnedCommandContent(command: string) {
  return `---
description: Run /impeccable ${command} through omp-impeccable
managed-by: omp-impeccable
impeccable-command: ${command}
---
Handle this Impeccable invocation in OMP: /impeccable ${command} $ARGUMENTS

The omp-impeccable extension handles /${command} directly when loaded. This file keeps a native OMP command placeholder and safe fallback prompt.
`;
}

function commandPrompt(args: string, skillRoot: string) {
  return [
    `Handle this Impeccable invocation in OMP: /impeccable ${args.trim()}`,
    pathContract(skillRoot),
    `Start by reading ${join(skillRoot, 'SKILL.md')}.`,
    'If a sub-command is invoked, read the matching reference file from that skill root before acting.',
  ].join('\n\n');
}

function pathContract(skillRoot: string) {
  return [
    'Use the Impeccable files installed by the upstream Impeccable package, not vendored extension files.',
    `Skill root: ${skillRoot}`,
    `Scripts: ${join(skillRoot, 'scripts')}`,
    'Whenever upstream Impeccable docs mention `node .agents/skills/impeccable/scripts/...`, run the matching script from `Scripts` instead.',
  ].join('\n');
}

function isForegroundLivePoll(command: string) {
  if (command.includes('--reply')) return false;
  return (
    /live-poll\.mjs\b/.test(command) ||
    /\b(?:npx\s+[^\n;]*\s+)?impeccable\s+poll\b/.test(command)
  );
}

function readDelivery(tokens: string[]): Delivery | undefined {
  const value = option(tokens, 'delivery');
  if (value === 'followUp' || value === 'followup') return 'followUp';
  if (value === 'steer') return 'steer';
  if (tokens.includes('--follow-up')) return 'followUp';
  return undefined;
}

function option(tokens: string[], name: string) {
  const prefix = `--${name}=`;
  const inline = tokens.find((token) => token.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const idx = tokens.indexOf(`--${name}`);
  return idx >= 0 ? tokens[idx + 1] : undefined;
}

function tokenize(input: string) {
  return (input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) =>
    token.replace(/^(["'])(.*)\1$/, '$2'),
  );
}

export function summarizeLiveStatus(output: string) {
  const status = parseJson(output);
  if (!status || typeof status !== 'object')
    return output || 'No Impeccable live status.';
  const liveServer = (status as { liveServer?: unknown }).liveServer;
  const sessions = Array.isArray(
    (status as { activeSessions?: unknown }).activeSessions,
  )
    ? (
        status as {
          activeSessions: Array<{
            phase?: unknown;
            pageUrl?: unknown;
            sourceFile?: unknown;
          }>;
        }
      ).activeSessions
    : [];
  const server = liveServer ? 'server running' : 'server stopped';
  if (sessions.length === 0)
    return `Impeccable live: ${server} · no active sessions`;
  const first = sessions[0];
  const phase =
    typeof first?.phase === 'string'
      ? first.phase.replace(/_/g, ' ')
      : 'active';
  const target =
    typeof first?.sourceFile === 'string'
      ? first.sourceFile
      : typeof first?.pageUrl === 'string'
        ? first.pageUrl
        : 'session';
  const more = sessions.length > 1 ? ` · +${sessions.length - 1} more` : '';
  return `Impeccable live: ${server} · ${phase} · ${target}${more}`;
}

function isAgentCommand(command: string) {
  return (agentCommands as readonly string[]).includes(command);
}

function completions(prefix: string, cwd = process.cwd()) {
  const trimmedStart = prefix.trimStart();
  if (/\s/.test(trimmedStart)) return null;
  const descriptions = installedCommandDescriptions(cwd);
  const commands = [...extensionCommandDescriptions.keys(), ...agentCommands];
  const matches = commands.filter((command) =>
    command.startsWith(trimmedStart),
  );
  return matches.length
    ? matches.map((value) => {
        const description =
          descriptions.get(value) ??
          extensionCommandDescriptions.get(value) ??
          fallbackAgentCommandDescriptions.get(value);
        return description
          ? { value, label: value, description }
          : { value, label: value };
      })
    : null;
}

function installedCommandDescriptions(cwd: string) {
  const skillRoot = locateSkill(cwd);
  if (!skillRoot) return new Map<string, string>();

  try {
    return parseCommandMetadata(
      readFileSync(join(skillRoot, 'scripts', 'command-metadata.json'), 'utf8'),
    );
  } catch {
    return new Map<string, string>();
  }
}

export function parseCommandMetadata(json: string) {
  const parsed: unknown = JSON.parse(json);
  const descriptions = new Map<string, string>();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return descriptions;

  for (const [command, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const description = (entry as { description?: unknown }).description;
    if (typeof description !== 'string' || !description.trim()) continue;
    descriptions.set(command, cleanDescription(description));
  }

  return descriptions;
}

function cleanDescription(description: string) {
  return description
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

let transientStatusTimer: ReturnType<typeof setTimeout> | undefined;

function sendExtensionPrompt(
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
  text: string,
  delivery: Delivery,
) {
  const options = ctx?.isIdle()
    ? { triggerTurn: true }
    : { triggerTurn: true, deliverAs: delivery };
  pi.sendMessage(
    {
      customType: 'impeccable-command',
      content: text,
      display: false,
      details: undefined,
      attribution: undefined,
    },
    options,
  );
}

function sendLiveEvent(
  pi: ExtensionAPI,
  ctx: ExtensionContext | undefined,
  text: string,
  event: LiveEventData,
  delivery: Delivery,
) {
  ctx?.ui.notify(
    `Impeccable live: ${event.type}${event.action ? ` ${event.action}` : ''}`,
    'info',
  );
  const options = ctx?.isIdle()
    ? { triggerTurn: true }
    : { triggerTurn: true, deliverAs: delivery };
  pi.sendMessage(
    {
      customType: 'impeccable-live',
      content: text,
      display: false,
      details: undefined,
      attribution: undefined,
    },
    options,
  );
}

function notifyOrDisplay(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  content: string,
  type: 'info' | 'warning' | 'error' = 'info',
) {
  if (ctx.hasUI) ctx.ui.notify(content, type);
  else display(pi, content);
}

function display(pi: ExtensionAPI, content: string) {
  pi.sendMessage({
    customType: 'impeccable',
    content,
    display: true,
    details: undefined,
    attribution: undefined,
  });
}

function clearTransientStatus(ctx?: ExtensionContext) {
  if (transientStatusTimer) clearTimeout(transientStatusTimer);
  transientStatusTimer = undefined;
  ctx?.ui.setStatus('impeccable-transient', undefined);
}

function showTransientStatus(ctx: ExtensionContext, text: string) {
  if (!ctx.hasUI) return;
  clearTransientStatus(ctx);
  ctx.ui.setStatus('impeccable-transient', `✦ impeccable ${text}`);
  transientStatusTimer = setTimeout(() => {
    transientStatusTimer = undefined;
    ctx.ui.setStatus('impeccable-transient', undefined);
  }, 3500);
  transientStatusTimer.unref?.();
}

function killPoll(live: LiveState) {
  if (!live.poll) return;
  live.poll.kill('SIGTERM');
  live.poll = undefined;
}

function startIndicator(live: LiveState, ctx: ExtensionContext) {
  renderIndicator(live, ctx);
}

function stopIndicator(_live: LiveState, ctx?: ExtensionContext) {
  ctx?.ui.setStatus('impeccable', undefined);
}

function renderIndicator(live: LiveState, ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  if (!live.active) return stopIndicator(live, ctx);
  const label = (state: 'live' | 'event' | 'error') => `✦ impeccable ${state}`;
  if (live.pausedFor === 'poll-error' || live.pausedFor === 'parse-error') {
    ctx.ui.setStatus('impeccable', label('error'));
    return;
  }
  if (live.pausedFor) {
    ctx.ui.setStatus('impeccable', label('event'));
    return;
  }
  ctx.ui.setStatus('impeccable', label('live'));
}

// Files, processes, and JSON.
function locateSkill(cwd: string) {
  const candidates = [
    projectOmpSkillRoot(cwd),
    join(cwd, '.omp', 'skills', 'impeccable'),
    join(homedir(), '.omp', 'agent', 'skills', 'impeccable'),
    projectAgentsSkillRoot(cwd),
    join(cwd, '.agents', 'skills', 'impeccable'),
    join(homedir(), '.agents', 'skills', 'impeccable'),
  ];
  return [...new Set(candidates)].find(isSkillRoot);
}

function ensureProjectOmpSkill(cwd: string) {
  const skillRoot = projectOmpSkillRoot(cwd);
  if (isSkillRoot(skillRoot)) return skillRoot;
  const legacyRoot = projectAgentsSkillRoot(cwd);
  if (isSkillRoot(legacyRoot)) return replaceProjectOmpSkill(legacyRoot, cwd);
}

async function installProjectOmpSkill(cwd: string) {
  const stagingRoot = mkdtempSync(join(tmpdir(), 'omp-impeccable-install-'));
  try {
    mkdirSync(join(stagingRoot, '.git'));
    const result = await runImpeccable(
      [
        'install',
        '--providers=codex',
        '--scope=project',
        '-y',
        '--no-hooks',
        '--force',
      ],
      stagingRoot,
      undefined,
      120_000,
    );
    const skillRoot =
      result.code === 0
        ? replaceProjectOmpSkill(
            join(stagingRoot, '.agents', 'skills', 'impeccable'),
            cwd,
          )
        : undefined;
    return { result, skillRoot };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function replaceProjectOmpSkill(source: string, cwd: string) {
  if (!isSkillRoot(source)) return undefined;

  const dest = projectOmpSkillRoot(cwd);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(source, dest, { recursive: true });
  rewriteSkillRootReferences(dest);
  if (!isSkillRoot(dest)) return undefined;
  return dest;
}

function rewriteSkillRootReferences(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteSkillRootReferences(path);
      continue;
    }
    if (!entry.isFile() || !isTextSkillFile(entry.name)) continue;

    const content = readFileSync(path, 'utf8');
    const next = content.replaceAll(
      '.agents/skills/impeccable',
      '.omp/skills/impeccable',
    );
    if (next !== content) writeFileSync(path, next);
  }
}

const textSkillExtensions = new Set([
  '.js',
  '.json',
  '.md',
  '.mdx',
  '.mjs',
  '.txt',
  '.ts',
  '.yaml',
  '.yml',
]);

function isTextSkillFile(file: string) {
  return textSkillExtensions.has(extname(file));
}

function projectOmpSkillRoot(cwd: string) {
  return join(projectRoot(cwd), '.omp', 'skills', 'impeccable');
}

function projectAgentsSkillRoot(cwd: string) {
  return join(projectRoot(cwd), '.agents', 'skills', 'impeccable');
}

function isSkillRoot(dir: string) {
  return existsSync(join(dir, 'SKILL.md')) && existsSync(join(dir, 'scripts'));
}

function projectRoot(cwd: string) {
  let dir = resolve(cwd);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    dir = dirname(dir);
  }
  return resolve(cwd);
}

function script(skillRoot: string, name: string) {
  return join(skillRoot, 'scripts', name);
}

function resolveImpeccableCli() {
  try {
    let current = dirname(require.resolve('impeccable'));
    while (current !== dirname(current)) {
      const candidate = join(current, 'package.json');
      if (existsSync(candidate)) {
        const cli = join(current, 'cli', 'bin', 'cli.js');
        if (existsSync(cli)) return cli;
      }
      current = dirname(current);
    }
  } catch {
    /* dependency absent in local dev; use npx */
  }
  return null;
}

function runImpeccable(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
) {
  const cli = resolveImpeccableCli();
  return cli
    ? runProcess(process.execPath, [cli, ...args], cwd, signal, timeoutMs)
    : runProcess(
        'npx',
        ['-y', 'impeccable@latest', ...args],
        cwd,
        signal,
        timeoutMs,
      );
}

function runNode(
  scriptPath: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
) {
  return runProcess(
    process.execPath,
    [scriptPath, ...args],
    cwd,
    signal,
    timeoutMs,
  );
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = 30_000,
) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolvePromise) => {
      const child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk) => (stdout += String(chunk)));
      child.stderr.on('data', (chunk) => (stderr += String(chunk)));
      child.on('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolvePromise({ stdout, stderr: stderr || error.message, code: 1 });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolvePromise({ stdout, stderr, code });
      });
    },
  );
}

function parseJson(output: string): unknown {
  const text = output.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* try extracting a JSON object below */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* not a JSON object */
    }
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* try previous line */
    }
  }
  return null;
}

function asLiveEvent(value: unknown): LiveEventData | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const event = value as { type?: unknown };
  if (typeof event.type !== 'string') return undefined;
  return value as LiveEventData;
}

// Types and static data.
const require = createRequire(import.meta.url);

type Delivery = 'steer' | 'followUp';

type LiveState = {
  active: boolean;
  cwd?: string;
  skillRoot?: string;
  delivery: Delivery;
  poll?: ChildProcessByStdio<null, Readable, Readable>;
  pausedFor?: string;
  lastEvent?: unknown;
};

type LiveEventData = {
  type: string;
  id?: string;
  action?: string;
  _acceptResult?: { carbonize?: boolean };
  _completionAck?: { ok?: boolean };
  [key: string]: unknown;
};

const agentReplyEvents = new Set(['generate', 'steer', 'manual_edit_apply']);
