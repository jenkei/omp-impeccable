import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ExtensionAPI,
  ExtensionContext,
  RegisteredCommand,
  ToolDefinition,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import { describe, expect, onTestFinished, test } from 'vitest';

import impeccableExtension, {
  parseCommandMetadata,
  summarizeLiveStatus,
} from '../extensions/impeccable.ts';

const root = path.resolve(import.meta.dirname, '..');

describe('impeccable extension', () => {
  test('package exposes the OMP extensions without vendoring Impeccable', () => {
    const pkg = readPackageJson();

    expect(pkg.omp.extensions).toEqual(['./extensions/impeccable.ts']);
    expect(pkg.dependencies.impeccable).toBe('*');
    for (const excluded of [
      '.omp/skills',
      '.agents/skills',
      '.github/skills',
      'vendor',
    ]) {
      expect(pkg.files).not.toContain(excluded);
    }
  });

  test('help renders OMP-native command usage', async () => {
    const harness = loadExtension();
    const ctx = makeContext(root);

    await runCommand(harness, 'help', ctx);

    const help = harness.messages.find(
      (entry) => entry.message.customType === 'impeccable',
    );
    expect(help?.message.content ?? '').toMatch(
      /Usage:\n\/impeccable <command>/,
    );
    expect(help?.message.content ?? '').toContain('/impeccable hooks');
    expect(help?.message.content ?? '').toContain('OMP commands:');
    expect(help?.message.content ?? '').toContain('does not vendor Impeccable');
  });

  test('resources_discover publishes the installed project OMP skill path', async () => {
    const { project, skillRoot } = makeProject();
    const legacySkillRoot = path.join(
      project,
      '.agents',
      'skills',
      'impeccable',
    );
    fs.mkdirSync(path.join(legacySkillRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(legacySkillRoot, 'SKILL.md'),
      '# legacy impeccable\n',
    );
    const nested = path.join(project, 'src', 'pages');
    fs.mkdirSync(nested, { recursive: true });
    const harness = loadExtension();

    const result = await harness.emit<ResourcesDiscoverResult>(
      'resources_discover',
      { cwd: nested },
    );

    expect(skillRoot).toBe(path.join(project, '.omp', 'skills', 'impeccable'));
    expect(result).toEqual({ skillPaths: [skillRoot] });
    expect(result?.skillPaths).not.toContain(legacySkillRoot);
  });

  test('agent commands copy a legacy project .agents skill into .omp', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-impeccable-'));
    const legacySkillRoot = path.join(
      project,
      '.agents',
      'skills',
      'impeccable',
    );
    const skillRoot = path.join(project, '.omp', 'skills', 'impeccable');
    fs.mkdirSync(path.join(project, '.git'));
    fs.mkdirSync(path.join(legacySkillRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(legacySkillRoot, 'SKILL.md'),
      'Run `node .agents/skills/impeccable/scripts/live-poll.mjs`.\n',
    );
    onTestFinished(() => fs.rmSync(project, { recursive: true, force: true }));
    const harness = loadExtension();
    const ctx = makeContext(project, { idle: false });

    await runCommand(harness, 'audit src/App.tsx', ctx);

    expect(fs.existsSync(path.join(skillRoot, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(legacySkillRoot)).toBe(true);
    expect(fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8')).toContain(
      '.omp/skills/impeccable/scripts/live-poll.mjs',
    );
    expect(harness.messages[0]?.message.content).toMatch(
      new RegExp(escapeRegExp(skillRoot)),
    );
  });

  test('argument completions prefer installed command metadata', async () => {
    const { project, skillRoot } = makeProject();
    fs.writeFileSync(
      path.join(skillRoot, 'SKILL.md'),
      `
| Command | Category | Description | Reference |
|---|---|---|---|
| \`craft [feature]\` | Build | Short table description | [reference/craft.md](reference/craft.md) |
`,
    );
    fs.writeFileSync(
      path.join(skillRoot, 'scripts', 'command-metadata.json'),
      JSON.stringify({
        craft: {
          description:
            'Full metadata description with `code` and **emphasis**.',
        },
      }),
    );

    const descriptions = parseCommandMetadata(
      fs.readFileSync(
        path.join(skillRoot, 'scripts', 'command-metadata.json'),
        'utf8',
      ),
    );
    expect(descriptions.get('craft')).toBe(
      'Full metadata description with code and emphasis.',
    );

    const harness = loadExtension();
    await harness.emit('session_start', {}, makeContext(project));

    const [craft] = await argumentCompletions(harness, 'cr');

    expect(craft?.description).toBe(
      'Full metadata description with code and emphasis.',
    );
  });

  test('argument completions include fallback descriptions before skill install', async () => {
    const project = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omp-impeccable-no-skill-'),
    );
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-impeccable-home-'));
    const oldHome = process.env.HOME;
    fs.mkdirSync(path.join(project, '.git'));
    process.env.HOME = home;
    onTestFinished(() => {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      fs.rmSync(project, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });

    const harness = loadExtension();
    await harness.emit('session_start', {}, makeContext(project));

    const craft = (await argumentCompletions(harness, 'cr')).find(
      ({ value }) => value === 'craft',
    );
    const hooks = (await argumentCompletions(harness, 'ho')).find(
      ({ value }) => value === 'hooks',
    );

    expect(craft?.description).toMatch(/confirmed-brief-then-build/);
    expect(hooks?.description).toMatch(/upstream hook manifests/);
  });

  test('pin creates an OMP command shortcut handled by the extension', async () => {
    const { project, skillRoot } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project, { idle: false });

    await runCommand(harness, 'pin audit', ctx);
    await runCommand(harness, 'pin audit', ctx);
    await harness.commands.get('audit')?.handler('src/App.tsx', ctx);

    const shortcut = fs.readFileSync(
      path.join(project, '.omp', 'commands', 'audit.md'),
      'utf8',
    );
    const [entry] = harness.messages;

    expect(shortcut).toContain('managed-by: omp-impeccable');
    expect(shortcut).toContain('impeccable-command: audit');
    expect(shortcut).toContain('$ARGUMENTS');
    expect(entry?.message.customType).toBe('impeccable-command');
    expect(entry?.message.content).toMatch(
      /Handle this Impeccable invocation in OMP: \/impeccable audit src\/App\.tsx/,
    );
    expect(entry?.message.content).toMatch(new RegExp(escapeRegExp(skillRoot)));
  });

  test('pin resolves OMP command shortcuts from the project root', async () => {
    const { project, skillRoot } = makeProject();
    const nested = path.join(project, 'src', 'pages');
    fs.mkdirSync(nested, { recursive: true });
    const ctx = makeContext(nested, { idle: false });

    await runCommand(loadExtension(), 'pin audit', ctx);

    const shortcut = path.join(project, '.omp', 'commands', 'audit.md');
    expect(fs.existsSync(shortcut)).toBe(true);
    expect(
      fs.existsSync(path.join(nested, '.omp', 'commands', 'audit.md')),
    ).toBe(false);

    const oldCwd = process.cwd();
    onTestFinished(() => process.chdir(oldCwd));
    process.chdir(nested);
    const harness = loadExtension();
    expect(harness.commands.has('audit')).toBe(true);
    await harness.commands.get('audit')?.handler('src/App.tsx', ctx);

    const [entry] = harness.messages;
    expect(entry?.message.customType).toBe('impeccable-command');
    expect(entry?.message.content).toMatch(
      /Handle this Impeccable invocation in OMP: \/impeccable audit src\/App\.tsx/,
    );
    expect(entry?.message.content).toMatch(new RegExp(escapeRegExp(skillRoot)));
  });

  test('factory restore does not require initialized getCommands', () => {
    const { project } = makeProject();
    const nested = path.join(project, 'src', 'pages');
    const auditFile = path.join(project, '.omp', 'commands', 'audit.md');
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      auditFile,
      `---
description: Run /impeccable audit through omp-impeccable
managed-by: omp-impeccable
impeccable-command: audit
---
`,
    );
    const oldCwd = process.cwd();
    onTestFinished(() => process.chdir(oldCwd));
    process.chdir(nested);

    const harness = loadExtension([], { getCommandsUnavailable: true });

    expect(harness.commands.has('audit')).toBe(true);
  });

  test('pin refuses slash commands owned by another extension', async () => {
    const { project } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project);
    harness.commands.set('audit', {
      description: 'Run another extension audit command',
      handler: () => undefined,
    });

    await runCommand(harness, 'pin audit', ctx);

    expect(ctx.ui.notifications.at(-1)).toEqual({
      message:
        'Cannot pin /audit; an OMP slash command with that name already exists.',
      type: 'warning',
    });
    expect(
      fs.existsSync(path.join(project, '.omp', 'commands', 'audit.md')),
    ).toBe(false);
  });

  test('pin refuses a pre-existing non-managed OMP command file', async () => {
    const { project } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project);
    const file = path.join(project, '.omp', 'commands', 'audit.md');
    const existing = `---
description: Existing audit command
---
Existing /audit command
`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, existing);

    await runCommand(harness, 'pin audit', ctx);

    expect(ctx.ui.notifications.at(-1)).toEqual({
      message: `Cannot overwrite existing OMP command file: ${file}`,
      type: 'warning',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(existing);
    expect(harness.commands.has('audit')).toBe(false);
  });

  test('pin accepts its managed OMP command file on reload', async () => {
    const { project } = makeProject();
    const ctx = makeContext(project);
    const file = path.join(project, '.omp', 'commands', 'audit.md');

    await runCommand(loadExtension(), 'pin audit', ctx);

    const harness = loadExtension([
      {
        name: 'audit',
        description: 'Run /impeccable audit through omp-impeccable',
        source: 'prompt',
        location: 'project',
        path: file,
      },
    ]);
    await harness.emit('session_start', {}, ctx);
    expect(harness.commands.has('audit')).toBe(true);

    await runCommand(harness, 'pin audit', ctx);

    expect(ctx.ui.notifications.at(-1)).toEqual({
      message: 'Pinned /audit to /impeccable audit in .omp/commands/audit.md.',
      type: 'info',
    });
  });

  test('restore skips non-managed command sources and command files', async () => {
    const { project } = makeProject();
    const ctx = makeContext(project);
    const auditFile = path.join(project, '.omp', 'commands', 'audit.md');
    const craftFile = path.join(project, '.omp', 'commands', 'craft.md');
    const foreignAuditFile = path.join(
      project,
      '.omp',
      'commands',
      'foreign-audit.md',
    );

    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.writeFileSync(
      auditFile,
      `---
description: Run /impeccable audit through omp-impeccable
managed-by: omp-impeccable
impeccable-command: audit
---
`,
    );
    fs.writeFileSync(
      craftFile,
      `---
description: Existing craft command
---
Existing /craft command
`,
    );
    fs.writeFileSync(
      foreignAuditFile,
      `---
description: Existing audit command
---
Existing /audit command
`,
    );

    const harness = loadExtension([
      {
        name: 'audit',
        description: 'Run an existing prompt audit command',
        source: 'prompt',
        location: 'project',
        path: foreignAuditFile,
      },
    ]);

    await harness.emit('session_start', {}, ctx);

    expect(harness.commands.has('audit')).toBe(false);
    expect(harness.commands.has('craft')).toBe(false);
    expect(harness.messages).toHaveLength(0);
  });

  test('hooks explains OMP-native live mode instead of installing upstream hook manifests', async () => {
    const { project } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project);

    await runCommand(harness, 'hooks', ctx);

    expect(ctx.ui.notifications.at(-1)).toEqual({
      message:
        'The upstream /impeccable hooks command installs provider-specific hook manifests. omp-impeccable does not install those; use /impeccable live for OMP-native design feedback.',
      type: 'info',
    });
  });

  test('agent commands are queued as hidden extension messages', async () => {
    const { project, skillRoot } = makeProject();
    const harness = loadExtension();
    const ctx = makeContext(project, { idle: false });

    await runCommand(harness, 'audit src/App.tsx', ctx);

    const [entry] = harness.messages;
    expect(harness.messages).toHaveLength(1);
    expect(entry?.message.customType).toBe('impeccable-command');
    expect(entry?.message.display).toBe(false);
    expect(entry?.options?.deliverAs).toBe('followUp');
    expect(entry?.message.content).toMatch(
      /Handle this Impeccable invocation in OMP: \/impeccable audit src\/App\.tsx/,
    );
    expect(entry?.message.content).toMatch(new RegExp(escapeRegExp(skillRoot)));
    expect(entry?.message.content).toContain('not vendored extension files');
    expect(
      ctx.ui.statuses.some(
        (status) => status.value === '✦ impeccable audit queued',
      ),
    ).toBe(true);
    await harness.emit('session_shutdown', {}, ctx);
  });

  test('live status runs the installed script and summarizes JSON', async () => {
    const status: LiveStatus = {
      liveServer: { pid: 123 },
      activeSessions: [
        { phase: 'design_pass', sourceFile: 'src/App.tsx' },
        { phase: 'review', pageUrl: 'http://localhost:3000' },
      ],
    };
    const { project } = makeProject({
      'live-status.mjs': `console.log(${JSON.stringify(JSON.stringify(status))});\n`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project);

    await runCommand(harness, 'live status', ctx);

    expect(ctx.ui.notifications.at(-1)).toEqual({
      message:
        'Impeccable live: server running · design pass · src/App.tsx · +1 more',
      type: 'info',
    });
  });

  test('live mode sends browser events as hidden messages and does not foreground-poll', async () => {
    const event: LiveEvent = {
      type: 'generate',
      id: 'evt-1',
      prompt: 'Make the hero sharper',
    };
    const { project, skillRoot } = makeProject({
      'live.mjs': 'console.log(JSON.stringify({ ok: true }));\n',
      'live-poll.mjs': `console.log(${JSON.stringify(JSON.stringify(event))});\n`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project, { idle: false });

    await runCommand(harness, 'live --delivery=followUp', ctx);
    expect(
      ctx.ui.statuses.some(
        (status) =>
          status.key === 'impeccable' && status.value === '✦ impeccable live',
      ),
    ).toBe(true);
    await waitFor(
      () =>
        harness.messages.some(
          (entry) => entry.message.customType === 'impeccable-live',
        ),
      'expected a hidden live event message',
    );
    await harness.emit('session_shutdown', {}, ctx);

    const liveMessage = harness.messages.find(
      (entry) => entry.message.customType === 'impeccable-live',
    );
    expect(liveMessage?.message.display).toBe(false);
    expect(liveMessage?.options?.deliverAs).toBe('followUp');
    expect(liveMessage?.message.content).toMatch(
      /Impeccable live event arrived from the background poll/,
    );
    expect(liveMessage?.message.content).toMatch(
      /call impeccable_live_reply with id "evt-1"/,
    );
    expect(liveMessage?.message.content).toContain(
      `Scripts: ${path.join(skillRoot, 'scripts')}`,
    );
    expect(
      ctx.ui.notifications.find((note) => /live started/.test(note.message)),
    ).toEqual({
      message:
        'Impeccable live started. Say stop live or /impeccable stop to stop.',
      type: 'info',
    });
  });

  test('session shutdown stops live server and ignores killed polls', async () => {
    const stopArgs = path.join(
      os.tmpdir(),
      `omp-impeccable-stop-${process.pid}.json`,
    );
    onTestFinished(() => fs.rmSync(stopArgs, { force: true }));
    const { project } = makeProject({
      'live.mjs': 'console.log(JSON.stringify({ ok: true }));\n',
      'live-poll.mjs': `setTimeout(() => console.log(JSON.stringify({ type: 'generate', id: 'late' })), 5000);\n`,
      'live-server.mjs': `
        import fs from 'node:fs';
        if (process.argv.includes('stop')) fs.writeFileSync(${JSON.stringify(stopArgs)}, JSON.stringify(process.argv.slice(2)));
      `,
    });
    const harness = loadExtension();
    const ctx = makeContext(project);

    await runCommand(harness, 'live', ctx);
    await harness.emit('session_shutdown', {}, ctx);
    await delay(50);

    expect(JSON.parse(fs.readFileSync(stopArgs, 'utf8'))).toEqual(['stop']);
    expect(harness.messages).toEqual([]);
    expect(
      ctx.ui.notifications.some((note) => /poll failed/.test(note.message)),
    ).toBe(false);
  });

  test('foreground live-poll bash calls are blocked', async () => {
    const harness = loadExtension();
    const ctx = makeContext(root);

    const blocked = await harness.emit<ToolCallResult>(
      'tool_call',
      {
        toolName: 'bash',
        input: {
          command: 'node .omp/skills/impeccable/scripts/live-poll.mjs',
        },
      },
      ctx,
    );
    const reply = await harness.emit<ToolCallResult>(
      'tool_call',
      {
        toolName: 'bash',
        input: {
          command:
            'node .omp/skills/impeccable/scripts/live-poll.mjs --reply evt done',
        },
      },
      ctx,
    );

    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(
      /managed by the omp-impeccable extension in the background/,
    );
    expect(reply).toBeUndefined();
  });

  test('reply and complete tools call OMP skill scripts with the expected args', async () => {
    const replyArgs = path.join(
      os.tmpdir(),
      `omp-impeccable-reply-${process.pid}.json`,
    );
    const completeArgs = path.join(
      os.tmpdir(),
      `omp-impeccable-complete-${process.pid}.json`,
    );
    onTestFinished(() => {
      fs.rmSync(replyArgs, { force: true });
      fs.rmSync(completeArgs, { force: true });
    });
    const { project, skillRoot } = makeProject({
      'live-poll.mjs': `
				import fs from 'node:fs';
				if (process.argv.includes('--reply')) {
					fs.writeFileSync(
						${JSON.stringify(replyArgs)},
						JSON.stringify({ script: process.argv[1], args: process.argv.slice(2) }),
					);
				} else {
					console.log(JSON.stringify({ type: 'exit' }));
				}
			`,
      'live-complete.mjs': `
				import fs from 'node:fs';
				fs.writeFileSync(
					${JSON.stringify(completeArgs)},
					JSON.stringify({ script: process.argv[1], args: process.argv.slice(2) }),
				);
			`,
    });
    const harness = loadExtension();
    const ctx = makeContext(project);

    const reply = await executeTool(
      harness,
      'impeccable_live_reply',
      'reply-call',
      {
        id: 'evt-1',
        status: 'done',
        file: 'src/App.tsx',
        data: { ok: true },
        message: 'Looks good',
      },
      ctx,
    );
    const complete = await executeTool(
      harness,
      'impeccable_live_complete',
      'complete-call',
      {
        id: 'session-1',
        discarded: true,
      },
      ctx,
    );
    await harness.emit('session_shutdown', {}, ctx);

    expect(reply.content[0]?.text).toMatch(/resumed polling/);
    expect(complete.content[0]?.text).toMatch(/resumed polling/);
    const replyInvocation = JSON.parse(fs.readFileSync(replyArgs, 'utf8'));
    const completeInvocation = JSON.parse(
      fs.readFileSync(completeArgs, 'utf8'),
    );
    expect(replyInvocation.script).toBe(
      path.join(skillRoot, 'scripts', 'live-poll.mjs'),
    );
    expect(replyInvocation.args).toEqual([
      '--reply',
      'evt-1',
      'done',
      '--file',
      'src/App.tsx',
      '--data',
      '{"ok":true}',
      'Looks good',
    ]);
    expect(completeInvocation.script).toBe(
      path.join(skillRoot, 'scripts', 'live-complete.mjs'),
    );
    expect(completeInvocation.args).toEqual([
      '--id',
      'session-1',
      '--discarded',
    ]);
  });

  test('summarizeLiveStatus handles empty and non-JSON output', () => {
    expect(summarizeLiveStatus('')).toBe('No Impeccable live status.');
    expect(summarizeLiveStatus('plain text')).toBe('plain text');
  });
});

type Completion = {
  value: string;
  description?: string;
};

type EventHandler = (
  event: unknown,
  ctx: TestContext,
) => unknown | Promise<unknown>;

type Harness = {
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, TestCommand>;
  tools: Map<string, ToolDefinition>;
  messages: SentMessage[];
  emit<T = unknown>(
    name: string,
    event?: unknown,
    ctx?: TestContext,
  ): Promise<T | undefined>;
};

type LiveEvent = {
  type: string;
  id: string;
  prompt: string;
};

type LiveStatus = {
  liveServer: { pid: number };
  activeSessions: Array<{
    phase: string;
    sourceFile?: string;
    pageUrl?: string;
  }>;
};

type PackageJson = {
  omp: { extensions: string[] };
  dependencies: Record<string, string>;
  files: string[];
};

type SlashCommandInfo = ReturnType<ExtensionAPI['getCommands']>[number];

type ProjectFixture = {
  project: string;
  skillRoot: string;
};

type ResourcesDiscoverResult = {
  skillPaths: string[];
};

type SentMessage = {
  message: Parameters<ExtensionAPI['sendMessage']>[0];
  options: Parameters<ExtensionAPI['sendMessage']>[1];
};

type TestCommand = Omit<
  RegisteredCommand,
  'name' | 'sourceInfo' | 'handler' | 'getArgumentCompletions'
> & {
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => Completion[] | null | Promise<Completion[] | null>;
  handler: (args: string, ctx: TestContext) => Promise<void> | void;
};

type TestContext = {
  cwd: string;
  hasUI: boolean;
  ui: TestUI;
  isIdle: () => boolean;
  signal: AbortSignal | undefined;
};

type TestUI = {
  notifications: Array<{
    message: string;
    type?: 'info' | 'warning' | 'error';
  }>;
  statuses: Array<{ key: string; value: string | undefined }>;
  theme: { fg: (color: string, text: string) => string };
  notify: (message: string, type?: 'info' | 'warning' | 'error') => void;
  setStatus: (key: string, value: string | undefined) => void;
};

type ToolCallResult = {
  block?: boolean;
  reason?: string;
};

type ToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

async function argumentCompletions(
  harness: Harness,
  prefix: string,
): Promise<Completion[]> {
  return (
    (await impeccableCommand(harness).getArgumentCompletions?.(prefix)) ?? []
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function executeTool(
  harness: Harness,
  name: string,
  toolCallId: string,
  params: unknown,
  ctx: TestContext,
): Promise<ToolTextResult> {
  const found = harness.tools.get(name);
  if (!found) throw new Error(`${name} tool was not registered`);
  return found.execute(
    toolCallId,
    params,
    undefined,
    undefined,
    ctx as unknown as ExtensionContext,
  ) as Promise<ToolTextResult>;
}

function impeccableCommand(harness: Harness): TestCommand {
  const command = harness.commands.get('impeccable');
  if (!command) throw new Error('impeccable command was not registered');
  return command;
}

function loadExtension(
  extraCommands: SlashCommandInfo[] = [],
  { getCommandsUnavailable = false }: { getCommandsUnavailable?: boolean } = {},
): Harness {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, TestCommand>();
  const tools = new Map<string, ToolDefinition>();
  const messages: SentMessage[] = [];
  const schema = () => ({
    describe() {
      return this;
    },
    optional() {
      return this;
    },
  });
  const z = {
    object: (shape: unknown) => ({ shape }),
    string: schema,
    enum: schema,
    boolean: schema,
    any: schema,
  };
  const api = {
    zod: { z },
    on(name: string, handler: EventHandler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name: string, command: TestCommand) {
      commands.set(name, command);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    sendMessage(
      message: SentMessage['message'],
      options: SentMessage['options'],
    ) {
      messages.push({ message, options });
    },
    getCommands() {
      if (getCommandsUnavailable) throw new Error('getCommands unavailable');
      return [
        ...[...commands.entries()].map(([name, command]) => ({
          name,
          description: command.description,
          source: 'extension' as const,
        })),
        ...extraCommands,
      ];
    },
  };
  impeccableExtension(api as unknown as ExtensionAPI);

  return {
    handlers,
    commands,
    tools,
    messages,
    async emit<T = unknown>(
      name: string,
      event: unknown = {},
      ctx: TestContext = makeContext(root),
    ) {
      let result: unknown;
      for (const handler of handlers.get(name) ?? []) {
        const value = await handler(event, ctx);
        if (value !== undefined) result = value;
      }
      return result as T | undefined;
    },
  };
}

function makeContext(
  cwd: string,
  { idle = true, hasUI = true }: { idle?: boolean; hasUI?: boolean } = {},
): TestContext {
  const notifications: TestUI['notifications'] = [];
  const statuses: TestUI['statuses'] = [];
  const ui: TestUI = {
    notifications,
    statuses,
    theme: { fg: (_color, text) => text },
    notify(message, type) {
      notifications.push({ message, type });
    },
    setStatus(key, value) {
      statuses.push({ key, value });
    },
  };
  return { cwd, hasUI, ui, isIdle: () => idle, signal: undefined };
}

function makeProject(scripts: Record<string, string> = {}): ProjectFixture {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-impeccable-'));
  const skillRoot = path.join(project, '.omp', 'skills', 'impeccable');
  fs.mkdirSync(path.join(project, '.git'));
  fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# fake impeccable\n');
  for (const [name, source] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(skillRoot, 'scripts', name), source);
  }
  onTestFinished(() => fs.rmSync(project, { recursive: true, force: true }));
  return { project, skillRoot };
}

function readPackageJson(): PackageJson {
  return JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  ) as PackageJson;
}

async function runCommand(
  harness: Harness,
  args: string,
  ctx: TestContext,
): Promise<void> {
  await impeccableCommand(harness).handler(args, ctx);
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(message);
}
